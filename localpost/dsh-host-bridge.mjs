import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { assertId } from './fs-safe.mjs';
import { ANALYSIS_REPLY, bindingIdentity } from './session-binding.mjs';
import { bindFromChatAction, takeOverFromChatAction, attestedNow } from './binding-provider.mjs';
import { switchMode, UNFINISHED } from './letter-claims.mjs';

/**
 * The caller-attested native host bridge for the installed DSH.
 *
 * Everything the binding provider trusts comes from the host, never from arguments:
 *   - the chat identity and workspace are read off the Agent the host hands to a command handler or a tool body
 *     (`agent.session.id` and `agent.session.header.cwd`; the session header records cwd and the host requires it to
 *     be absolute - see dsh-session/lib/types/index.js:45);
 *   - a bind action exists only because this module minted it while running INSIDE that chat's command or tool call,
 *     so nothing can name another chat: a chat can only ever make ITSELF the mail chat;
 *   - a minted action is single-use and expires, so a replayed call confirms nothing.
 *
 * What a chat can do (2026-10-09, user decision: switching the mail chat must work in plain language, and the human
 * commands are cut down to three):
 *   bindHere  make this chat the mail chat - bind it, turn automatic routing back on in it, or move the mail here from
 *             another chat (letter-claims.mjs takeOverIn); the human /localpost-bind and the model's localpost_bind_here
 *   stopAuto  stop routing NEW mail automatically (the binding stays); /localpost-unbind and localpost_unbind
 *   describe  who receives the mail now; /localpost-status and localpost_status
 * A switch waits for an in-flight dispatch instead of asking the human to try again.
 *
 * The capability gate is enforced on the reported capability, on registration and on confirmation, because a host that
 * cannot attest a chat must not end up with registered commands or a binding written.
 */
export const SUPPORTED_VERSION = '0.2.0-rc.2';
// The human commands, registered once per host: each acts on the identity the calling chat speaks for.
export const COMMANDS = Object.freeze({ bind: 'localpost-bind', status: 'localpost-status', unbind: 'localpost-unbind' });
const ACTION_TTL_MS = 120000;
// The actor lease is held for one dispatch at a time (well under a second), so a switch retries for a few seconds.
const BUSY_RETRIES = 20;
const BUSY_PAUSE_MS = 250;

// The only authority a chat bind may carry: the trusted analysis-reply policy, with how it was asked for.
export const BIND_AUTHORITY = Object.freeze({
  command: Object.freeze({ scope: ANALYSIS_REPLY, source: 'policy:explicit-chat-command' }),
  request: Object.freeze({ scope: ANALYSIS_REPLY, source: 'policy:user-request-in-chat' }),
});
const text = value => typeof value === 'string' && value.trim() !== '';
const sameChat = (session, caller) => session?.host === caller?.host && session?.id === caller?.session && (session?.cwd ?? null) === caller?.cwd;
const AGAIN = Symbol('again');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
 * chat is bound (its id and absolute workspace included), let alone change the binding.
 * @returns {{host: string, session: string, cwd: string}|null} null when nothing proves the caller
 */
export function attestedCommandCaller(invocation, agents, hostId) {
  const session = chatSessionOf(invocation);
  if (!session) return null;
  if (typeof agents?.get !== 'function' || agents.get(session.id) !== invocation.agent) return null;
  return Object.freeze({ host: hostId, session: session.id, cwd: session.cwd });
}

/* ------------------------------------------------------------------ what the human (and the model) is told */

const list = letters => letters.join('、');

/** A bridge's description, or what keeps it from being read: one unreadable record must not hide the other identities. */
export async function describeOrExplain(bridge) {
  try { return await bridge.describe(); }
  catch (error) { return { identity: bridge.identity, unreadable: String(error?.message ?? error) }; }
}

