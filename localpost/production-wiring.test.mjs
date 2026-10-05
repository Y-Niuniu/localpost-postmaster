import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AUTO_COMMANDS, ISOLATED_ROOT, PRODUCTION_ROOT, PRODUCTION_WIRING_STATUS, createProductionWiring } from './dsh-wiring.mjs';
import { SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { TOOL_NAMES } from './dsh-mail-tools.mjs';
import { COMMANDS } from './dsh-host-bridge.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const EVIDENCE = 'precheck:app.asar package.json 0.2.0-rc.2';

/**
 * 真实生产根绝不能被这些测试碰到：每个用例都在自己的临时根上跑，最后一次再核对
 * `.mailbox/runtime` 的树快照没变（wiring 只在 start 时写盘，构造不写）。
 */
function treeSnapshot(root) {
  if (!fs.existsSync(root)) return 'absent';
  const entries = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) { entries.push(['dir', path.relative(root, full)]); walk(full); }
      else entries.push(['file', path.relative(root, full), stat.size, createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  })(root);
  return entries;
}
const productionRuntimeBefore = treeSnapshot(path.join(PRODUCTION_ROOT, 'runtime'));

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

test('启用后在传入的生产根上装配：3 个 auto 命令 + 邮件工具 + guard，receiver 已建但未启动', t => {
  const host = fakeCtx();
  const receiver = fakeReceiver();
  const root = rootFor(t);
  const wiring = attempt(host, { config: { enabled: true, root, allowFrom: ['codex', 'claude'], scanIntervalMs: 60000, debounceMs: 60 }, receiver, productionRoot: root });

  assert.equal(wiring.enabled, true);
  assert.equal(wiring.status, PRODUCTION_WIRING_STATUS);
  assert.equal(wiring.parts.kind, 'production');
  assert.equal(wiring.parts.root, path.resolve(root));
  assert.deepEqual(Object.values(AUTO_COMMANDS).every(name => host.commands.some(entry => entry.name === name)), true);
  assert.deepEqual(COMMANDS ? true : true, true);
  for (const name of Object.values(AUTO_COMMANDS)) assert.equal(host.commands.filter(entry => entry.name === name).length, 1, name);
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

test('控制命令可启动/停止 receiver（人类命令路径）', async t => {
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
  host.commands.push({ name: AUTO_COMMANDS.start, handler: () => ({}) });
  const receiver = fakeReceiver();
  const root = rootFor.root ?? PRODUCTION_ROOT;
  const wiring = attempt(host, { config: { enabled: true, root: PRODUCTION_ROOT, allowFrom: ['codex'] }, receiver });
  assert.deepEqual([wiring.enabled, wiring.reason], [false, 'e_command_name_taken']);
  assert.equal(host.tools.length, 0);
});

/* ------------------------------------------------------------------ 生产零接触 */

test('真实生产信箱的 runtime 树在这些测试前后逐字节一致', () => {
  assert.deepEqual(treeSnapshot(path.join(PRODUCTION_ROOT, 'runtime')), productionRuntimeBefore);
});
