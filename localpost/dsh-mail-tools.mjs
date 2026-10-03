import { isAbsolute } from 'node:path';
import { assertId } from './fs-safe.mjs';

/**
 * Native LocalPost mail tools for the installed DSH.
 *
 * The caller is never a tool argument. The runtime hands the calling Agent to every tool body
 * (`tool.execute(args, exec)` - dsh-tools/lib/index.js:3310) and only wraps `agent` in when there is one
 * (`:1305`), so an ordinary MCP client - which forwards nothing but a name and arguments - cannot
 * present a caller at all. Reading, replying and archiving an owned letter must be provable, and a
 * plain MCP call is refused.
 *
 * Every tool requires the calling chat to BE the identity's current bound chat (host, session and
 * workspace, exactly). That is stricter than the mailbox's own owner check on purpose: the mailbox
 * keeps an already-claimed letter with its original owner across a rebind, while listing and status
 * describe the binding, which only the bound chat may ask about.
 *
 * There is deliberately no send tool: this bridge finishes mail, it does not create it.
 */
export const SUPPORTED_VERSION = '0.2.0-rc.2';
export const TOOL_NAMES = Object.freeze([
  'localpost_status', 'localpost_inbox', 'localpost_read', 'localpost_reply', 'localpost_archive',
]);
export const REPLY_OUTCOMES = Object.freeze(['completed', 'failed', 'needs_authorization']);
const SHARED = Object.freeze(['localpost_status', 'localpost_inbox']);
const failure = (code, message) => Object.assign(new Error(message), { code });
const text = value => typeof value === 'string' && value.trim() !== '';
const shown = value => JSON.stringify(value);

/**
 * The chat that is calling, proven by the host rather than claimed by the model.
 * @throws {Error & {code: 'CALLER_UNVERIFIED'}} when nothing proves which chat is calling
 */
export function attestedCaller(ctx, exec, hostId) {
  const agent = exec?.agent;
  if (agent === undefined || agent === null) {
    throw failure('CALLER_UNVERIFIED', 'this call carries no agent, so nothing proves which chat is calling. Use these tools from a chat; a plain MCP client cannot be attested.');
  }
  const session = agent.session;
  const id = session?.id;
  const cwd = session?.header?.cwd;
  if (!text(id) || !text(cwd) || !isAbsolute(cwd)) {
    throw failure('CALLER_UNVERIFIED', 'the calling agent does not expose its session identity and an absolute workspace');
  }
  if (typeof ctx?.agents?.get !== 'function' || ctx.agents.get(id) !== agent) {
    throw failure('CALLER_UNVERIFIED', 'the live agent for this chat is not the caller');
  }
  return Object.freeze({ host: hostId, session: id, cwd });
}

/**
 * The effective definition the host would run for this very agent must still be the one this bridge
 * registered: a scoped registration can shadow a global one, and a shadowed tool must not run at all.
 */
export function assertNotShadowed(registry, agent, name, ours) {
  if (typeof registry?.find !== 'function') return;
  let effective;
  try { effective = registry.find(agent, name); }
  catch (error) { throw failure('SHADOW_CHECK_FAILED', 'the host could not resolve the effective ' + name + ': ' + String(error?.message ?? error)); }
  if (!effective || effective.execute !== ours.execute) {
    throw failure('TOOL_SHADOWED', 'the effective ' + name + ' is not the definition this bridge registered');
  }
}

/** True only when the identity's current binding is exactly this chat, workspace included. */
function requireBoundChat(state, caller, id) {
  const binding = state?.binding;
  if (!binding) throw failure('NOT_BOUND', 'this identity has no binding yet');
  if (binding.state !== 'active') throw failure('BINDING_FROZEN', 'the binding is not active');
  const bound = binding.session;
  if (bound?.host !== caller.host || bound?.id !== caller.session || (bound?.cwd ?? null) !== caller.cwd) {
    throw failure('NOT_BOUND_CHAT', 'this chat is not the identity\'s bound mail chat');
  }
  return binding;
}

const letterLine = letter => shown({
  id: letter?.id ?? letter?.file, from: letter?.from, to: letter?.to, type: letter?.type,
  subject: letter?.subject, outcome: letter?.outcome ?? null,
});

/**
 * Registers the mail tools. All-or-nothing: without every required host capability and the exact
 * supported runtime nothing is registered, a name conflict or an unreadable lookup registers
 * nothing, and a mid-way failure releases what was already registered, in reverse order.
 */
