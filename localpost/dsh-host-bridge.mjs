import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { assertId } from './fs-safe.mjs';
import { ANALYSIS_REPLY } from './session-binding.mjs';
import { bindFromChatAction, attestedNow } from './binding-provider.mjs';

/**
 * The caller-attested native host bridge for the installed DSH.
 *
 * Everything the binding provider trusts comes from the host, never from command arguments:
 *   - the chat identity and workspace are read off the Agent the host hands to a handler
 *     (`invocation.agent.session.id` and `invocation.agent.session.header.cwd`; the session header records
 *     cwd and the host requires it to be absolute - see dsh-session/lib/types/index.js:45);
 *   - a bind action exists only because this module minted it while running INSIDE that chat's handler,
 *     so a model cannot fabricate one by passing a path, an id or any other parameter - the commands
 *     take no input at all;
 *   - a minted action is single-use and expires, so a replayed handler call confirms nothing.
 *
 * The capability gate is enforced three times over - on the reported capability, on registration and on
 * confirmation - because a host that cannot attest a chat must not end up with registered commands or
 * an automatic binding written. Without the gate the bridge would look trustworthy while proving nothing.
 */
export const SUPPORTED_VERSION = '0.2.0-rc.2';
export const COMMANDS = Object.freeze({ bind: 'localpost-bind', status: 'localpost-status', unbind: 'localpost-unbind' });
const ACTION_TTL_MS = 120000;

// The only authority a chat bind may carry: the trusted analysis-reply policy, provenance recorded.
const BIND_AUTHORITY = Object.freeze({ scope: ANALYSIS_REPLY, source: 'policy:explicit-chat-command' });
const text = value => typeof value === 'string' && value.trim() !== '';

/**
 * The identity and workspace of the chat a handler ran in, or null when the host does not expose both.
 * The workspace must be an absolute path: a relative or empty one is not a workspace we may bind to.
 */
export function chatSessionOf(invocation) {
  const session = invocation?.agent?.session;
  const id = session?.id;
  const cwd = session?.header?.cwd;
  if (!text(id) || !text(cwd) || !isAbsolute(cwd)) return null;
  return Object.freeze({ id, cwd });
}

/**
 * The caller of a human command, proven by the host: an unattested caller must not even learn which
 * chat is bound (its id and absolute workspace included), let alone change or clear the binding.
 * @returns {{host: string, session: string, cwd: string}|null} null when nothing proves the caller
 */
export function attestedCommandCaller(invocation, agents, hostId) {
  const session = chatSessionOf(invocation);
  if (!session) return null;
  if (typeof agents?.get !== 'function' || agents.get(session.id) !== invocation.agent) return null;
  return Object.freeze({ host: hostId, session: session.id, cwd: session.cwd });
}

