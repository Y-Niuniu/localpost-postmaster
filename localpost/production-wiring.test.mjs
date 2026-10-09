import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { watch, writesUnder } from './fixtures/production-write-witness.mjs';
import { ISOLATED_ROOT, PRODUCTION_ROOT, PRODUCTION_WIRING_STATUS, autoStartConfig, createProductionWiring } from './dsh-wiring.mjs';
import { SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { TOOL_NAMES } from './dsh-mail-tools.mjs';
import { COMMANDS } from './dsh-host-bridge.mjs';
import { bindFromChatAction } from './binding-provider.mjs';
import { createSessionStore } from './session-binding.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const EVIDENCE = 'precheck:app.asar package.json 0.2.0-rc.2';

/**
 * 真实生产根绝不能被这些测试碰到：每个用例都在自己的临时根上跑，最后断言本进程从没往生产根写过
 * （wiring 只在 start 时写盘，构造不写）。原先用 `.mailbox/runtime` 整树快照核对；生产 receiver 上线后它会
 * 定时重写 queues/dsh.json，快照会被真实流量随机打红，所以改成调用期写入见证（见 fixtures/production-write-witness.mjs）。
 */
watch(PRODUCTION_ROOT);

const TMP = path.resolve(import.meta.dirname, '../.localpost-tmp/production-wiring');
function rootFor(t) {
  fs.mkdirSync(TMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP, 'case-'));
  // 生产根要长得像信箱根：wiring 只解析路径，不要求目录已存在；建出 agents/ 更贴近真实。
  fs.mkdirSync(path.join(root, 'agents', 'dsh', 'inbox'), { recursive: true });
  t.after(() => removeTreeSync(root));
  return root;
}

/** 与 dsh-wiring.test.mjs 同形的假宿主：命令/工具注册表 + 可注入的查找失败。 */
function fakeCtx() {
  const host = { commands: [], tools: [], guards: [], agents: new Map(), failRegister: null };
  const register = (list, kind) => definition => {
    if (list.some(entry => entry.name === definition.name)) throw new Error(`${kind} "${definition.name}" is already registered`);
    if (host.failRegister === definition.name) throw new Error('registry refused ' + definition.name);
    list.push(definition);
    return () => { const at = list.indexOf(definition); if (at >= 0) list.splice(at, 1); };
  };
  host.ctx = {
    agents: { get: id => host.agents.get(id) },
    commands: {
      register: register(host.commands, 'command'),
      find: (agent, name) => host.commands.find(entry => entry.name === name),
    },
    tools: {
      register: register(host.tools, 'tool'),
      get: name => host.tools.find(entry => entry.name === name),
      guard: check => { host.guards.push(check); return () => { const at = host.guards.indexOf(check); if (at >= 0) host.guards.splice(at, 1); }; },
    },
  };
  return host;
}
const counts = host => [host.commands.length, host.tools.length, host.guards.length];

function fakeReceiver() {
  const seen = { construct: 0, start: 0, stop: 0, options: null };
  const factory = options => {
    seen.construct += 1;
    seen.options = options;
    let watching = false;
    return {
      async start() { seen.start += 1; watching = true; },
      async stop() { seen.stop += 1; watching = false; },
      diagnostics: () => ({ running: watching, dispatchEnabled: false, lastError: undefined }),
    };
  };
  return { factory, seen };
}

function attempt(host, { config = {}, receiver = null, productionRoot, runtimeVersion = SUPPORTED_VERSION, versionEvidence = EVIDENCE } = {}) {
  return createProductionWiring({
    ctx: host.ctx, runtimeVersion, versionEvidence,
    ...(productionRoot === undefined ? {} : { productionRoot }),
    ...(receiver === null ? {} : { receiverFactory: receiver.factory }),
    config,
  });
}

/* ------------------------------------------------------------------ 默认与根判定 */