export function createMailTools({ ctx, mailbox, store, identity, hostId = 'local', runtimeVersion } = {}) {
  assertId(identity);
  const canRegister = typeof ctx?.tools?.register === 'function';
  const canLookup = typeof ctx?.agents?.get === 'function';
  const versionOk = runtimeVersion === SUPPORTED_VERSION;
  const reasons = [];
  if (!versionOk) reasons.push('runtime_version_mismatch');
  if (!canRegister) reasons.push('tool_registry_unavailable');
  if (!canLookup) reasons.push('live_agent_lookup_unavailable');
  const capable = versionOk && canRegister && canLookup;
  let registration = null;
  let registered = new Map();

  const withCaller = (name, exec, run) => {
    const ours = registered.get(name);
    const caller = attestedCaller(ctx, exec, hostId);
    if (ours) assertNotShadowed(ctx.tools, exec.agent, name, ours);
    return run(caller);
  };
  const bound = async caller => requireBoundChat(await store.read(identity), caller);

  const definitions = () => [
    {
      name: 'localpost_status',
      description: 'Show this identity\'s LocalPost binding. Only the bound chat may ask.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller('localpost_status', exec, async caller => {
          const state = await store.read(identity);
          const binding = requireBoundChat(state, caller);
          return 'LocalPost: mode=' + binding.mode + ' generation=' + binding.generation
            + ' chat=' + String(binding.session?.id) + ' cwd=' + String(binding.session?.cwd)
            + ' claims=' + Object.keys(state.claims ?? {}).length;
        });
      },
    },
    {
      name: 'localpost_inbox',
      description: 'List the letters waiting in this identity\'s LocalPost inbox. Only the bound chat may ask.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller('localpost_inbox', exec, async caller => {
          await bound(caller);
          const letters = mailbox.inbox(identity);
          return letters.length === 0 ? 'LocalPost: the inbox is empty.' : letters.map(letterLine).join(String.fromCharCode(10));
        });
      },
    },
    {
      name: 'localpost_read',
      description: 'Read one letter, with its text attachments. The mailbox keeps the letter with its owner.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Envelope id from localpost_inbox.' } }, required: ['id'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller('localpost_read', exec, async caller => {
          if (!text(args?.id)) throw failure('INVALID_ARGS', 'localpost_read needs an envelope id');
          const letter = await mailbox.take(identity, args.id, { caller });
          return shown({ id: letter?.envelope?.id ?? args.id, from: letter?.envelope?.from, subject: letter?.envelope?.subject,
            body: letter?.envelope?.body, attachments: letter?.attachments_resolved ?? [] });
        });
      },
    },
    {
      name: 'localpost_reply',
      description: 'Reply to a letter this chat owns. A terminal outcome archives the original.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Envelope id being answered; sent as reply_to.' },
          outcome: { type: 'string', enum: [...REPLY_OUTCOMES], description: 'completed and failed archive the original; needs_authorization leaves it pending.' },
          body: { type: 'string', description: 'Reply text.' },
        },
        required: ['id', 'outcome', 'body'],
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller('localpost_reply', exec, async caller => {
          if (!text(args?.id)) throw failure('INVALID_ARGS', 'localpost_reply needs the id of the letter being answered');
          if (!REPLY_OUTCOMES.includes(args?.outcome)) throw failure('INVALID_ARGS', 'localpost_reply outcome must be one of ' + REPLY_OUTCOMES.join(', '));
          if (!text(args?.body)) throw failure('INVALID_ARGS', 'localpost_reply needs a body');
          // The real contract names the answered letter reply_to; anything else is an unhandled letter.
          const result = await mailbox.reply(identity, { reply_to: args.id, outcome: args.outcome, body: args.body }, { caller });
          return shown({ replied: result?.id ?? null, outcome: result?.outcome ?? args.outcome, archived: result?.archived ?? null, idempotent: result?.idempotent ?? false });
        });
      },
    },
    {
      name: 'localpost_archive',
      description: 'Archive a letter this chat owns after handling it. Retries are idempotent.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Envelope id to archive.' } }, required: ['id'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller('localpost_archive', exec, async caller => {
          if (!text(args?.id)) throw failure('INVALID_ARGS', 'localpost_archive needs an envelope id');
          const result = await mailbox.archive(identity, args.id, { caller });
          return shown({ archived: result?.archived ?? args.id, idempotent: result?.idempotent ?? false });
        });
      },
    },
  ];

  function register() {
    if (!capable) return { ok: false, reason: 'host_capabilities_unmet', reasons: [...reasons], dispose: () => {} };
    if (registration) return { ok: true, existing: true, dispose: registration.dispose };
    const list = definitions();
    if (typeof ctx.tools.find === 'function') {
      for (const definition of list) {
        let existing;
        try { existing = ctx.tools.find(undefined, definition.name); }
        // An unreadable lookup is not "no existing definition": it must stop registration.
        catch (error) { return { ok: false, reason: 'lookup_failed', name: definition.name, message: String(error?.message ?? error), dispose: () => {} }; }
        if (existing !== undefined) return { ok: false, reason: 'tool_name_taken', name: definition.name, dispose: () => {} };
      }
    }
    const disposers = [];
    const release = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } } };
    try {
      for (const definition of list) {
        const dispose = ctx.tools.register(definition);
        disposers.push(typeof dispose === 'function' ? dispose : () => {});
        registered.set(definition.name, definition);
      }
    } catch (error) {
      release();
      registered = new Map();
      return { ok: false, reason: 'registration_failed', message: String(error?.message ?? error), dispose: () => {} };
    }
    const dispose = () => { release(); registered = new Map(); if (registration) registration = null; };
    registration = { names: [...TOOL_NAMES], dispose };
    return { ok: true, names: [...TOOL_NAMES], dispose };
  }

  return {
    register,
    names: [...TOOL_NAMES],
    shared: [...SHARED],
    capabilities: () => ({ runtimeVersion: versionOk, toolRegistry: canRegister, liveAgentLookup: canLookup, reasons: [...reasons] }),
    attestedCaller: exec => attestedCaller(ctx, exec, hostId),
  };
}