/** One line per identity: which chat receives its mail and whether automatic routing is on. */
export function statusText(descriptions, caller, names = COMMANDS) {
  const lines = ['LocalPost 收信状态：'];
  for (const entry of descriptions) {
    if (entry?.unreadable) { lines.push('· ' + entry.identity + '：绑定记录读不出（' + entry.unreadable + '），需要人工核对。'); continue; }
    if (!entry?.bound) { lines.push('· ' + entry?.identity + '：还没有收信聊天。'); continue; }
    const where = sameChat(entry.session, caller) ? '这个聊天（' + entry.session.id + '）' : '另一个聊天（' + entry.session.id + '，目录 ' + entry.session.cwd + '）';
    let line = '· ' + entry.identity + '：收信聊天 = ' + where + '；自动收信：'
      + (entry.mode === 'auto' ? '开，新信会自动送到那里' : '关，新信留在收件箱，可以手动处理')
      + (entry.state === 'active' ? '' : '（正在切换中）') + '。';
    if (entry.unfinished?.length > 0) line += '还有 ' + entry.unfinished.length + ' 封没处理完：' + list(entry.unfinished) + '。';
    if (entry.mode === 'auto' && entry.receiver && entry.receiver.running !== true) {
      line += entry.receiver.lastStartError ? 'receiver 启动失败：' + entry.receiver.lastStartError + '。' : 'receiver 还没启动（绑定后约 15 秒内自启）。';
    }
    lines.push(line);
  }
  lines.push('要换收信聊天：在想收信的聊天里说「把收信切到这个聊天」或敲 /' + names.bind + '；要停：说「停止自动收信」或敲 /' + names.unbind + '。');
  return lines.join('\n');
}

const BUSY = identity => 'LocalPost：' + identity + ' 正在派信，等了几秒还没空出来，没有改动。过一会儿再说一次就行。';
const UNATTESTED = new Set(['host_cannot_attest', 'caller_unverified', 'attestation_mismatch', 'attestation_unavailable']);

/** What a bindHere result means for the person who asked. */
export function bindText(identity, result, names = COMMANDS) {
  if (result?.ok) {
    switch (result.outcome) {
      case 'already': return 'LocalPost：这个聊天本来就是 ' + identity + ' 的收信聊天，自动收信开着，没有改动。';
      case 'rearmed': return 'LocalPost：已恢复 ' + identity + ' 的自动收信，新信会自动送到这个聊天。';
      case 'taken_over': return 'LocalPost：已把 ' + identity + ' 的收信从聊天 ' + result.previous?.id + ' 切到这个聊天，新信会自动送到这里；'
        + '之前没送到老聊天的信也会改送到这里。'
        + (result.moved?.length > 0 ? '老聊天没处理完的 ' + result.moved.length + ' 封信已转给这个聊天，可以直接读、回：' + list(result.moved) + '。' : '');
      default: return 'LocalPost：这个聊天现在是 ' + identity + ' 的收信聊天，新信会自动送到这里。';
    }
  }
  const reason = String(result?.reason ?? 'unknown');
  if (reason === 'unfinished_letters') {
    return 'LocalPost：没有切换。原来的收信聊天 ' + (result.session?.id ?? '?') + ' 还有 ' + result.letters.length + ' 封信没处理完：'
      + list(result.letters) + '。最好先在那个聊天处理完；如果那个聊天已经关了或不用了，可以在这里说「强制切换收信」，这些信会转给这个聊天。';
  }
  if (reason === 'chat_speaks_for_other_identity') {
    return 'LocalPost：这个聊天已经是 ' + String(result.identity ?? '另一个身份') + ' 的收信聊天；一个聊天只代表一个身份，所以没有把它设成 '
      + identity + ' 的。没有改动。';
  }
  if (reason === 'busy') return BUSY(identity);
  if (UNATTESTED.has(reason)) return 'LocalPost：宿主没能证明是哪个聊天在调用（' + reason + '），没有改动。';
  if (reason === 'unconfirmed') return 'LocalPost：写完后核对不上，绑定可能刚被别处改了。请用 /' + names.status + ' 看一下现状。';
  return 'LocalPost：没有切换（' + reason + (result?.message ? '：' + String(result.message) : '') + '），没有改动。';
}

