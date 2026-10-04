import path from 'node:path';
import { assertId } from './fs-safe.mjs';
import { createSessionStore } from './session-binding.mjs';
import { createMailbox } from './mailbox.mjs';
import { createBindingProvider } from './binding-provider.mjs';
import { attestedCommandCaller, createDshHostBridge, SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { createMailTools } from './dsh-mail-tools.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { createDshAdapter } from './dsh-adapter.mjs';
import { CHILD_REFUSED, createMailTurnGuard } from './mail-turn-guard.mjs';
import { createReceiver } from './receiver.mjs';

/**
 * The isolated acceptance entry point.
 *
 * Wiring the bridge and the mail tools into the real DSH plugin is exactly what turns "the source is
 * merged" into "the host can run it", so it is also the moment production could start dispatching by
 * accident. This module therefore has one job: make the isolated entry reachable WITHOUT ever
 * touching production.
 *
 *   - nothing is registered unless the caller explicitly asked for it (default off);
 *   - only the isolated test root is accepted; the production mailbox root - and anything under it -
 *     is refused outright, so a typo can never point automatic handling at real mail;
 *   - every input and capability is checked, and everything that can fail without side effects - the
 *     receiver included - is built, before the first registration;
 *   - the registrations (base commands, mail tools with their guard, E commands) are one transaction:
 *     any failure releases what was registered, in reverse order, and returns a refusal;
 *   - the receiver is owned here and handed out unstarted: only the E human commands start it, so live
 *     E1-E6 stay a separately authorized step, not a side effect of loading a plugin;
 *   - every relay is armed with the mail-turn guard on its target agent before it is enqueued (mail-turn-guard.mjs):
 *     the claimed turn reaches only the five LocalPost tools and cannot create child agents;
 *   - dispose stops the receiver, drains the mail-turn guard (a waiting relay is withdrawn, a running mail turn is
 *     cancelled and released only by its own turn/end) and then releases every registration, even when stopping fails.
 *     An armament that did not drain in time stays on its agent - denying - and is reported, never disposed early.
 *
 * Status `ready_for_live_E` means the code is ready for the live run. It is not evidence that E1-E6
 * ran, and it is not permission to enable production dispatch.
 */
export const ISOLATED_ROOT = 'C:/AI_ASSIST/work/localpost-e-test';
export const PRODUCTION_ROOT = 'C:/AI_ASSIST/.mailbox';
export const WIRING_STATUS = 'ready_for_live_E';
export const E_COMMANDS = Object.freeze({ start: 'localpost-e-start', stop: 'localpost-e-stop', status: 'localpost-e-status' });
/** How long unloading waits for running mail turns to end after cancelling them; what is left stays guarded. */
export const DRAIN_TIMEOUT_MS = 10000;

const resolved = value => { try { return path.resolve(String(value)); } catch { return null; } };
const samePath = (left, right) => left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
const underPath = (child, parent) => {
  if (child === null || parent === null) return false;
  const low = child.toLowerCase();
  const base = parent.toLowerCase();
  return low === base || low.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
};
const safeId = value => { try { assertId(value); return true; } catch { return false; } };
// An AggregateError carries its parts' messages, so a combined failure still says what each part was.
const errorText = error => (error instanceof AggregateError
  ? String(error.message) + ': ' + error.errors.map(part => String(part?.message ?? part)).join('; ')
  : String(error?.message ?? error));

/**
 * The sender list as the environment carries it: a comma-separated string. Nothing is trimmed or dropped here, so a
 * blank or padded entry reaches the strict check in createIsolatedWiring and refuses the wiring instead of vanishing.
 */
export function allowFromConfig(value) {
  return value === undefined || value === null || value === '' ? [] : String(value).split(',');
}

/** A refusal that registered nothing and disposes nothing, so callers can treat every shape alike. */
function refused(reason, decisions, detail) {
  return Object.freeze({ enabled: false, status: WIRING_STATUS, reason, ...(detail === undefined ? {} : { detail }),
    decisions: Object.freeze([...decisions]), dispose: () => {} });
}

/**
 * @param {{ctx?: object, config?: {enabled?: boolean, root?: string, allowFrom?: string[], scanIntervalMs?: number, debounceMs?: number},
 *   runtimeVersion?: string, versionEvidence?: string, identity?: string, hostId?: string,
 *   isolatedRoot?: string, receiverFactory?: (options: object) => {start: Function, stop: Function, diagnostics: Function}}} input
 *   isolatedRoot and receiverFactory exist for tests (a unique temporary root, a counting fake); the plugin entry passes
 *   neither, so production always gets the canonical isolated root and the real receiver.
 * @returns {{enabled: boolean, status: string, reason?: string, detail?: string, decisions: readonly string[], dispose: () => Promise<void> | void, parts?: object}}
 */
export function createIsolatedWiring({ ctx, config = {}, runtimeVersion, versionEvidence, identity = 'dsh', hostId = 'local',
  isolatedRoot = ISOLATED_ROOT, receiverFactory = createReceiver, drainTimeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  const decisions = [];
  if (config?.enabled !== true) return refused('disabled_by_default', decisions);
  decisions.push('explicitly_enabled');

  const root = resolved(config.root);
  const isolated = resolved(isolatedRoot);
  const production = resolved(PRODUCTION_ROOT);
  if (root === null || String(config.root ?? '').trim() === '') return refused('root_invalid', decisions);
  // The production mailbox root first: a misconfigured path must never reach real mail.
  if (underPath(root, production)) return refused('production_root_refused', decisions);
  if (!samePath(root, isolated)) return refused('root_not_isolated', decisions);
  decisions.push('isolated_root_confirmed');

  if (runtimeVersion !== SUPPORTED_VERSION) return refused('runtime_version_mismatch', decisions);
  decisions.push('runtime_version_confirmed');
  // The version is configuration, so a recorded external pre-check is required alongside it: the real
  // gate stays the capability probe below, which a wrong host cannot pass by editing a string.
  if (typeof versionEvidence !== 'string' || versionEvidence.trim() === '') return refused('version_evidence_missing', decisions);
  decisions.push('version_evidence_recorded');

  // Every sender must be an exact safe identifier: a blank, padded or malformed entry refuses the wiring rather than
  // being dropped, so the list that runs is the list that was written.
  const allowFrom = config?.allowFrom;
  if (allowFrom === undefined || (Array.isArray(allowFrom) && allowFrom.length === 0)) return refused('allow_from_required', decisions);
  if (!Array.isArray(allowFrom) || !allowFrom.every(entry => typeof entry === 'string' && safeId(entry))) return refused('allow_from_invalid', decisions);
  // An interval of 0 or a negative value would spin a timer; the bounds fail closed on both sides.
  const scanIntervalMs = config?.scanIntervalMs === undefined ? 30000 : config.scanIntervalMs;
  if (!Number.isInteger(scanIntervalMs) || scanIntervalMs < 1000 || scanIntervalMs > 3600000) return refused('scan_interval_invalid', decisions);
  const debounceMs = config?.debounceMs === undefined ? 250 : config.debounceMs;
  if (!Number.isInteger(debounceMs) || debounceMs < 50 || debounceMs > 600000) return refused('debounce_invalid', decisions);
  decisions.push('allowlist_and_timers_validated');
  // The E commands are guarded against shadowing through the host's own lookup, so it is a required capability.
  if (typeof ctx?.commands?.find !== 'function') return refused('e_lookup_unavailable', decisions);
  // The mail-turn guard's child barrier listens to the host's agent creation and asks it who owns the new agent.
  if (typeof ctx?.on !== 'function' || typeof ctx?.agents?.isOwnedBy !== 'function') return refused('mail_turn_barrier_unavailable', decisions);

  // Everything that can fail without side effects is built before the first registration - the receiver included.
  let store, bridge, tools, mailTurnGuard, adapter, receiver;
  try {
    store = createSessionStore({ root });
    const mailbox = createMailbox({ root, identity });
    bridge = createDshHostBridge({ ctx, runtimeVersion, store, identity, hostId });
    tools = createMailTools({ ctx, mailbox, store, identity, runtimeVersion, hostId });
    // Bound to the CURRENT tool registration: once the tools are released, a still-armed mail turn reaches nothing.
    mailTurnGuard = createMailTurnGuard({ policy: exec => tools.mailTurnReason(exec), agents: ctx.agents });
    const acceptance = createLedgerAcceptance({ store, identity });
    adapter = createDshAdapter({ ctx, runtimeVersion, hostId, mailboxAgent: identity, acceptance, mailTurnGuard,
      bindingProvider: createBindingProvider({ store, identity, host: bridge }) });
    receiver = receiverFactory({ root, agent: identity, allowFrom: [...allowFrom], adapter, scanIntervalMs, debounceMs });
  } catch (error) {
    return refused('build_failed', decisions, errorText(error));
  }
  decisions.push('built');

  // The E names are checked with the host before anything is registered; an unreadable lookup is not "free".
  for (const name of Object.values(E_COMMANDS)) {
    let existing;
    try { existing = ctx.commands.find(undefined, name); }
    catch (error) { return refused('e_lookup_failed', decisions, name + ': ' + errorText(error)); }
    if (existing !== undefined) return refused('e_command_name_taken', decisions, name);
  }

  /*
   * The one receiver this wiring owns: one watcher, one interval, one owner. Constructing it touched nothing; only
   * start() scans. Every start/stop runs through one queue, so concurrent calls queue instead of racing the watcher.
   */
  let running = false;
  let disposed = false;
  let startedBy = null;
  let lastStartError = null;
  let lastStopError = null;
  let shutdownError = null;
  let lastDrain = null;
  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  const status = () => Object.freeze({ ...receiver.diagnostics(), owned: true, running, disposed, root,
    mailTurnGuard: mailTurnGuard.status(),
    ...(lastDrain === null ? {} : { lastDrain }),
    ...(lastStartError === null ? {} : { lastStartError: errorText(lastStartError) }),
    ...(lastStopError === null ? {} : { lastStopError: errorText(lastStopError) }),
    ...(shutdownError === null ? {} : { shutdownError: errorText(shutdownError) }) });
  const control = Object.freeze({
    /** Starts the single watcher; repeat and concurrent calls start it once. A failed start is never reported running. */
    async start(caller = null) {
      return serialize(async () => {
        if (disposed || running) return status();
        try {
          await receiver.start();
        } catch (error) {
          lastStartError = error;
          // A start that failed half-way may already hold a watcher: close it before reporting the failure. If that
          // cleanup fails too, both failures are reported - neither is dropped.
          let cleanupError = null;
          try { await receiver.stop(); } catch (failure) { cleanupError = failure; lastStopError = failure; }
          throw cleanupError === null ? error : new AggregateError([error, cleanupError], 'receiver start failed, and closing what it had opened failed too');
        }
        running = true;
        startedBy = caller;
        lastStartError = null;
        return status();
      });
    },
    /**
     * Stops the watcher and its interval; repeat calls are no-ops. The receiver's stop attempts every cleanup step before
     * it reports a failure, so afterwards the receiver's own report decides whether it still runs; the failure itself is
     * passed on and kept in status().lastStopError.
     */
    async stop() {
      return serialize(async () => {
        if (running) {
          try {
            await receiver.stop();
            lastStopError = null;
          } catch (error) {
            lastStopError = error;
            throw error;
          } finally {
            running = receiver.diagnostics().running === true;
            if (!running) startedBy = null;
          }
        }
        return status();
      });
    },
    status,
  });

  /*
   * The E entry points are human commands: no model-callable tool can start automatic dispatch. Each one first proves
   * that the definition the host resolves for this very agent is the one registered here (a scoped command can shadow a
   * global one), then that the host attests the caller. Start needs the bound chat under an active, automatic binding;
   * stop and status are open to the bound chat in any binding state and to the chat that started the running receiver,
   * so a receiver can always be stopped - and unloading the plugin stops it in any case.
   */
  const handlers = new Map();
  const effectiveIsOurs = (name, invocation) => {
    try { return ctx.commands.find(invocation?.agent, name)?.handler === handlers.get(name); } catch { return false; }
  };
  const sameChat = (session, caller) => caller !== null && session?.host === caller.host && session?.id === caller.session &&
    (session?.cwd ?? null) === caller.cwd;
  const mayStart = (state, caller) => sameChat(state?.binding?.session, caller) && state.binding.state === 'active' && state.binding.mode === 'auto';
  const mayControl = (state, caller) => sameChat(state?.binding?.session, caller) ||
    (startedBy !== null && sameChat({ host: startedBy.host, id: startedBy.session, cwd: startedBy.cwd }, caller));
  const defineE = (name, description, allowed, refusal, act) => {
    const handler = async invocation => {
      if (!effectiveIsOurs(name, invocation)) return { kind: 'error', text: 'LocalPost: /' + name + ' 被其他定义遮蔽或无法解析，未执行任何操作（shadowed）。' };
      const caller = attestedCommandCaller(invocation, ctx.agents, hostId);
      if (!caller) return { kind: 'error', text: 'LocalPost: 无法证明调用者身份，已拒绝。' };
      let state = null;
      let unreadable = null;
      try { state = await store.read(identity); } catch (error) { unreadable = error; }
      if (!allowed(state, caller)) return { kind: 'error', text: 'LocalPost: ' + refusal + (unreadable === null ? '' : '（绑定状态无法读取：' + errorText(unreadable) + '）') };
      try { return { kind: 'success', text: 'LocalPost E: ' + JSON.stringify(await act(caller)) }; }
      catch (error) { return { kind: 'error', text: 'LocalPost E: ' + errorText(error) }; }
    };
    handlers.set(name, handler);
    return { name, description, recordInput: false, handler };
  };
  const eDefinitions = [
    defineE(E_COMMANDS.start, '启动隔离验收 receiver（仅已绑定且处于自动模式的测试聊天、无参数）。', mayStart,
      '只有已绑定且处于自动模式的测试聊天可以启动隔离 receiver。', caller => control.start(caller)),
    defineE(E_COMMANDS.stop, '停止隔离验收 receiver（已绑定聊天或启动它的聊天、无参数）。', mayControl,
      '只有已绑定的测试聊天或启动它的聊天可以停止隔离 receiver。', () => control.stop()),
    defineE(E_COMMANDS.status, '查看隔离验收 receiver 状态（已绑定聊天或启动它的聊天、无参数）。', mayControl,
      '只有已绑定的测试聊天或启动它的聊天可以查看隔离 receiver。', () => control.status()),
  ];

  // One transaction: base commands, mail tools with their guard, then the E commands. Any failure releases everything
  // registered so far, in reverse order, and the caller gets a refusal instead of a half-registered wiring.
  const disposers = [];
  const release = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } } };
  try {
    const commands = bridge.registerCommands();
    if (commands.ok !== true) { release(); return refused('commands_' + String(commands.reason ?? 'refused'), decisions, commands.name); }
    disposers.push(commands.dispose);
    const registered = tools.register();
    if (registered.ok !== true) { release(); return refused('tools_' + String(registered.reason ?? 'refused'), decisions, registered.name); }
    disposers.push(registered.dispose);
    // The child barrier at the host's real creation entry: agent/created is a serial dispatch whose listener failure
    // rejects the announcement, which rolls the new agent back (dsh-agent AgentRegistry.announce).
    const barrier = ctx.on('agent/created', payload => {
      const refusal = mailTurnGuard.childRefusal(payload?.agent);
      if (refusal !== undefined) throw Object.assign(new Error('LocalPost: ' + refusal), { code: CHILD_REFUSED });
    });
    disposers.push(typeof barrier === 'function' ? barrier : () => {});
    for (const definition of eDefinitions) {
      const dispose = ctx.commands.register(definition);
      disposers.push(typeof dispose === 'function' ? dispose : () => {});
    }
  } catch (error) {
    release();
    return refused('registration_failed', decisions, errorText(error));
  }
  decisions.push('commands_registered', 'tools_registered', 'child_barrier_registered', 'e_commands_registered');

  /*
   * Unload, in this order, each step whatever the previous one did:
   *   1. stop the receiver (after whatever start/stop is queued): no new relay is accepted;
   *   2. drain the mail-turn guard: a relay still waiting in a chat's inbox is withdrawn, a running mail turn is cancelled
   *      (the user's queued input kept) and released only by its own turn/end; what does not drain within
   *      drainTimeoutMs stays armed on its agent - still denying - and is reported in status().lastDrain;
   *   3. release every registration.
   * The armaments live on the agents' own scopes, so cordis disposing this plugin's effects concurrently with this
   * function (Fiber._unload runs every disposable at once) cannot remove them. A stop failure is kept and shown by
   * status().shutdownError. Idempotent; no start is admitted from here on. Cordis rc.2 awaits a Promise returned by an
   * effect disposer (fiber unload runs runDisposable), so the host waits for all of it.
   */
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise === null) {
      disposed = true;
      shutdownPromise = (async () => {
        try {
          try { await control.stop(); } catch (error) { shutdownError = error; }
          try {
            lastDrain = await mailTurnGuard.drain({ timeoutMs: drainTimeoutMs });
            if (lastDrain.held.length > 0 && shutdownError === null) {
              shutdownError = new Error('mail turns still guarded after unload: ' + lastDrain.held.map(item => item.messageId + '@turn ' + String(item.turn)).join(', '));
            }
          } catch (error) { shutdownError ??= error; }
        } finally { release(); }
      })();
    }
    return shutdownPromise;
  };

  decisions.push(adapter.capabilities.trustedBinding ? 'adapter_binding_trusted' : 'adapter_binding_untrusted');

  return Object.freeze({
    enabled: true, status: WIRING_STATUS, decisions: Object.freeze([...decisions]), dispose: shutdown,
    parts: Object.freeze({
      root, store, bridge, tools, adapter, mailTurnGuard,
      capabilities: Object.freeze({ ...tools.capabilities(), adapter: adapter.capabilities }),
      diagnostics: () => adapter.diagnostics(),
      versionEvidence,
      /** The one receiver this wiring owns, handed out unstarted; it is started from the E commands only. */
      receiver: control,
    }),
  });
}
