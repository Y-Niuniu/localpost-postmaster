import path from 'node:path';
import { assertId } from './fs-safe.mjs';
import { createSessionStore } from './session-binding.mjs';
import { createMailbox } from './mailbox.mjs';
import { createBindingProvider } from './binding-provider.mjs';
import { attestedCommandCaller, createDshHostBridge, SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { createMailTools } from './dsh-mail-tools.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { createDshAdapter } from './dsh-adapter.mjs';
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
 *   - dispose stops the receiver and then releases every registration, even when stopping fails.
 *
 * Status `ready_for_live_E` means the code is ready for the live run. It is not evidence that E1-E6
 * ran, and it is not permission to enable production dispatch.
 */
export const ISOLATED_ROOT = 'C:/AI_ASSIST/work/localpost-e-test';
export const PRODUCTION_ROOT = 'C:/AI_ASSIST/.mailbox';
export const WIRING_STATUS = 'ready_for_live_E';
export const E_COMMANDS = Object.freeze({ start: 'localpost-e-start', stop: 'localpost-e-stop', status: 'localpost-e-status' });
// 生产自动收信（2026-10-05 用户放行）：同一套装配，只有"根"与命令名不同。
// 隔离入口拒绝生产根、生产入口拒绝隔离根——两个方向都 fail closed，永不会互相串。
export const PRODUCTION_WIRING_STATUS = 'ready_for_live_production';
export const AUTO_COMMANDS = Object.freeze({ start: 'localpost-auto-start', stop: 'localpost-auto-stop', status: 'localpost-auto-status' });

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
function refused(reason, decisions, detail, status = WIRING_STATUS) {
  return Object.freeze({ enabled: false, status, reason, ...(detail === undefined ? {} : { detail }),
    decisions: Object.freeze([...decisions]), dispose: () => {} });
}

/**
 * @param {{ctx?: object, config?: {enabled?: boolean, root?: string, allowFrom?: string[], scanIntervalMs?: number, debounceMs?: number},
 *   runtimeVersion?: string, versionEvidence?: string, identity?: string, hostId?: string,
 *   isolatedRoot?: string, productionRoot?: string, receiverFactory?: (options: object) => {start: Function, stop: Function, diagnostics: Function}}} input
 *   isolatedRoot / productionRoot / receiverFactory exist for tests (unique temporary roots, a counting fake); the plugin
 *   entry passes none of them, so the real entries always get the canonical root of their own kind and the real receiver.
 * @returns {{enabled: boolean, status: string, reason?: string, detail?: string, decisions: readonly string[], dispose: () => Promise<void> | void, parts?: object}}
 */
export function createIsolatedWiring(input = {}) {
  return createWiring({ ...input, kind: 'isolated' });
}

/**
 * 生产自动收信（同一套装配，另一个根）。
 *
 * 与隔离入口互为镜像：隔离入口拒绝生产根，这里拒绝隔离根；两边都 fail closed，串不到一起。
 * 注册的能力与隔离入口相同（base 命令、5 个邮件工具 + guard、3 个控制命令），只是根换成真实
 * `.mailbox`、命令名换成 `localpost-auto-*`、状态串换成 `ready_for_live_production`。
 */
export function createProductionWiring(input = {}) {
  return createWiring({ ...input, kind: 'production' });
}

function createWiring({ kind = 'isolated', ctx, config = {}, runtimeVersion, versionEvidence, identity = 'dsh', hostId = 'local',
  isolatedRoot = ISOLATED_ROOT, productionRoot = PRODUCTION_ROOT, receiverFactory = createReceiver } = {}) {
  const isProduction = kind === 'production';
  const wiringStatus = isProduction ? PRODUCTION_WIRING_STATUS : WIRING_STATUS;
  const actions = isProduction ? AUTO_COMMANDS : E_COMMANDS;
  const label = isProduction ? 'LocalPost AUTO' : 'LocalPost E';
  const subject = isProduction ? '生产收信' : '隔离验收';
  const decisions = [];
  const refuse = (reason, detail) => refused(reason, decisions, detail, wiringStatus);
  if (config?.enabled !== true) return refuse('disabled_by_default');
  decisions.push('explicitly_enabled');

  const root = resolved(config.root);
  const isolated = resolved(isolatedRoot);
  const production = resolved(productionRoot);
  if (root === null || String(config.root ?? '').trim() === '') return refuse('root_invalid');
  if (isProduction) {
    // 生产入口只认生产根：隔离根（及其子路径）和一切别的路径都拒绝——方向与隔离入口相反，同样 fail closed。
    if (samePath(root, isolated) || underPath(root, isolated)) return refuse('isolated_root_refused');
    if (!samePath(root, production)) return refuse('root_not_production');
    decisions.push('production_root_confirmed');
  } else {
    // The production mailbox root first: a misconfigured path must never reach real mail.
    if (underPath(root, production)) return refuse('production_root_refused');
    if (!samePath(root, isolated)) return refuse('root_not_isolated');
    decisions.push('isolated_root_confirmed');
  }

  if (runtimeVersion !== SUPPORTED_VERSION) return refuse('runtime_version_mismatch');
  decisions.push('runtime_version_confirmed');
  // The version is configuration, so a recorded external pre-check is required alongside it: the real
  // gate stays the capability probe below, which a wrong host cannot pass by editing a string.
  if (typeof versionEvidence !== 'string' || versionEvidence.trim() === '') return refuse('version_evidence_missing');
  decisions.push('version_evidence_recorded');

  // Every sender must be an exact safe identifier: a blank, padded or malformed entry refuses the wiring rather than
  // being dropped, so the list that runs is the list that was written.
  const allowFrom = config?.allowFrom;
  if (allowFrom === undefined || (Array.isArray(allowFrom) && allowFrom.length === 0)) return refuse('allow_from_required');
  if (!Array.isArray(allowFrom) || !allowFrom.every(entry => typeof entry === 'string' && safeId(entry))) return refuse('allow_from_invalid');
  // An interval of 0 or a negative value would spin a timer; the bounds fail closed on both sides.
  const scanIntervalMs = config?.scanIntervalMs === undefined ? 30000 : config.scanIntervalMs;
  if (!Number.isInteger(scanIntervalMs) || scanIntervalMs < 1000 || scanIntervalMs > 3600000) return refuse('scan_interval_invalid');
  const debounceMs = config?.debounceMs === undefined ? 250 : config.debounceMs;
  if (!Number.isInteger(debounceMs) || debounceMs < 50 || debounceMs > 600000) return refuse('debounce_invalid');
  decisions.push('allowlist_and_timers_validated');
  // The control commands are guarded against shadowing through the host's own lookup, so it is a required capability.
  if (typeof ctx?.commands?.find !== 'function') return refuse('e_lookup_unavailable');

  // Everything that can fail without side effects is built before the first registration - the receiver included.
  let store, bridge, tools, adapter, receiver;
  try {
    store = createSessionStore({ root });
    const mailbox = createMailbox({ root, identity });
    bridge = createDshHostBridge({ ctx, runtimeVersion, store, identity, hostId });
    tools = createMailTools({ ctx, mailbox, store, identity, runtimeVersion, hostId });
    const acceptance = createLedgerAcceptance({ store, identity });
    adapter = createDshAdapter({ ctx, runtimeVersion, hostId, mailboxAgent: identity, acceptance,
      bindingProvider: createBindingProvider({ store, identity, host: bridge }) });
    receiver = receiverFactory({ root, agent: identity, allowFrom: [...allowFrom], adapter, scanIntervalMs, debounceMs });
  } catch (error) {
    return refuse('build_failed', errorText(error));
  }
  decisions.push('built');

  // The control names are checked with the host before anything is registered; an unreadable lookup is not "free".
  for (const name of Object.values(actions)) {
    let existing;
    try { existing = ctx.commands.find(undefined, name); }
    catch (error) { return refuse('e_lookup_failed', name + ': ' + errorText(error)); }
    if (existing !== undefined) return refuse('e_command_name_taken', name);
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
  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  const status = () => Object.freeze({ ...receiver.diagnostics(), owned: true, running, disposed, root,
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
  const defineAction = (name, description, allowed, refusalText, act) => {
    const handler = async invocation => {
      if (!effectiveIsOurs(name, invocation)) return { kind: 'error', text: 'LocalPost: /' + name + ' 被其他定义遮蔽或无法解析，未执行任何操作（shadowed）。' };
      const caller = attestedCommandCaller(invocation, ctx.agents, hostId);
      if (!caller) return { kind: 'error', text: 'LocalPost: 无法证明调用者身份，已拒绝。' };
      let state = null;
      let unreadable = null;
      try { state = await store.read(identity); } catch (error) { unreadable = error; }
      if (!allowed(state, caller)) return { kind: 'error', text: 'LocalPost: ' + refusalText + (unreadable === null ? '' : '（绑定状态无法读取：' + errorText(unreadable) + '）') };
      try { return { kind: 'success', text: label + ': ' + JSON.stringify(await act(caller)) }; }
      catch (error) { return { kind: 'error', text: label + ': ' + errorText(error) }; }
    };
    handlers.set(name, handler);
    return { name, description, recordInput: false, handler };
  };
  const actionDefinitions = [
    defineAction(actions.start, '启动' + subject + ' receiver（仅已绑定且处于自动模式的聊天、无参数）。', mayStart,
      '只有已绑定且处于自动模式的聊天可以启动' + subject + ' receiver。', caller => control.start(caller)),
    defineAction(actions.stop, '停止' + subject + ' receiver（已绑定聊天或启动它的聊天、无参数）。', mayControl,
      '只有已绑定的聊天或启动它的聊天可以停止' + subject + ' receiver。', () => control.stop()),
    defineAction(actions.status, '查看' + subject + ' receiver 状态（已绑定聊天或启动它的聊天、无参数）。', mayControl,
      '只有已绑定的聊天或启动它的聊天可以查看' + subject + ' receiver。', () => control.status()),
  ];

  // One transaction: base commands, mail tools with their guard, then the E commands. Any failure releases everything
  // registered so far, in reverse order, and the caller gets a refusal instead of a half-registered wiring.
  const disposers = [];
  const release = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } } };
  try {
    const commands = bridge.registerCommands();
    if (commands.ok !== true) { release(); return refuse('commands_' + String(commands.reason ?? 'refused'), commands.name); }
    disposers.push(commands.dispose);
    const registered = tools.register();
    if (registered.ok !== true) { release(); return refuse('tools_' + String(registered.reason ?? 'refused'), registered.name); }
    disposers.push(registered.dispose);
    for (const definition of actionDefinitions) {
      const dispose = ctx.commands.register(definition);
      disposers.push(typeof dispose === 'function' ? dispose : () => {});
    }
  } catch (error) {
    release();
    return refuse('registration_failed', errorText(error));
  }
  decisions.push('commands_registered', 'tools_registered', 'e_commands_registered');

  /*
   * 可选的"绑定后自启"（config.autoStart，配置层的人工开关）：读一次绑定状态，只有已存在 active + auto 的
   * 绑定时才启动 receiver。目的：让"重启后仍然自动收信"成立，把人工步骤压到只剩一次绑定；模型侧依然没有
   * 任何 start/stop 工具，start 仍只由人类命令或本开关触发。
   *
   * 绑定通常发生在装配**之后**（用户那一刻才敲 /localpost-bind），所以这里除了首次尝试，还对外暴露
   * parts.retryAutoStart()：宿主用 ctx.setInterval 定期调用它，绑上即自启。首次成功返回 'started'，
   * 之后返回 'already_running'（宿主据此只记一条日志，不刷屏）。
   */
  let autoStarted = false;
  const attemptAutoStart = async () => {
    if (disposed) return 'disposed';
    if (running) return autoStarted ? 'already_running' : 'already_running';
    try {
      const state = await store.read(identity);
      const binding = state?.binding;
      if (!binding || binding.state !== 'active' || binding.mode !== 'auto') return 'skipped_unbound';
      await control.start(null);
      const first = !autoStarted;
      autoStarted = true;
      return first ? 'started' : 'already_running';
    } catch (error) {
      return 'failed: ' + errorText(error);
    }
  };
  let autoStart = Promise.resolve('disabled');
  if (config?.autoStart === true) {
    decisions.push('auto_start_scheduled');
    autoStart = attemptAutoStart();
  }

  /*
   * Stops the receiver this wiring owns - after whatever start/stop is queued - and then releases every registration,
   * even if stopping fails; that failure is kept and shown by status().shutdownError. Idempotent, and no start is admitted
   * from here on. Cordis rc.2 awaits a Promise returned by an effect disposer (fiber unload runs runDisposable), so the
   * host waits for all of it.
   */
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise === null) {
      disposed = true;
      shutdownPromise = (async () => {
        try { await control.stop(); } catch (error) { shutdownError = error; } finally { release(); }
      })();
    }
    return shutdownPromise;
  };

  decisions.push(adapter.capabilities.trustedBinding ? 'adapter_binding_trusted' : 'adapter_binding_untrusted');

  return Object.freeze({
    enabled: true, status: wiringStatus, decisions: Object.freeze([...decisions]), dispose: shutdown,
    parts: Object.freeze({
      root, store, bridge, tools, adapter, kind,
      capabilities: Object.freeze({ ...tools.capabilities(), adapter: adapter.capabilities }),
      diagnostics: () => adapter.diagnostics(),
      versionEvidence,
      /** The one receiver this wiring owns, handed out unstarted; it is started from the control commands only. */
      receiver: control,
      /** 'disabled' | 'skipped_unbound' | 'started' | 'already_running' | 'failed: …' —— 配置了 autoStart 时才有意义。 */
      autoStart,
      /** 宿主定期调用：绑定出现后自动启动 receiver（未配置 autoStart 时恒为 'disabled'）。 */
      retryAutoStart: config?.autoStart === true ? attemptAutoStart : async () => 'disabled',
    }),
  });
}