/** What a stopAuto result means for the person who asked. */
export function unbindText(identity, result, names = COMMANDS) {
  if (result?.ok) {
    if (result.outcome === 'unbound') return 'LocalPost：' + identity + ' 还没有收信聊天，没有可停的。';
    if (result.outcome === 'already') return 'LocalPost：' + identity + ' 的自动收信本来就是关的，没有改动。';
    return 'LocalPost：已停止 ' + identity + ' 的自动收信（收信聊天原来是 ' + result.session?.id + '）。新信会留在收件箱，可以手动处理；'
      + '要恢复，在想收信的聊天里说「把收信切到这个聊天」或敲 /' + names.bind + '。';
  }
  const reason = String(result?.reason ?? 'unknown');
  if (reason === 'busy') return BUSY(identity);
  if (UNATTESTED.has(reason)) return 'LocalPost：宿主没能证明是哪个聊天在调用（' + reason + '），没有改动。';
  return 'LocalPost：没有停掉（' + reason + '），没有改动。';
}

/* ------------------------------------------------------------------ the bridge of one identity */

/**
 * `names` are the command names its texts point at. `admitBind(caller, proceed)` decides, before anything is written,
 * whether this attested chat may become this identity's mail chat (dsh-wiring.mjs: a chat speaks for one identity); it
 * either calls `proceed()` and returns its result or returns a refusal `{ ok: false, reason }`. By default every attested
 * chat is admitted, which is the single-identity behaviour. `onChange(identity)` runs after the mail chat was bound,
 * re-armed or moved (the wiring starts the receiver at once instead of at its next poll).
 */