test('生产入口默认关闭：没有显式开关时什么都不注册', () => {
  const host = fakeCtx();
  const bare = attempt(host, {});
  assert.deepEqual([bare.enabled, bare.reason, bare.status], [false, 'disabled_by_default', PRODUCTION_WIRING_STATUS]);
  bare.dispose();
  for (const config of [{}, { enabled: false }, { enabled: false, root: PRODUCTION_ROOT }]) {
    const wiring = attempt(host, { config });
    assert.deepEqual([wiring.enabled, wiring.reason, wiring.status], [false, 'disabled_by_default', PRODUCTION_WIRING_STATUS]);
    assert.deepEqual(counts(host), [0, 0, 0]);
    wiring.dispose();
  }
});

test('隔离根（及任何非生产根）一律拒绝：方向与隔离入口相反，同样 fail closed', () => {
  const host = fakeCtx();
  const receiver = fakeReceiver();
  for (const root of [ISOLATED_ROOT, ISOLATED_ROOT.toLowerCase(), ISOLATED_ROOT + '/agents/dsh/inbox'])
    assert.deepEqual([attempt(host, { config: { enabled: true, root, allowFrom: ['codex'] }, receiver }).reason], ['isolated_root_refused'], root);
  for (const [root, reason] of [['', 'root_invalid'], ['C:/AI_ASSIST/work', 'root_not_production'],
    [PRODUCTION_ROOT + '/agents/dsh', 'root_not_production'], [PRODUCTION_ROOT + '-e', 'root_not_production']])
    assert.deepEqual([attempt(host, { config: { enabled: true, root, allowFrom: ['codex'] }, receiver }).reason], [reason], root);
  assert.deepEqual(counts(host), [0, 0, 0]);
});

test('发件人白名单与时间参数在构建前就校验：空/非法一律拒绝', () => {
  const host = fakeCtx();
  const receiver = fakeReceiver();
  const base = { enabled: true, root: PRODUCTION_ROOT };
  for (const allowFrom of [undefined, [], 'codex'.split(',').slice(0, 0)])
    assert.deepEqual([attempt(host, { config: { ...base, allowFrom }, receiver }).reason], ['allow_from_required'], JSON.stringify(allowFrom));
  for (const allowFrom of [[''], [' codex'], ['codex '], ['../etc'], [42], 'codex'])
    assert.deepEqual([attempt(host, { config: { ...base, allowFrom }, receiver }).reason], ['allow_from_invalid'], JSON.stringify(allowFrom));
  for (const scanIntervalMs of [0, 999, 3600001, 1.5])
    assert.deepEqual([attempt(host, { config: { ...base, allowFrom: ['codex'], scanIntervalMs }, receiver }).reason], ['scan_interval_invalid'], String(scanIntervalMs));
  for (const debounceMs of [0, 49, 600001, 1.5])
    assert.deepEqual([attempt(host, { config: { ...base, allowFrom: ['codex'], debounceMs }, receiver }).reason], ['debounce_invalid'], String(debounceMs));
  assert.deepEqual(counts(host), [0, 0, 0]);
});

test('运行时版本与版本证据同样是硬门禁', () => {
  const host = fakeCtx();
  const config = { enabled: true, root: PRODUCTION_ROOT, allowFrom: ['codex'] };
  assert.deepEqual([attempt(host, { config, runtimeVersion: '0.0.0' }).reason], ['runtime_version_mismatch']);
  assert.deepEqual([attempt(host, { config, versionEvidence: '' }).reason], ['version_evidence_missing']);
  assert.deepEqual(counts(host), [0, 0, 0]);
});

/* ------------------------------------------------------------------ 正常装配 */

