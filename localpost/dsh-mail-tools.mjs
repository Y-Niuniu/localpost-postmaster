import { isAbsolute } from 'node:path';
import { assertId } from './fs-safe.mjs';

/**
 * Native LocalPost mail tools for the installed DSH.
 *
 * The caller is never a tool argument. The runtime hands the calling Agent to every tool body
 * (`tool.execute(args, exec)` - dsh-tools/lib/index.js:3310) and only wraps `agent` in when there is one
 * (`:1305`), so an ordinary MCP client - which forwards nothing but a name and arguments - cannot
 * present a caller at all. That is the whole point: reading, replying and archiving a letter that is
 * owned in the claim ledger must be provable, and a plain MCP call is refused.
 *
 * There is deliberately no send tool: this bridge exists to finish mail, not to create it.
 */
export const TOOL_NAMES = Object.freeze([
  'localpost_status', 'localpost_inbox', 'localpost_read', 'localpost_reply', 'localpost_archive',
]);
const failure = (code, message) => Object.assign(new Error(message), { code });
const text = value => typeof value === 'string' && value.trim() !== '';
const shown = value => JSON.stringify(value);

/**
 * The chat that is calling, proven by the host rather than claimed by the model.
 * @returns {{host: string, session: string, cwd: string}} frozen caller facts
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
  // The live registry must return the very object we were handed: a replaced or revived agent is not the caller.
  if (typeof ctx?.agents?.get !== 'function' || ctx.agents.get(id) !== agent) {
    throw failure('CALLER_UNVERIFIED', 'the live agent for this chat is not the caller');
  }
  return Object.freeze({ host: hostId, session: id, cwd });
}

const letterLine = letter => shown({
  id: letter?.id ?? letter?.file, from: letter?.from, to: letter?.to, type: letter?.type,
  subject: letter?.subject, outcome: letter?.outcome ?? null,
});

/**
 * Registers the mail tools on the plugin's tool registry.
 * All-or-nothing like the command registry: a conflict or a mid-way failure releases what was
 * registered, in reverse order, and leaves the host with none of our tools.
 */
export function createMailTools({ ctx, mailbox, store, identity, hostId = 'local' } = {}) {
  assertId(identity);
  const canRegister = typeof ctx?.tools?.register === 'function';
  const canLookup = typeof ctx?.agents?.get === 'function';
  const reasons = [];
  if (!canRegister) reasons.push('tool_registry_unavailable');
  if (!canLookup) reasons.push('live_agent_lookup_unavailable');
  let registration = null;

  const state = async () => store.read(identity);
  const withCaller = async (exec, run) => run(attestedCaller(ctx, exec, hostId));

  const definitions = () => [
    {
      name: 'localpost_status',
      description: 'Show this identity\'s LocalPost binding: mode, generation, bound chat and whether a human or the automatic consumer owns new mail.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller(exec, async () => {
          const current = await state();
          if (!current) return 'LocalPost: no binding state for this identity yet.';
          const { binding } = current;
          return 'LocalPost: mode=' + binding.mode + ' generation=' + binding.generation
            + ' chat=' + String(binding.session?.id ?? '?') + ' cwd=' + String(binding.session?.cwd ?? '?')
            + ' claims=' + Object.keys(current.claims ?? {}).length;
        });
      },
    },
    {
      name: 'localpost_inbox',
      description: 'List the letters waiting in this identity\'s LocalPost inbox. Reading a letter is a separate call that claims it.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller(exec, async () => {
          const letters = mailbox.inbox(identity);
          return letters.length === 0 ? 'LocalPost: the inbox is empty.' : letters.map(letterLine).join(String.fromCharCode(10));
        });
      },
    },
    {
      name: 'localpost_read',
      description: 'Read one letter from this identity\'s inbox, with its text attachments. This claims the letter for the calling chat.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Envelope id from localpost_inbox.' } }, required: ['id'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller(exec, async caller => {
          // The caller is proven before anything else: an unattested call must not even reach argument handling.
          if (!text(args?.id)) throw failure('INVALID_ARGS', 'localpost_read needs an envelope id');
          const letter = await mailbox.take(identity, args.id, { caller });
          return shown({ id: letter?.envelope?.id ?? args.id, from: letter?.envelope?.from, subject: letter?.envelope?.subject,
            body: letter?.envelope?.body, attachments: letter?.attachments_resolved ?? [] });
        });
      },
    },
    {
      name: 'localpost_reply',
      description: 'Reply to a letter this chat owns. A terminal outcome archives the original; a non-terminal one leaves it pending.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Envelope id being answered.' },
          outcome: { type: 'string', description: 'completed, failed, or a non-terminal status such as needs_authorization.' },
          body: { type: 'string', description: 'Reply text.' },
          subject: { type: 'string', description: 'Optional reply subject.' },
        },
        required: ['id', 'outcome', 'body'],
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        return withCaller(exec, async caller => {
          if (!text(args?.id) || !text(args?.outcome) || !text(args?.body)) throw failure('INVALID_ARGS', 'localpost_reply needs id, outcome and body');
          const result = await mailbox.reply(identity, { id: args.id, outcome: args.outcome, body: args.body, ...(text(args.subject) ? { subject: args.subject } : {}) }, { caller });
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
        return withCaller(exec, async caller => {
          if (!text(args?.id)) throw failure('INVALID_ARGS', 'localpost_archive needs an envelope id');
          const result = await mailbox.archive(identity, args.id, { caller });
          return shown({ archived: result?.archived ?? args.id, idempotent: result?.idempotent ?? false });
        });
      },
    },
  ];

  function register() {
    if (!canRegister) return { ok: false, reason: 'tool_registry_unavailable', reasons: [...reasons], dispose: () => {} };
    if (registration) return { ok: true, existing: true, dispose: registration.dispose };
    const names = [...TOOL_NAMES];
    for (const definition of definitions()) {
      if (ctx.tools.find !== undefined && typeof ctx.tools.find === 'function') {
        let existing;
        try { existing = ctx.tools.find(undefined, definition.name); } catch { existing = undefined; }
        if (existing !== undefined) return { ok: false, reason: 'tool_name_taken', name: definition.name, dispose: () => {} };
      }
    }
    const disposers = [];
    const release = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } } };
    try {
      for (const definition of definitions()) {
        const dispose = ctx.tools.register(definition);
        disposers.push(typeof dispose === 'function' ? dispose : () => {});
      }
    } catch (error) {
      release();
      return { ok: false, reason: 'registration_failed', message: String(error?.message ?? error), dispose: () => {} };
    }
    const dispose = () => { release(); if (registration) registration = null; };
    registration = { names, dispose };
    return { ok: true, names, dispose };
  }

  return { register, attestedCaller: (exec) => attestedCaller(ctx, exec, hostId), names: [...TOOL_NAMES] };
}