export function createDshHostBridge({ ctx, runtimeVersion, store, identity, hostId = 'local', now = Date.now, actionTtlMs = ACTION_TTL_MS,
  names: commandNames = COMMANDS, admitBind = (_caller, proceed) => proceed(), onChange = () => {},
  busyRetries = BUSY_RETRIES, busyPauseMs = BUSY_PAUSE_MS } = {}) {
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

  const validCaller = caller => caller?.host === hostId && text(caller?.session) && text(caller?.cwd) && isAbsolute(caller.cwd);
  /** A single-use action for this very call, confirmed (and consumed) by confirmBindAction. */
  const mint = caller => {
    const action = { actionId: randomUUID(), hostId, threadId: caller.session, cwd: caller.cwd };
    actions.set(action.actionId, { ...action, at: Number(now()) });
    return action;
  };
  /** Runs `attempt` until it stops answering AGAIN - a dispatch in flight or a binding that moved under it - for a few seconds. */
  const untilFree = async attempt => {
    for (let round = 0; round < busyRetries; round += 1) {
      const result = await attempt();
      if (result !== AGAIN) return result;
      await pause(busyPauseMs);
    }
    return { ok: false, reason: 'busy' };
  };

  const bridge = {
    identity,
    capabilities,
    diagnostics: () => ({
      supportedVersion: SUPPORTED_VERSION, runtimeVersion, chatBinding, reasons: [...reasons],
      // Whether the host lets us see an existing definition before registering; recorded, never assumed.
      collisionPreflight: typeof commands?.find === 'function',
    }),

    /** Confirms one action this bridge minted inside a chat's call; gated, single use, bounded, exact. */
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

    /**
     * Makes the attested calling chat this identity's mail chat: binds it, turns automatic routing back on in it, or moves
     * the mail here from another chat. `force` also moves letters the old chat has not finished; `via` records whether a
     * human command ('command') or the model on the user's request ('request') asked.
     * @returns {Promise<{ok: true, outcome: 'bound'|'already'|'rearmed'|'taken_over', previous?: object, moved?: string[]}|{ok: false, reason: string}>}
     */
    async bindHere(caller, { force = false, via = 'command' } = {}) {
      if (!chatBinding) return { ok: false, reason: 'host_cannot_attest' };
      if (!validCaller(caller)) return { ok: false, reason: 'caller_unverified' };
      const authority = via === 'request' ? BIND_AUTHORITY.request : BIND_AUTHORITY.command;
      const result = await admitBind(caller, () => untilFree(async () => {
        const state = await store.read(identity);
        if (!state) {
          const bound = await bindFromChatAction(store, identity, { host: bridge, action: mint(caller), authority });
          if (bound?.ok) return { ok: true, outcome: bound.existing ? 'already' : 'bound' };
          return bound?.reason === 'already_bound' ? AGAIN : bound;       // another bind landed first: look again
        }
        const { binding } = state;
        if (sameChat(binding.session, caller)) {
          if (binding.mode === 'auto' && binding.state === 'active') return { ok: true, outcome: 'already' };
          const switched = await switchMode(store, identity, 'auto', { expectedBinding: bindingIdentity(binding) });
          if (switched?.skipped || switched?.reason === 'binding_conflict') return AGAIN;
          return switched?.ok ? { ok: true, outcome: 'rearmed' } : { ok: false, reason: String(switched?.reason ?? 'unknown') };
        }
        const moved = await takeOverFromChatAction(store, identity, { host: bridge, action: mint(caller), authority,
          expectedBinding: bindingIdentity(binding), force: force === true });
        if (moved?.skipped || moved?.reason === 'binding_conflict' || moved?.reason === 'unbound') return AGAIN;
        if (moved?.reason === 'unfinished_letters') return { ...moved, session: { ...binding.session } };
        if (!moved?.ok) return moved;
        return { ok: true, outcome: 'taken_over', previous: { ...binding.session }, moved: moved.moved ?? [] };
      }));
      if (!result?.ok) return result;
      // Confirm against what was actually persisted: this chat, automatic, active.
      const after = await store.read(identity);
      if (!sameChat(after?.binding?.session, caller) || after.binding.mode !== 'auto' || after.binding.state !== 'active') return { ok: false, reason: 'unconfirmed' };
      try { onChange(identity); } catch { /* a notification must not turn a done switch into a failure */ }
      return result;
    },

    /**
     * Stops routing NEW mail automatically (manual mode). The binding stays where it is, so bindHere in that chat turns it
     * back on and bindHere elsewhere moves it. Any attested chat may ask: it only ever leaves letters in the inbox.
     * @returns {Promise<{ok: true, outcome: 'paused'|'already'|'unbound', session?: object}|{ok: false, reason: string}>}
     */
    async stopAuto(caller) {
      if (!validCaller(caller)) return { ok: false, reason: 'caller_unverified' };
      return untilFree(async () => {
        const state = await store.read(identity);
        if (!state) return { ok: true, outcome: 'unbound' };
        const { binding } = state;
        if (binding.mode === 'manual' && binding.state === 'active') return { ok: true, outcome: 'already', session: { ...binding.session } };
        const switched = await switchMode(store, identity, 'manual', { expectedBinding: bindingIdentity(binding) });
        if (switched?.skipped || switched?.reason === 'binding_conflict') return AGAIN;
        if (!switched?.ok) return { ok: false, reason: String(switched?.reason ?? 'unknown') };
        return { ok: true, outcome: 'paused', session: { ...binding.session } };
      });
    },

    /** Who receives this identity's mail now; read by /localpost-status and localpost_status. */
    async describe() {
      const state = await store.read(identity);
      if (!state) return Object.freeze({ identity, bound: false });
      const { binding } = state;
      return Object.freeze({ identity, bound: true, session: { ...binding.session }, mode: binding.mode, state: binding.state,
        since: binding.since ?? null, attested: attestedNow(state),
        unfinished: Object.values(state.claims).filter(claim => UNFINISHED.includes(claim.status)).map(claim => claim.letter) });
    },
  };

  /**
   * The three human commands for this identity alone (one-identity hosts and tests); a host serving several identities
   * registers one shared set instead (registerBindingCommands, dsh-wiring.mjs). Idempotent while registered.
   */
  function registerCommands() {
    if (!chatBinding) return { ok: false, reason: 'host_cannot_attest', reasons: [...reasons], dispose: () => {} };
    if (registration) return { ok: true, existing: true, dispose: registration.dispose };
    const result = registerBindingCommands({ ctx, hostId, names: commandNames, resolve: async () => bridge,
      status: async caller => statusText([await describeOrExplain(bridge)], caller, commandNames) });
    if (!result.ok) return result;
    // Only the current registration can be released, once: a repeated call, or a late one after a successor registered,
    // is a no-op and never touches the successor.
    const own = { names: result.names };
    own.dispose = () => {
      if (registration !== own) return;
      registration = null;
      result.dispose();
    };
    registration = own;
    return { ok: true, names: result.names, dispose: own.dispose };
  }

  return { ...bridge, registerCommands };
}

