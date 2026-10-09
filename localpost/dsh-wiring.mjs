import path from 'node:path';
import { assertId } from './fs-safe.mjs';
import { createSessionStore } from './session-binding.mjs';
import { createMailbox } from './mailbox.mjs';
import { createBindingProvider } from './binding-provider.mjs';
import { attestedCommandCaller, COMMANDS, createDshHostBridge, describeOrExplain, registerBindingCommands, statusText, SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { createMailTools } from './dsh-mail-tools.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { createDshAdapter } from './dsh-adapter.mjs';
import { createReceiver } from './receiver.mjs';
import { IDENTITY_PATTERN, createChatIdentity } from './chat-identity.mjs';

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
 *   - the registrations (the three shared commands, mail tools with their guard, E commands) are one transaction:
 *     any failure releases what was registered, in reverse order, and returns a refusal;
 *   - the receiver is owned here and handed out unstarted: on the isolated entry only the E human commands start it,
 *     so live E1-E6 stay a separately authorized step, not a side effect of loading a plugin;
 *   - dispose stops the receiver and then releases every registration, even when stopping fails.
 *
 * One host can serve further identities next to its own (`config.identities`, default none; design and threat
 * analysis in docs/multi-identity.md). Each gets its own lane - mailbox, bridge, acceptance ledger, adapter, receiver -
 * and its own strict sender list. The human commands (/localpost-bind, /localpost-unbind, /localpost-status) and the
 * mail tools are one set for the whole host and act on the identity the calling chat speaks for (chat-identity.mjs);
 * only switching the mail chat may name an identity, because becoming its mail chat is what it does. Without further
 * identities everything below behaves exactly as the single-identity wiring did.
 *
 * 2026-10-09 (user decision): the production entry has no receiver commands any more - its receivers start with an
 * automatic binding (autoStart, on by default there) - and the mail chat is switched in plain language or with the three
 * shared commands. The 14 per-identity commands it used to register were more than anyone could keep apart.
 *
 * Status `ready_for_live_E` means the code is ready for the live run. It is not evidence that E1-E6
 * ran, and it is not permission to enable production dispatch.
 */
export const ISOLATED_ROOT = 'C:/AI_ASSIST/work/localpost-e-test';
export const PRODUCTION_ROOT = 'C:/AI_ASSIST/.mailbox';
export const WIRING_STATUS = 'ready_for_live_E';
export const E_COMMANDS = Object.freeze({ start: 'localpost-e-start', stop: 'localpost-e-stop', status: 'localpost-e-status' });
// 生产自动收信（2026-10-05 用户放行）：同一套装配，只有"根"不同；receiver 随绑定自启，没有控制命令（2026-10-09）。
// 隔离入口拒绝生产根、生产入口拒绝隔离根——两个方向都 fail closed，永不会互相串。
export const PRODUCTION_WIRING_STATUS = 'ready_for_live_production';

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

/**
 * Whether the production entry starts receivers with an automatic binding: on unless the profile row says `autoStart: false`
 * or the environment says DSH_LOCALPOST_AUTO_START=0 (2026-10-09: the production entry has no receiver commands any more,
 * so off by default would mean a receiver nothing can start).
 */
export function autoStartConfig(value, environment) {
  return value !== false && environment !== '0';
}

/**
 * The further identities as the profile carries them: a map from identity to its own settings, for example
 * `identities: { engineer: { allowFrom: 'dsh,codex' } }`. Like allowFromConfig this only reshapes - every check is in
 * createWiring - so a malformed entry reaches validation and refuses the wiring instead of vanishing.
 */
export function identitiesConfig(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.entries(value).map(([identity, settings]) => ({
    identity,
    allowFrom: typeof settings?.allowFrom === 'string' ? allowFromConfig(settings.allowFrom) : settings?.allowFrom,
  }));
}

/**
 * The receiver commands of one identity. Only the isolated acceptance entry has them (live E1-E6 are started by hand
 * there): the host's own identity keeps the historical names and a further identity gets its name after the prefix
 * (`/localpost-engineer-e-start`). The production entry has none - its receivers start with an automatic binding.
 */
export function identityCommands(kind, identity, primary = 'dsh') {
  if (kind === 'production') return Object.freeze({ actions: Object.freeze({}) });
  if (identity === primary) return Object.freeze({ actions: E_COMMANDS });
  const named = name => name.replace(/^localpost-/, 'localpost-' + identity + '-');
  return Object.freeze({ actions: Object.freeze({ start: named(E_COMMANDS.start), stop: named(E_COMMANDS.stop), status: named(E_COMMANDS.status) }) });
}

/** A refusal that registered nothing and disposes nothing, so callers can treat every shape alike. */
function refused(reason, decisions, detail, status = WIRING_STATUS) {
  return Object.freeze({ enabled: false, status, reason, ...(detail === undefined ? {} : { detail }),
    decisions: Object.freeze([...decisions]), dispose: () => {} });
}

/**
 * @param {{ctx?: object, config?: {enabled?: boolean, root?: string, allowFrom?: string[], scanIntervalMs?: number, debounceMs?: number,
 *     autoStart?: boolean, identities?: {identity: string, allowFrom: string[]}[]},
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
 * 注册的是三条共用命令 + 邮件工具（含切换收信聊天的两个）+ guard；没有 receiver 控制命令——
 * receiver 随自动绑定自启（autoStart 在生产默认开），状态串是 `ready_for_live_production`。
 */
export function createProductionWiring(input = {}) {
  return createWiring({ ...input, kind: 'production' });
}

function createWiring({ kind = 'isolated', ctx, config = {}, runtimeVersion, versionEvidence, identity = 'dsh', hostId = 'local',
  isolatedRoot = ISOLATED_ROOT, productionRoot = PRODUCTION_ROOT, receiverFactory = createReceiver } = {}) {
  const isProduction = kind === 'production';
  const wiringStatus = isProduction ? PRODUCTION_WIRING_STATUS : WIRING_STATUS;
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

  /*
   * Further identities (default none). Each is a name a command can carry, distinct from the primary and from every other,
   * with its own sender list checked exactly like the primary's: nothing is inherited, so the list that runs for an
   * identity is the list written for it. Every command name must be unique, so no identity's E commands can take another
   * command's name.
   */
  const extras = config?.identities === undefined || config?.identities === null ? [] : config.identities;
  if (!Array.isArray(extras)) return refuse('identities_invalid');
  const plans = [{ identity, allowFrom: [...allowFrom] }];
  for (const entry of extras) {
    const name = entry?.identity;
    if (typeof name !== 'string' || !IDENTITY_PATTERN.test(name)) return refuse('identity_invalid', String(name));
    if (plans.some(plan => plan.identity === name)) return refuse('identity_duplicate', name);
    const senders = entry.allowFrom;
    if (senders === undefined || (Array.isArray(senders) && senders.length === 0)) return refuse('identity_allow_from_required', name);
    if (!Array.isArray(senders) || !senders.every(sender => typeof sender === 'string' && safeId(sender))) return refuse('identity_allow_from_invalid', name);
    plans.push({ identity: name, allowFrom: [...senders] });
  }
  for (const plan of plans) plan.names = identityCommands(kind, plan.identity, identity);
  const commandNames = [...Object.values(COMMANDS), ...plans.flatMap(plan => Object.values(plan.names.actions))];
  if (new Set(commandNames).size !== commandNames.length) return refuse('identity_command_conflict');
  if (plans.length > 1) decisions.push('identities_validated');

  // The control commands are guarded against shadowing through the host's own lookup, so it is a required capability.
  if (typeof ctx?.commands?.find !== 'function') return refuse('e_lookup_unavailable');

  let disposed = false;
  /*
   * With several identities a bind must not make a chat speak for two. Binds of this host run one at a time, so the check
   * and the binding it admits cannot interleave with another bind; a binding that cannot be read refuses (fail closed).
   * Even if a binding were written behind the plugin's back, chat-identity.mjs refuses a chat named by two identities.
   */
  let chatIdentity = null;
  let bindQueue = Promise.resolve();
  const admitBindFor = target => (caller, proceed) => {
    const decide = async () => {
      let other;
      try { other = await chatIdentity.otherIdentityOf(caller, target); }
      catch (error) { return { ok: false, reason: 'identity_unresolved', message: errorText(error) }; }
      if (other !== null) return { ok: false, reason: 'chat_speaks_for_other_identity', identity: other };
      return proceed();
    };
    const next = bindQueue.then(decide, decide);
    bindQueue = next.catch(() => {});
    return next;
  };

  /*
   * Everything that can fail without side effects is built before the first registration - every identity's receiver
   * included. One session store serves all identities (it keys every document by identity); each identity gets its own
   * mailbox, bridge, acceptance ledger, adapter and receiver, so nothing in one identity's lane can act for another.
   */
  let store, tools, laneOf, statusFor;
  const lanes = [];
  try {
    store = createSessionStore({ root });
    for (const plan of plans) {
      const lane = { identity: plan.identity, names: plan.names };
      lane.mailbox = createMailbox({ root, identity: plan.identity });
      // A switch to automatic routing starts the lane's receiver at once instead of at the host's next poll.
      lane.bridge = createDshHostBridge({ ctx, runtimeVersion, store, identity: plan.identity, hostId,
        ...(plans.length > 1 ? { admitBind: admitBindFor(plan.identity) } : {}),
        onChange: () => { void lane.retryAutoStart?.(); } });
      const acceptance = createLedgerAcceptance({ store, identity: plan.identity });
      lane.adapter = createDshAdapter({ ctx, runtimeVersion, hostId, mailboxAgent: plan.identity, acceptance,
        bindingProvider: createBindingProvider({ store, identity: plan.identity, host: lane.bridge }) });
      lane.receiver = receiverFactory({ root, agent: plan.identity, allowFrom: [...plan.allowFrom], adapter: lane.adapter, scanIntervalMs, debounceMs });
      lanes.push(lane);
    }
    if (lanes.length > 1) chatIdentity = createChatIdentity({ store, primary: identity, identities: lanes.slice(1).map(lane => lane.identity) });
    const laneByIdentity = new Map(lanes.map(lane => [lane.identity, lane]));
    laneOf = chatIdentity === null ? async () => lanes[0] : async caller => laneByIdentity.get(await chatIdentity.identityOf(caller));
    // Who receives each identity's mail, with its receiver's state; the same text for /localpost-status and localpost_status.
    statusFor = async caller => statusText(await Promise.all(lanes.map(async lane => ({ ...(await describeOrExplain(lane.bridge)), receiver: lane.control?.status() }))), caller);
    // One tool set for every identity: each call works on the lane of the identity the attested caller speaks for.
    tools = createMailTools({ ctx, mailbox: lanes[0].mailbox, store, identity, runtimeVersion, hostId, bridge: lanes[0].bridge, lanes, status: statusFor,
      ...(chatIdentity === null ? {} : { resolve: laneOf }) });
  } catch (error) {
    return refuse('build_failed', errorText(error));
  }
  decisions.push('built');

  // The control names are checked with the host before anything is registered; an unreadable lookup is not "free".
  for (const name of lanes.flatMap(lane => Object.values(lane.names.actions))) {
    let existing;
    try { existing = ctx.commands.find(undefined, name); }
    catch (error) { return refuse('e_lookup_failed', name + ': ' + errorText(error)); }
    if (existing !== undefined) return refuse('e_command_name_taken', name);
  }

  /*
   * One receiver per identity, each with one watcher, one interval, one owner. Constructing it touched nothing; only
   * start() scans. Every start/stop of a lane runs through that lane's queue, so concurrent calls queue instead of
   * racing its watcher, and no lane's commands reach another lane's receiver.
   */
  const controlFor = lane => {
    const { receiver } = lane;
    let running = false;
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
    const status = () => Object.freeze({ ...receiver.diagnostics(), owned: true, running, disposed, root, identity: lane.identity,
      ...(lastStartError === null ? {} : { lastStartError: errorText(lastStartError) }),
      ...(lastStopError === null ? {} : { lastStopError: errorText(lastStopError) }),
      ...(shutdownError === null ? {} : { shutdownError: errorText(shutdownError) }) });
    const control = Object.freeze({
      /** Starts the lane's single watcher; repeat and concurrent calls start it once. A failed start is never reported running. */
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
    return { control, running: () => running, startedBy: () => startedBy, keepShutdownError: error => { shutdownError = error; } };
  };
  for (const lane of lanes) Object.assign(lane, controlFor(lane));

  /*
   * The E entry points (isolated acceptance only) are human commands: no model-callable tool can start the isolated
   * receiver. Each one first proves that the definition the host resolves for this very agent is the one registered here
   * (a scoped command can shadow a global one), then that the host attests the caller. Start needs the lane's bound chat
   * under an active, automatic binding; stop and status are open to that bound chat in any binding state and to the chat
   * that started the lane's running receiver, so a receiver can always be stopped - and unloading the plugin stops every
   * lane in any case.
   */
  const handlers = new Map();
  const effectiveIsOurs = (name, invocation) => {
    try { return ctx.commands.find(invocation?.agent, name)?.handler === handlers.get(name); } catch { return false; }
  };
  const sameChat = (session, caller) => caller !== null && session?.host === caller.host && session?.id === caller.session &&
    (session?.cwd ?? null) === caller.cwd;
  const mayStart = (state, caller) => sameChat(state?.binding?.session, caller) && state.binding.state === 'active' && state.binding.mode === 'auto';
  const mayControlFor = lane => (state, caller) => {
    const starter = lane.startedBy();
    return sameChat(state?.binding?.session, caller) || (starter !== null && sameChat({ host: starter.host, id: starter.session, cwd: starter.cwd }, caller));
  };
  const defineAction = (lane, name, description, allowed, refusalText, act) => {
    const handler = async invocation => {
      if (!effectiveIsOurs(name, invocation)) return { kind: 'error', text: 'LocalPost: /' + name + ' 被其他定义遮蔽或无法解析，未执行任何操作（shadowed）。' };
      const caller = attestedCommandCaller(invocation, ctx.agents, hostId);
      if (!caller) return { kind: 'error', text: 'LocalPost: 无法证明调用者身份，已拒绝。' };
      let state = null;
      let unreadable = null;
      try { state = await store.read(lane.identity); } catch (error) { unreadable = error; }
      if (!allowed(state, caller)) return { kind: 'error', text: 'LocalPost: ' + refusalText + (unreadable === null ? '' : '（绑定状态无法读取：' + errorText(unreadable) + '）') };
      try { return { kind: 'success', text: label + ': ' + JSON.stringify(await act(caller)) }; }
      catch (error) { return { kind: 'error', text: label + ': ' + errorText(error) }; }
    };
    handlers.set(name, handler);
    return { name, description, recordInput: false, handler };
  };
  const actionDefinitions = isProduction ? [] : lanes.flatMap(lane => {
    const { actions } = lane.names;
    const whose = lane.identity === identity ? '' : ' ' + lane.identity + ' 的';
    const mayControl = mayControlFor(lane);
    return [
      defineAction(lane, actions.start, '启动' + whose + subject + ' receiver（仅已绑定且处于自动模式的聊天、无参数）。', mayStart,
        '只有已绑定且处于自动模式的聊天可以启动' + whose + subject + ' receiver。', caller => lane.control.start(caller)),
      defineAction(lane, actions.stop, '停止' + whose + subject + ' receiver（已绑定聊天或启动它的聊天、无参数）。', mayControl,
        '只有已绑定的聊天或启动它的聊天可以停止' + whose + subject + ' receiver。', () => lane.control.stop()),
      defineAction(lane, actions.status, '查看' + whose + subject + ' receiver 状态（已绑定聊天或启动它的聊天、无参数）。', mayControl,
        '只有已绑定的聊天或启动它的聊天可以查看' + whose + subject + ' receiver。', () => lane.control.status()),
    ];
  });

  // One transaction: the three shared commands, the mail tools with their guard, then every lane's E commands. Any
  // failure releases everything registered so far, in reverse order, and the caller gets a refusal instead of a
  // half-registered wiring.
  const disposers = [];
  const release = () => { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* release is best effort */ } } };
  try {
    // A host that cannot attest a chat gets no command at all (every lane shares this host, so the first one decides).
    const commands = lanes[0].bridge.capabilities.chatBinding !== true ? { ok: false, reason: 'host_cannot_attest' }
      : registerBindingCommands({ ctx, hostId, resolve: async caller => (await laneOf(caller)).bridge, status: statusFor });
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
   * "绑定后自启"（config.autoStart）：每个身份各读一次自己的绑定状态，只有已存在 active + auto 的绑定时才启动该身份的
   * receiver。目的：让"重启后仍然自动收信"成立，人工步骤只剩一次绑定。生产入口默认开（没有 receiver 命令了，
   * 写 autoStart: false 才关）；隔离入口默认关（E 命令手动启动）。
   *
   * 绑定通常发生在装配**之后**，所以这里除了首次尝试，还对外暴露每个身份的 retryAutoStart()：宿主用
   * ctx.setInterval 定期调用它，桥在绑定/恢复/接管成功后也立即调一次（onChange）。首次成功返回 'started'，
   * 之后返回 'already_running'（宿主据此只记一条日志，不刷屏）。
   */
  const autoStartFor = lane => {
    let autoStarted = false;
    return async () => {
      if (disposed) return 'disposed';
      if (lane.running()) return 'already_running';
      try {
        const state = await store.read(lane.identity);
        const binding = state?.binding;
        if (!binding || binding.state !== 'active' || binding.mode !== 'auto') return 'skipped_unbound';
        await lane.control.start(null);
        const first = !autoStarted;
        autoStarted = true;
        return first ? 'started' : 'already_running';
      } catch (error) {
        return 'failed: ' + errorText(error);
      }
    };
  };
  const autoStartOn = isProduction ? config?.autoStart !== false : config?.autoStart === true;
  if (autoStartOn) decisions.push('auto_start_scheduled');
  for (const lane of lanes) {
    lane.retryAutoStart = autoStartOn ? autoStartFor(lane) : async () => 'disabled';
    lane.autoStart = autoStartOn ? lane.retryAutoStart() : Promise.resolve('disabled');
  }

  /*
   * Stops every lane's receiver - each after whatever start/stop is queued on it - and then releases every registration,
   * even if stopping fails; a lane's failure is kept and shown by its status().shutdownError, and does not keep the other
   * lanes running. Idempotent, and no start is admitted from here on. Cordis rc.2 awaits a Promise returned by an effect
   * disposer (fiber unload runs runDisposable), so the host waits for all of it.
   */
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise === null) {
      disposed = true;
      shutdownPromise = (async () => {
        try {
          for (const lane of lanes) {
            try { await lane.control.stop(); } catch (error) { lane.keepShutdownError(error); }
          }
        } finally { release(); }
      })();
    }
    return shutdownPromise;
  };

  decisions.push(lanes.every(lane => lane.adapter.capabilities.trustedBinding) ? 'adapter_binding_trusted' : 'adapter_binding_untrusted');

  const [primary] = lanes;
  return Object.freeze({
    enabled: true, status: wiringStatus, decisions: Object.freeze([...decisions]), dispose: shutdown,
    parts: Object.freeze({
      root, store, bridge: primary.bridge, tools, adapter: primary.adapter, kind,
      capabilities: Object.freeze({ ...tools.capabilities(), adapter: primary.adapter.capabilities }),
      diagnostics: () => primary.adapter.diagnostics(),
      versionEvidence,
      /** The three human commands, shared by every identity (dsh-host-bridge.mjs). */
      commands: COMMANDS,
      /** The host identity's receiver, handed out unstarted: production starts it with an automatic binding, isolated E by hand. */
      receiver: primary.control,
      /** 'disabled' | 'skipped_unbound' | 'started' | 'already_running' | 'failed: …' —— autoStart 关着时恒为 'disabled'。 */
      autoStart: primary.autoStart,
      /** 宿主定期调用：绑定出现后自动启动 receiver（autoStart 关着时恒为 'disabled'）。 */
      retryAutoStart: primary.retryAutoStart,
      /** Every identity's lane, the host's own first: its E command names (isolated only), receiver control and auto-start. */
      identities: Object.freeze(Object.fromEntries(lanes.map(lane => [lane.identity, Object.freeze({
        identity: lane.identity, commands: lane.names, receiver: lane.control, autoStart: lane.autoStart, retryAutoStart: lane.retryAutoStart,
      })]))),
    }),
  });
}