test('启用后在传入的生产根上装配：只有 3 条共用命令 + 邮件工具 + guard，receiver 已建但未启动', t => {
  const host = fakeCtx();
  const receiver = fakeReceiver();
  const root = rootFor(t);
  const wiring = attempt(host, { config: { enabled: true, root, allowFrom: ['codex', 'claude'], scanIntervalMs: 60000, debounceMs: 60 }, receiver, productionRoot: root });

  assert.equal(wiring.enabled, true);
  assert.equal(wiring.status, PRODUCTION_WIRING_STATUS);
  assert.equal(wiring.parts.kind, 'production');
  assert.equal(wiring.parts.root, path.resolve(root));
  assert.deepEqual(host.commands.map(entry => entry.name).sort(), Object.values(COMMANDS).sort(), '没有 receiver 启停命令，也没有 auto-arm');
  assert.deepEqual(wiring.parts.commands, COMMANDS);
  assert.equal(host.tools.length, TOOL_NAMES.length);
  assert.equal(host.guards.length, 1);
  assert.equal(receiver.seen.construct, 1);
  assert.deepEqual([receiver.seen.options.root, receiver.seen.options.agent, receiver.seen.options.allowFrom], [path.resolve(root), 'dsh', ['codex', 'claude']]);
  assert.equal(receiver.seen.start, 0, 'receiver 必须交出去时仍未启动');
  assert.equal(receiver.seen.stop, 0);
  assert.equal(wiring.parts.receiver.status().running, false);
  assert.equal(wiring.decisions.includes('production_root_confirmed'), true);
  assert.equal(wiring.decisions.includes('isolated_root_confirmed'), false);

  return wiring.dispose().then(() => {
    assert.deepEqual(counts(host), [0, 0, 0], 'dispose 必须释放全部注册');
    // 从未启动过：stop 是 no-op（幂等），不能凭空调用 receiver.stop。
    assert.equal(receiver.seen.stop, 0);
    assert.equal(wiring.parts.receiver.status().disposed, true);
  });
});

test('receiver 控制对象可启动/停止（自启与卸载走的就是它）', async t => {
  const host = fakeCtx();
  const receiver = fakeReceiver();
  const root = rootFor(t);
  const wiring = attempt(host, { config: { enabled: true, root, allowFrom: ['codex'] }, receiver, productionRoot: root });
  assert.equal(wiring.parts.receiver.status().running, false);
  await wiring.parts.receiver.start(null);
  assert.equal(receiver.seen.start, 1);
  assert.equal(wiring.parts.receiver.status().running, true);
  await wiring.parts.receiver.stop();
  assert.equal(receiver.seen.stop, 1);
  assert.equal(wiring.parts.receiver.status().running, false);
  await wiring.dispose();
});

test('命令名被占用时拒绝装配（与隔离入口同名工具/命令互斥）', () => {
  const host = fakeCtx();
  host.commands.push({ name: COMMANDS.bind, handler: () => ({}) });
  const receiver = fakeReceiver();
  const wiring = attempt(host, { config: { enabled: true, root: PRODUCTION_ROOT, allowFrom: ['codex'] }, receiver });
  assert.deepEqual([wiring.enabled, wiring.reason, wiring.detail], [false, 'commands_command_name_taken', COMMANDS.bind]);
  assert.equal(host.tools.length, 0);
  assert.deepEqual(host.commands.map(entry => entry.name), [COMMANDS.bind], '只剩原来占名的那一条');
});

/* ------------------------------------------------------------------ 绑定后自启 */

