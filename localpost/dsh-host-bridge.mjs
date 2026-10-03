import { randomUUID } from 'node:crypto';
import { assertId } from './fs-safe.mjs';
import { ANALYSIS_REPLY } from './session-binding.mjs';

// The only authority a chat bind may carry: the trusted analysis-reply policy, provenance recorded.
const BIND_AUTHORITY = Object.freeze({ scope: ANALYSIS_REPLY, source: 'policy:explicit-chat-command' });
import { bindFromChatAction, attestedNow } from './binding-provider.mjs';

/**
 * The caller-attested native host bridge for the installed DSH.
 *
 * Everything the binding provider trusts comes from the host, never from command arguments:
 *   - the chat identity and workspace are read off the Agent the host hands to a command handler
 *     (`invocation.agent.session.id` / `.cwd`; the session header records cwd and validates it is absolute);
 *   - a bind action exists only because this module minted it while running INSIDE that chat's handler,
 *     so a model cannot fabricate one by passing a path, an id or any other parameter - the commands
 *     take no input at all;
 *   - a minted action is single-use and expires, so a replayed handler call confirms nothing.
 *
 * The bridge refuses to look trustworthy when the host cannot supply the pieces: without a command
 * registry and a live agent lookup, `capabilities.chatBinding` is false and the provider reports
 * itself untrusted, which keeps automatic dispatch disabled (fail closed).
 */
export const SUPPORTED_VERSION = '0.2.0-rc.2';
export const COMMANDS = Object.freeze({ bind: 'localpost-bind', status: 'localpost-status', unbind: 'localpost-unbind' });
const ACTION_TTL_MS = 120000;
const text = value => typeof value === 'string' && value.trim() !== '';

/** The identity and workspace of the chat a command ran in, or null when the host does not expose both. */
export function chatSessionOf(invocation) {
  const session = invocation?.agent?.session;
  const id = session?.id;
  const cwd = session?.cwd;
  if (!text(id) || !text(cwd)) return null;
  return Object.freeze({ id, cwd });
}

export function createDshHostBridge({ ctx, runtimeVersion, store, identity, hostId = 'local', now = Date.now, actionTtlMs = ACTION_TTL_MS } = {}) {
  assertId(identity);
  const commands = ctx?.commands;
  const agents = ctx?.agents;
  const versionOk = runtimeVersion === SUPPORTED_VERSION;
  const canRegister = typeof commands?.register === 'function';
  const canLookup = typeof agents?.get === 'function';
  const capabilities = Object.freeze({
    runtimeVersion: versionOk,
    commandRegistry: canRegister,
    liveAgentLookup: canLookup,
    chatBinding: versionOk && canRegister && canLookup,
  });
  const actions = new Map();
  const disposers = [];

  const bridge = {
    capabilities,
    diagnostics: () => ({
      supportedVersion: SUPPORTED_VERSION,
      runtimeVersion,
      chatBinding: capabilities.chatBinding,
      reasons: Object.entries(capabilities).filter(([name, value]) => name !== 'runtimeVersion' && value !== true).map(([name]) => name),
    }),

    /** Confirms one action this bridge minted inside a chat handler; single use, bounded by TTL, exact values. */
    async confirmBindAction(action) {
      const recorded = actions.get(action?.actionId);
      if (!recorded) return { confirmed: false, reason: 'unknown_action' };
      actions.delete(action.actionId);
      if (Number(now()) - recorded.at > actionTtlMs) return { confirmed: false, reason: 'action_expired' };
      const exact = [action?.actionId, action?.hostId, action?.threadId, action?.cwd].every(text) &&
        recorded.hostId === action.hostId && recorded.threadId === action.threadId && recorded.cwd === action.cwd;
      if (!exact) return { confirmed: false, reason: 'action_mismatch' };
      return { confirmed: true, actionId: action.actionId, hostId: recorded.hostId, threadId: recorded.threadId, cwd: recorded.cwd };
    },

    /** What the host sees for one chat right now: online only when the live agent still reports the same workspace. */
    async describeThread(threadId) {
      if (!text(threadId) || !canLookup) return { hostId, threadId: text(threadId) ? threadId : null, cwd: null, online: false };
      const agent = agents.get(threadId);
      if (!agent) return { hostId, threadId, cwd: null, online: false };
      const cwd = agent?.session?.cwd;
      if (!text(cwd)) return { hostId, threadId, cwd: null, online: false };
      return { hostId, threadId, cwd, online: true };
    },
  };

  /** Registers the three human commands; every one of them takes no input, so nothing is model-controllable. */
  function registerCommands() {
    if (!canRegister) throw Object.assign(new Error('The host has no command registry; the LocalPost bridge cannot register its commands'), { code: 'command_registry_unavailable' });
    const define = (name, description, handler) => {
      const dispose = commands.register({ name, description, recordInput: false, handler });
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    };

    define(COMMANDS.bind, 'Bind this chat as the LocalPost mail chat (no arguments).', async invocation => {
      const session = chatSessionOf(invocation);
      if (!session) return { kind: 'error', text: 'LocalPost: the host did not expose this chat\'s identity and workspace, so no binding was created.' };
      const actionId = randomUUID();
      const action = { actionId, hostId, threadId: session.id, cwd: session.cwd };
      actions.set(actionId, { ...action, at: Number(now()) });
      const result = await bindFromChatAction(store, identity, { host: bridge, action, authority: BIND_AUTHORITY });
      if (!result?.ok) {
        actions.delete(actionId);
        return { kind: 'error', text: 'LocalPost: binding refused (' + String(result?.reason ?? 'unknown') + '). Nothing changed.' };
      }
      return { kind: 'success', text: 'LocalPost: this chat is now the mail chat. Later mail that arrives is routed here until you unbind or it rotates.' };
    });

    define(COMMANDS.status, 'Show the current LocalPost mail binding for this host (no arguments).', async () => {
      const state = await store.read(identity);
      if (!state) return { kind: 'error', text: 'LocalPost: this identity has no binding state yet.' };
      const { binding } = state;
      const attested = attestedNow(state);
      return { kind: 'success', text: 'LocalPost: mode=' + binding.mode + ' generation=' + binding.generation +
        ' chat=' + String(binding.session?.id ?? '?') + ' cwd=' + String(binding.session?.cwd ?? '?') +
        ' attested=' + String(attested) };
    });

    define(COMMANDS.unbind, 'Stop automatic routing for this identity (no arguments). Manual reading keeps working.', async () => {
      const state = await store.update(identity, current => { current.binding.mode = 'manual'; });
      const mode = state?.binding?.mode ?? 'manual';
      return mode === 'manual'
        ? { kind: 'success', text: 'LocalPost: automatic routing is off for this identity. Mail stays for manual reading.' }
        : { kind: 'error', text: 'LocalPost: could not confirm the unbind; automatic routing may still be on.' };
    });

    return () => { for (const dispose of disposers.splice(0)) dispose(); };
  }

  return { ...bridge, registerCommands };
}