/* ------------------------------------------------------------------ the human commands */

/**
 * Registers the three human commands once for the whole host. None takes input; each proves the calling chat through the
 * host, then acts on the identity that chat speaks for (`resolve(caller)` → that identity's bridge); status shows every
 * identity (`status(caller)` → text). Registration is all-or-nothing: a taken name or a mid-way failure releases whatever
 * was registered, in reverse order, and leaves the host with none of these commands.
 */
export function registerBindingCommands({ ctx, hostId = 'local', names = COMMANDS, resolve, status } = {}) {
  const commands = ctx?.commands;
  const agents = ctx?.agents;
  if (typeof commands?.register !== 'function' || typeof agents?.get !== 'function') return { ok: false, reason: 'host_cannot_attest', dispose: () => {} };
  const order = [names.bind, names.unbind, names.status];
  if (typeof commands.find === 'function') {
    for (const name of order) {
      let existing;
      // An unreadable lookup is not "no existing definition": it must stop registration.
      try { existing = commands.find(undefined, name); }
      catch (error) { return { ok: false, reason: 'lookup_failed', name, message: String(error?.message ?? error), dispose: () => {} }; }
      if (existing !== undefined) return { ok: false, reason: 'command_name_taken', name, dispose: () => {} };
    }
  }
  const registered = new Map();
  const disposers = [];
  const release = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } } };
  // A scoped registration can shadow a global one, so the command that actually runs for THIS agent must still be the
  // handler registered here; anything else refuses instead of acting.
  const shadowed = (name, invocation) => {
    const ours = registered.get(name);
    if (!ours || typeof commands.find !== 'function') return null;
    let effective;
    try { effective = commands.find(invocation?.agent, name); }
    catch (error) { return { kind: 'error', text: 'LocalPost：宿主解析不了 /' + name + '（' + String(error?.message ?? error) + '），没有改动。' }; }
    if (!effective || effective.handler !== ours.handler) return { kind: 'error', text: 'LocalPost：/' + name + ' 被别的定义遮蔽了，没有改动。' };
    return null;
  };
  const define = (name, description, act) => {
    const handler = async invocation => {
      const refusal = shadowed(name, invocation);
      if (refusal) return refusal;
      const caller = attestedCommandCaller(invocation, agents, hostId);
      if (!caller) return { kind: 'error', text: 'LocalPost：宿主没能证明是哪个聊天在敲命令（需要聊天 id 和绝对路径的工作目录），没有改动。' };
      try { return await act(caller); }
      catch (error) { return { kind: 'error', text: 'LocalPost：' + String(error?.message ?? error) }; }
    };
    const dispose = commands.register({ name, description, recordInput: false, handler });
    disposers.push(typeof dispose === 'function' ? dispose : () => {});
    registered.set(name, { handler });
  };
  try {
    define(names.bind, '把收信切到这个聊天：新信自动送到这里，原来在别的聊天就接管过来（无参数）', async caller => {
      const target = await resolve(caller);
      const result = await target.bindHere(caller, { via: 'command' });
      return { kind: result?.ok ? 'success' : 'error', text: bindText(target.identity, result, names) };
    });
    define(names.unbind, '停止自动收信：新信留在收件箱，可以手动处理（无参数）', async caller => {
      const target = await resolve(caller);
      const result = await target.stopAuto(caller);
      return { kind: result?.ok ? 'success' : 'error', text: unbindText(target.identity, result, names) };
    });
    define(names.status, '查看现在哪个聊天在收信、自动收信开没开（无参数）', async caller => ({ kind: 'success', text: await status(caller) }));
  } catch (error) {
    release();
    return { ok: false, reason: 'registration_failed', message: String(error?.message ?? error), dispose: () => {} };
  }
  return { ok: true, names: [...order], dispose: release };
}