test('autoStart：已有 active+auto 绑定时装配即自启；未绑定时跳过', async t => {
  // 未绑定：不启动（receiver 跑了也没有路由）
  const cold = fakeCtx();
  const coldReceiver = fakeReceiver();
  const coldRoot = rootFor(t);
  const coldWiring = attempt(cold, { config: { enabled: true, root: coldRoot, allowFrom: ['codex'], autoStart: true }, receiver: coldReceiver, productionRoot: coldRoot });
  assert.equal(await coldWiring.parts.autoStart, 'skipped_unbound');
  assert.equal(coldReceiver.seen.start, 0);
  assert.equal(coldWiring.parts.receiver.status().running, false);
  assert.equal(coldWiring.decisions.includes('auto_start_scheduled'), true);
  // 装配之后才绑定（真实顺序：用户那一刻才敲 /localpost-bind）⇒ 宿主轮询 retryAutoStart 就能自启
  const lateHost = createFakeDshHost({ root: coldRoot });
  lateHost.openThread('chat-late', 'C:/work/late');
  assert.equal((await bindFromChatAction(createSessionStore({ root: coldRoot }), 'dsh',
    { host: lateHost, action: lateHost.userBindAction('chat-late'), authority: { scope: 'analysis-reply', source: 'policy:test' } })).ok, true);
  assert.equal(await coldWiring.parts.retryAutoStart(), 'started');
  assert.equal(coldReceiver.seen.start, 1);
  assert.equal(coldWiring.parts.receiver.status().running, true);
  assert.equal(await coldWiring.parts.retryAutoStart(), 'already_running', '重复轮询只报一次 started');
  assert.equal(coldReceiver.seen.start, 1, 'start 幂等');
  await coldWiring.dispose();

  // 已绑定（走真实绑定路径 + 假宿主）：装配即启动
  const host = fakeCtx();
  const receiver = fakeReceiver();
  const root = rootFor(t);
  const fakeHost = createFakeDshHost({ root });
  fakeHost.openThread('chat-a', 'C:/work/project-a');
  const bound = await bindFromChatAction(createSessionStore({ root }), 'dsh',
    { host: fakeHost, action: fakeHost.userBindAction('chat-a'), authority: { scope: 'analysis-reply', source: 'policy:test' } });
  assert.equal(bound.ok, true);
  const wiring = attempt(host, { config: { enabled: true, root, allowFrom: ['codex'], autoStart: true }, receiver, productionRoot: root });
  assert.equal(await wiring.parts.autoStart, 'started');
  assert.equal(receiver.seen.start, 1);
  assert.equal(wiring.parts.receiver.status().running, true);
  await wiring.dispose();
});

test('插件配置里的 autoStart：默认开，只有 false 或环境变量 0 才关', () => {
  assert.deepEqual([autoStartConfig(undefined, undefined), autoStartConfig(true, undefined), autoStartConfig('yes', undefined)], [true, true, true]);
  assert.deepEqual([autoStartConfig(false, undefined), autoStartConfig(undefined, '0'), autoStartConfig(true, '0')], [false, false, false]);
  assert.equal(autoStartConfig(undefined, '1'), true);
});

test('生产的 autoStart 默认开（没有启停命令了）；明确写 false 才关', async t => {
  for (const [autoStart, expected] of [[undefined, 'skipped_unbound'], [true, 'skipped_unbound'], [false, 'disabled']]) {
    const root = rootFor(t);
    const wiring = attempt(fakeCtx(), { config: { enabled: true, root, allowFrom: ['codex'], ...(autoStart === undefined ? {} : { autoStart }) },
      receiver: fakeReceiver(), productionRoot: root });
    assert.equal(await wiring.parts.autoStart, expected, String(autoStart));
    assert.equal(wiring.decisions.includes('auto_start_scheduled'), autoStart !== false, String(autoStart));
    await wiring.dispose();
  }
});

/* ------------------------------------------------------------------ 生产零接触 */

test('写入见证自检：真实绑定路径的写盘确实被见证到（临时根代替生产根）', async t => {
  const probe = rootFor(t);
  const stop = watch(probe);
  const fakeHost = createFakeDshHost({ root: probe });
  fakeHost.openThread('chat-probe', 'C:/work/probe');
  try {
    assert.equal((await bindFromChatAction(createSessionStore({ root: probe }), 'dsh',
      { host: fakeHost, action: fakeHost.userBindAction('chat-probe'), authority: { scope: 'analysis-reply', source: 'policy:test' } })).ok, true);
  } finally { stop(); }
  assert.equal(writesUnder(probe).some(line => line.includes('sessions')), true, '绑定写盘没有被见证到：见证失效');
});

test('本进程从未写过真实生产信箱（调用期见证；生产 receiver 自己的定时重写不算在内）', () => {
  assert.deepEqual(writesUnder(PRODUCTION_ROOT), []);
});
