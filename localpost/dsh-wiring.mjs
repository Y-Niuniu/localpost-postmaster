import path from 'node:path';
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
 *   - every capability the bridge and the tools need is required, and the runtime must be the exact
 *     supported one, so a host that cannot attest a chat registers nothing;
 *   - the receiver is returned as a factory that is NOT started: live E1-E6 stay a separately
 *     authorized step, not a side effect of loading a plugin;
 *   - dispose releases commands, tools, guard and store handles and is idempotent.
 *
 * Status of this entry point is `ready_for_live_E`. It is not evidence that E1-E6 ran, and it is not
 * permission to enable production dispatch.
 */
export const ISOLATED_ROOT = 'C:/AI_ASSIST/work/localpost-e-test';
export const PRODUCTION_ROOT = 'C:/AI_ASSIST/.mailbox';
export const WIRING_STATUS = 'ready_for_live_E';

const resolved = value => { try { return path.resolve(String(value)); } catch { return null; } };
const samePath = (left, right) => left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
const underPath = (child, parent) => {
  if (child === null || parent === null) return false;
  const low = child.toLowerCase();
  const base = parent.toLowerCase();
  return low === base || low.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
};

/** A refusal that registered nothing and disposes nothing, so callers can treat every shape alike. */
function refused(reason, decisions) {
  return Object.freeze({ enabled: false, status: WIRING_STATUS, reason, decisions: Object.freeze([...decisions]), dispose: () => {} });
}

/**
 * @param {{ctx?: object, config?: {enabled?: boolean, root?: string}, runtimeVersion?: string, identity?: string, hostId?: string}} input
 * @returns {{enabled: boolean, status: string, reason?: string, decisions: readonly string[], dispose: () => void, parts?: object}}
 */