export function createDshHostBridge({ ctx, runtimeVersion, store, identity, hostId = 'local', now = Date.now, actionTtlMs = ACTION_TTL_MS } = {}) {
  assertId(identity);
  const commands = ctx?.commands;
  const agents = ctx?.agents;
  const versionOk = runtimeVersion === SUPPORTED_VERSION;
  const canRegister = typeof commands?.register === 'function';
  const canLookup = typeof agents?.get === 'function';
  const chatBinding = versionOk && canRegister && canLookup;
  const reasons = [];
  if (!versionOk) reasons.push('runtime_version_mismatch');
  if (!canRegister) reasons.push('command_registry_unavailable');
  if (!canLookup) reasons.push('live_agent_lookup_unavailable');
  const capabilities = Object.freeze({ runtimeVersion: versionOk, commandRegistry: canRegister, liveAgentLookup: canLookup, chatBinding });
  const actions = new Map();
  let registration = null;
  const registered = new Map();

  /** The active binding, only when it names exactly this caller; otherwise null. */
  const boundTo = (state, caller) => {
    const binding = state?.binding;
    const bound = binding?.session;
    const exact = caller && binding?.state === 'active' && bound?.host === caller.host &&
      bound?.id === caller.session && (bound?.cwd ?? null) === caller.cwd;
    return exact ? binding : null;
  };

  const bridge = {
    capabilities,
    diagnostics: () => ({
      supportedVersion: SUPPORTED_VERSION, runtimeVersion, chatBinding, reasons: [...reasons],
      // Whether the host lets us see an existing definition before registering; recorded, never assumed.
      collisionPreflight: typeof commands?.find === 'function',
    }),

    /** Confirms one action this bridge minted inside a chat handler; gated, single use, bounded, exact. */
    async confirmBindAction(action) {
      if (!chatBinding) return { confirmed: false, reason: 'host_untrusted' };
      const recorded = actions.get(action?.actionId);
      if (!recorded) return { confirmed: false, reason: 'unknown_action' };
      actions.delete(action.actionId);
      if (Number(now()) - recorded.at > actionTtlMs) return { confirmed: false, reason: 'action_expired' };
      const exact = [action?.actionId, action?.hostId, action?.threadId, action?.cwd].every(text) &&
        recorded.hostId === action.hostId && recorded.threadId === action.threadId && recorded.cwd === action.cwd;
      if (!exact) return { confirmed: false, reason: 'action_mismatch' };
      return { confirmed: true, actionId: action.actionId, hostId: recorded.hostId, threadId: recorded.threadId, cwd: recorded.cwd };
    },

    /** What the host sees for one chat right now; the live agent must still be the very session we ask about. */
    async describeThread(threadId) {
      if (!text(threadId) || !canLookup) return { hostId, threadId: text(threadId) ? threadId : null, cwd: null, online: false };
      const agent = agents.get(threadId);
      if (!agent) return { hostId, threadId, cwd: null, online: false };
      if (agent?.session?.id !== threadId) return { hostId, threadId, cwd: null, online: false };
      const cwd = agent?.session?.header?.cwd;
      if (!text(cwd) || !isAbsolute(cwd)) return { hostId, threadId, cwd: null, online: false };
      return { hostId, threadId, cwd, online: true };
    },
  };

  /**
   * Registers the three human commands. Every one takes no input, so nothing about a binding is
   * model-controllable. Registration is all-or-nothing: a conflict or a mid-way failure releases
   * whatever was registered, in reverse order, and leaves the host with none of our commands.
   */
  function registerCommands() {
    if (!chatBinding) {
      return { ok: false, reason: 'host_cannot_attest', reasons: [...reasons], dispose: () => {} };
    }
    if (registration) return { ok: true, existing: true, dispose: registration.dispose };
    const names = [COMMANDS.bind, COMMANDS.status, COMMANDS.unbind];
    if (typeof commands.find === 'function') {
      for (const name of names) {
        let existing;
        // An unreadable lookup is not "no existing definition": it must stop registration.
        try { existing = commands.find(undefined, name); }
        catch (error) { return { ok: false, reason: 'lookup_failed', name, message: String(error?.message ?? error), dispose: () => {} }; }
        if (existing !== undefined) return { ok: false, reason: 'command_name_taken', name, dispose: () => {} };
      }
    }
    const disposers = [];
    // A scoped registration can shadow a global one, so the command that actually runs for THIS agent must
    // still be the handler this bridge registered; anything else refuses instead of acting.
    const guard = (name, invocation) => {
      const ours = registered.get(name);
      if (!ours || typeof commands.find !== 'function') return null;
      let effective;
      try { effective = commands.find(invocation?.agent, name); }
      catch (error) { return { kind: 'error', text: 'LocalPost: the host could not resolve /' + name + ' (' + String(error?.message ?? error) + ').' }; }
      if (!effective || effective.handler !== ours.handler) return { kind: 'error', text: 'LocalPost: /' + name + ' is shadowed by another definition, so nothing was done.' };
      return null;
    };
    const define = (name, description, handler) => {
      const dispose = commands.register({ name, description, recordInput: false, handler });
      disposers.push(typeof dispose === 'function' ? dispose : () => {});
      registered.set(name, { handler });
    };
    const release = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } } };
    try {
      define(COMMANDS.bind, 'Bind this chat as the LocalPost mail chat (no arguments).', async invocation => {
        const shadowed = guard(COMMANDS.bind, invocation);
        if (shadowed) return shadowed;
        const caller = attestedCommandCaller(invocation, agents, hostId);
        if (!caller) return { kind: 'error', text: 'LocalPost: the host did not prove this chat' + String.fromCharCode(39) + 's identity and absolute workspace, so no binding was created.' };
        const actionId = randomUUID();
        const action = { actionId, hostId, threadId: caller.session, cwd: caller.cwd };
        actions.set(actionId, { ...action, at: Number(now()) });
        const result = await bindFromChatAction(store, identity, { host: bridge, action, authority: BIND_AUTHORITY });
        if (result?.ok) {
          return { kind: 'success', text: result.existing
            ? 'LocalPost: this chat was already the mail chat; nothing changed.'
            : 'LocalPost: this chat is now the mail chat. New mail that arrives is routed here until you unbind or it rotates.' };
        }
        actions.delete(actionId);
        const reason = String(result?.reason ?? 'unknown');
        if (reason === 'already_bound') {
          // The store refuses any change once bound. Repeating the bind in the SAME chat is a no-op success:
          // it must not touch generation, source or attestation. A different chat is not a rebind at all.
          const current = await store.read(identity);
          const bound = current?.binding?.session;
          const same = bound?.host === action.hostId && bound?.id === action.threadId && bound?.cwd === action.cwd;
          return same
            ? { kind: 'success', text: 'LocalPost: this chat was already the mail chat; nothing changed.' }
            : { kind: 'error', text: 'LocalPost: this identity is bound to another chat. T1 cannot move a binding between chats (that needs its own protocol).' };
        }
        return { kind: 'error', text: 'LocalPost: binding refused (' + reason + '). Nothing changed.' };
      });

      define(COMMANDS.status, 'Show the current LocalPost mail binding for this host (no arguments).', async invocation => {
        const shadowed = guard(COMMANDS.status, invocation);
        if (shadowed) return shadowed;
        const caller = attestedCommandCaller(invocation, agents, hostId);
        const state = await store.read(identity);
        if (!caller) return { kind: 'error', text: 'LocalPost: the host did not prove which chat is calling, so the binding is not disclosed.' };
        if (!state) return { kind: 'error', text: 'LocalPost: this identity has no binding state yet.' };
        const binding = boundTo(state, caller);
        if (!binding) return { kind: 'error', text: 'LocalPost: only the bound mail chat may read the binding.' };
        return { kind: 'success', text: 'LocalPost: mode=' + binding.mode + ' generation=' + binding.generation +
          ' chat=' + String(binding.session?.id ?? '?') + ' cwd=' + String(binding.session?.cwd ?? '?') +
          ' attested=' + String(attestedNow(state)) };
      });

      define(COMMANDS.unbind, 'Stop routing NEW mail automatically for this identity (no arguments).', async invocation => {
        const shadowed = guard(COMMANDS.unbind, invocation);
        if (shadowed) return shadowed;
        const caller = attestedCommandCaller(invocation, agents, hostId);
        const state = await store.read(identity);
        if (!caller) return { kind: 'error', text: 'LocalPost: the host did not prove which chat is calling.' };
        if (!state) return { kind: 'error', text: 'LocalPost: this identity has no binding to unbind.' };
        if (!boundTo(state, caller)) {
          return { kind: 'error', text: 'LocalPost: only the currently bound chat may unbind. Run this in that chat.' };
        }
        await store.update(identity, current => { current.binding.mode = 'manual'; });
        // Confirm against what was actually persisted, not against the draft the mutator saw.
        const after = await store.read(identity);
        if (after?.binding?.mode !== 'manual') return { kind: 'error', text: 'LocalPost: could not confirm the unbind; automatic routing may still be on.' };
        return { kind: 'success', text: 'LocalPost: automatic routing is off for NEW mail. Mail already accepted keeps its original owner and must be reconciled there; it is not moved to another chat.' };
      });
    } catch (error) {
      release();
      return { ok: false, reason: 'registration_failed', message: String(error?.message ?? error), dispose: () => {} };
    }
    const dispose = () => { release(); if (registration) registration = null; };
    registration = { names, dispose };
    return { ok: true, names, dispose };
  }

  return { ...bridge, registerCommands };
}