export function createIsolatedWiring({ ctx, config = {}, runtimeVersion, versionEvidence, identity = 'dsh', hostId = 'local' } = {}) {
  const decisions = [];
  if (config?.enabled !== true) return refused('disabled_by_default', decisions);
  decisions.push('explicitly_enabled');

  const root = resolved(config.root);
  const isolated = resolved(ISOLATED_ROOT);
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

  // Inputs are validated here, not left to whoever calls the control: an interval of 0 or a negative
  // value would spin a timer, and an open sender list would widen who may wake a chat.
  const allowFrom = Array.isArray(config?.allowFrom)
    ? config.allowFrom.filter(entry => typeof entry === 'string' && entry.trim() !== '')
    : [];
  if (allowFrom.length === 0) return refused('allow_from_required', decisions);
  const scanIntervalMs = config?.scanIntervalMs === undefined ? 30000 : config.scanIntervalMs;
  if (!Number.isInteger(scanIntervalMs) || scanIntervalMs < 1000 || scanIntervalMs > 3600000) return refused('scan_interval_invalid', decisions);
  const debounceMs = config?.debounceMs === undefined ? 250 : config.debounceMs;
  if (!Number.isInteger(debounceMs) || debounceMs < 50 || debounceMs > 600000) return refused('debounce_invalid', decisions);
  decisions.push('allowlist_and_timers_validated');

  const store = createSessionStore({ root });
  const mailbox = createMailbox({ root, identity });
  const bridge = createDshHostBridge({ ctx, runtimeVersion, store, identity, hostId });
  const tools = createMailTools({ ctx, mailbox, store, identity, runtimeVersion, hostId });
  const acceptance = createLedgerAcceptance({ store, identity });

  // Nothing is registered before every piece that could fail has been built.
  const commands = bridge.registerCommands();
  if (commands.ok !== true) return refused('commands_' + String(commands.reason ?? 'refused'), decisions);
  const registered = tools.register();
  if (registered.ok !== true) {
    commands.dispose();
    return refused('tools_' + String(registered.reason ?? 'refused'), decisions);
  }
  decisions.push('commands_registered', 'tools_registered');

  // The E entry points are human commands, registered only in E mode: no model-callable tool can start
  // automatic dispatch, and nothing starts merely because the plugin loaded.
  const eCommands = [];
  const callerOf = invocation => attestedCommandCaller(invocation, ctx?.agents, hostId);
  const boundToCaller = async caller => {
    const state = await store.read(identity);
    const bound = state?.binding?.session;
    return Boolean(caller) && bound?.host === caller.host && bound?.id === caller.session && (bound?.cwd ?? null) === caller.cwd;
  };
  const defineE = (name, description, act) => {
    const dispose = ctx.commands.register({
      name, description, recordInput: false,
      handler: async invocation => {
        const caller = callerOf(invocation);
        if (!caller) return { kind: 'error', text: 'LocalPost: 无法证明调用者身份，已拒绝。' };
        if (!(await boundToCaller(caller))) return { kind: 'error', text: 'LocalPost: 只有已绑定的测试聊天可以操作隔离 receiver。' };
        try { return { kind: 'success', text: 'LocalPost E: ' + JSON.stringify(await act()) }; }
        catch (error) { return { kind: 'error', text: 'LocalPost E: ' + String(error?.message ?? error) }; }
      },
    });
    eCommands.push(dispose);
  };

  let shutdownPromise = null;
  /**
   * Stops the receiver this wiring owns - draining the start/stop queue - and only then releases the
   * registrations. Idempotent, and it refuses to admit a later start. A host disposer that cannot await
   * still gets the synchronous half (no new start from here on); the drain completes as soon as the
   * queue it was already running finishes.
   */
  const shutdown = () => {
    if (shutdownPromise !== null) return shutdownPromise;
    disposed = true;
    shutdownPromise = control.stop().then(() => { release(); });
    return shutdownPromise;
  };

  defineE('localpost-e-start', '启动隔离验收 receiver（仅 E 模式、仅已绑定测试聊天、无参数）。', () => control.start());
  defineE('localpost-e-stop', '停止隔离验收 receiver（无参数）。', () => control.stop());
  defineE('localpost-e-status', '查看隔离验收 receiver 状态（无参数）。', () => control.status());

  let observed = null;
  const release = () => {
    if (observed !== null) return;
    observed = true;
    for (const dispose of eCommands.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } }
    try { registered.dispose(); } catch { /* release is best effort */ }
    try { commands.dispose(); } catch { /* release is best effort */ }
  };

  const adapter = createDshAdapter({
    ctx, runtimeVersion, hostId, mailboxAgent: identity, acceptance,
    bindingProvider: createBindingProvider({ store, identity, host: bridge }),
  });

  /**
   * The receiver, owned HERE as a singleton: one watcher, one interval, one owner.
   *
   * Constructing it touches nothing; only start() scans. Because the wiring owns it, dispose() can stop
   * what it started - a receiver that outlived its registration would keep scanning a root nobody watches.
   * Root and identity are the validated isolated values, so no caller can point it at production.
   */
  const receiver = createReceiver({ root, agent: identity, allowFrom: [...allowFrom], adapter, scanIntervalMs, debounceMs });
  let running = false;
  let disposed = false;
  // Every start/stop/dispose runs through this chain: concurrent calls queue instead of racing the watcher.
  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  const status = () => Object.freeze({ ...receiver.diagnostics(), owned: true, running, disposed, root });
  const control = Object.freeze({
    /** Starts the single watcher; repeat calls are no-ops, concurrent calls are serialised. */
    async start() {
      return serialize(async () => {
        if (disposed) return status();
        if (!running) { await receiver.start(); running = true; }
        return status();
      });
    },
    /** Stops the watcher and its interval; repeat calls are no-ops. */
    async stop() {
      return serialize(async () => {
        if (running) { await receiver.stop(); running = false; }
        return status();
      });
    },
    status,
  });

  decisions.push(adapter.capabilities.trustedBinding ? 'adapter_binding_trusted' : 'adapter_binding_untrusted');

  return Object.freeze({
    enabled: true, status: WIRING_STATUS, decisions: Object.freeze([...decisions]), dispose: shutdown,
    parts: Object.freeze({
      root, store, mailbox, bridge, tools, acceptance, adapter,
      capabilities: Object.freeze({ ...tools.capabilities(), adapter: adapter.capabilities }),
      diagnostics: () => adapter.diagnostics(),
      versionEvidence,
      /**
       * Live E1-E6 are not a side effect of loading a plugin: the control is handed back unstarted,
       * and starting it stays a separately authorized step on the isolated root.
       */
      /** The one receiver this wiring owns, handed out unstarted; start it from the E commands. */
      receiver: control,
    }),
  });
}
