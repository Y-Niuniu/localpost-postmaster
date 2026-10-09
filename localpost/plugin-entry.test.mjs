import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeTreeSync } from './temp-tree.mjs';
import { watch, writesUnder } from './fixtures/production-write-witness.mjs';
import { PRODUCTION_ROOT } from './dsh-wiring.mjs';

// 这些用例在 canonical 生产根上装配（只装配不启动），所以用调用期见证核对"本进程从没往生产根写过"（最后一个用例）。
watch(PRODUCTION_ROOT);

/**
 * 插件入口冒烟测试（2026-10-05 补）。
 *
 * 起因：生产接线里 `row` 声明在 try 块内、块外又引用一次，触发 ReferenceError，整个 fiber 加载失败 ——
 * 不只是接线没起来，**连内核定时器都不跑了**；当时没有任何测试能发现，因为单测都跑在接线"未启用"的分支上。
 *
 * 这里的 enabled 用例故意**只装配不启动**（autoStart: false），并对 canonical 生产根只读：装配不写盘
 * （wiring 的设计保证），因此不会碰生产数据；而那个 ReferenceError 无论 autoStart 真假都会抛，照样被抓住。
 * 2026-10-09 起生产的 autoStart 默认开，所以这里必须**显式**写 autoStart: false —— 否则真实绑定一旦是 auto，
 * 跑测试就会在真实信箱上起一个真 receiver（下面有用例把这一点钉住）。
 */
const TMP = path.resolve(import.meta.dirname, '../.localpost-tmp/plugin-entry');

function fakeCtx() {
  const host = { tools: [], commands: [], intervals: 0, timeouts: 0, disposers: [] };
  host.ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') host.disposers.push(dispose); return () => {}; },
    on() { return () => {}; },
    setTimeout() { host.timeouts += 1; return () => {}; },
    setInterval() { host.intervals += 1; return () => {}; },
    tools: {
      register(def) { host.tools.push(def); return () => {}; },
      get(name) { return host.tools.find(t => t.name === name); },
      guard() { return () => {}; },
    },
    commands: {
      register(def) { host.commands.push(def); return () => {}; },
      find(_agent, name) { return host.commands.find(c => c.name === name); },
    },
    agents: { get: () => undefined },
  };
  return host;
}

/** 只给插件写日志/状态的地方开临时目录；信箱根仍用 canonical（只读）。 */
// 2026-10-06：t.after 删除后，**插件的日志写入可能晚于清理**（实测留下 scratch-*/plugin.log）⇒
// 除了 after 钩子，再在进程退出时兜底删一次（同步删除，晚到的写入也会被收掉）。
const scratchDirs = [];
process.on('exit', () => {
  for (const d of scratchDirs) { try { removeTreeSync(d); } catch { /* 退出兜底，失败不影响测试结论 */ } }
});
function scratch(t, stamp) {
  fs.mkdirSync(TMP, { recursive: true });
  const dir = path.join(TMP, `scratch-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  scratchDirs.push(dir);
  t.after(() => removeTreeSync(dir));
  return dir;
}

test('插件入口：启用生产接线时不抛，命令/工具/就绪日志都到位（row 作用域回归）', async t => {
  const dir = scratch(t, 'enabled');
  const host = fakeCtx();
  const logFile = path.join(dir, 'plugin.log');
  const mod = await import(new URL('../lib/index.js', import.meta.url).href + '?entry-test=1');

  assert.doesNotThrow(() => mod.apply(host.ctx, {
    root: PRODUCTION_ROOT,
    intervalMinutes: 999,
    startupDelayMs: 60000,
    cooldownHours: 12,
    ntfyEnabled: false,
    toastEnabled: false,
    stateFile: path.join(dir, 'state.json'),
    logFile,
    runtimeVersion: '0.2.0-rc.2',
    versionEvidence: 'plugin-entry-test',
    autoReceive: { enabled: true, root: PRODUCTION_ROOT, allowFrom: 'codex', scanIntervalMs: 60000, debounceMs: 60, autoStart: false },
  }), '入口必须能加载（抛出 = fiber 失败，连内核定时器都不跑）');

  const written = fs.readFileSync(logFile, 'utf8');
  assert.deepEqual(host.commands.map(c => c.name).sort(), ['localpost-bind', 'localpost-status', 'localpost-unbind'], '只有三条共用命令');
  assert.deepEqual(host.tools.map(t => t.name).sort(),
    ['localpost_archive', 'localpost_bind_here', 'localpost_check', 'localpost_inbox', 'localpost_read', 'localpost_reply', 'localpost_status', 'localpost_unbind']);
  assert.equal(host.intervals, 1, '关了 autoStart 时只有内核定时器');
  assert.match(written, /生产自动收信已就绪/, '就绪日志缺失');
  assert.match(written, /插件就绪/, '插件就绪日志缺失（说明入口中途抛了）');
});

test('插件入口：配了其他身份时同样不抛、命令仍是共用的三条；身份配置非法时拒绝装配而不是抛（多身份 T1）', async t => {
  const base = {
    root: PRODUCTION_ROOT, intervalMinutes: 999, startupDelayMs: 60000, cooldownHours: 12, ntfyEnabled: false, toastEnabled: false,
    runtimeVersion: '0.2.0-rc.2', versionEvidence: 'plugin-entry-test',
  };
  const autoReceive = { enabled: true, root: PRODUCTION_ROOT, allowFrom: 'codex', scanIntervalMs: 60000, debounceMs: 60, autoStart: false };

  const dir = scratch(t, 'identities');
  const host = fakeCtx();
  const logFile = path.join(dir, 'plugin.log');
  const mod = await import(new URL('../lib/index.js', import.meta.url).href + '?entry-test=3');
  assert.doesNotThrow(() => mod.apply(host.ctx, { ...base, stateFile: path.join(dir, 'state.json'), logFile,
    autoReceive: { ...autoReceive, identities: { engineer: { allowFrom: 'dsh' } } } }));
  assert.deepEqual(host.commands.map(c => c.name).sort(), ['localpost-bind', 'localpost-status', 'localpost-unbind'], '不再按身份生成命令');
  assert.equal(host.tools.filter(t => t.name === 'localpost_read').length, 1, '工具仍只有一套');
  assert.match(fs.readFileSync(logFile, 'utf8'), /生产自动收信已就绪：.*身份=dsh,engineer/);

  const badDir = scratch(t, 'identities-bad');
  const badHost = fakeCtx();
  const badLog = path.join(badDir, 'plugin.log');
  const badMod = await import(new URL('../lib/index.js', import.meta.url).href + '?entry-test=4');
  assert.doesNotThrow(() => badMod.apply(badHost.ctx, { ...base, stateFile: path.join(badDir, 'state.json'), logFile: badLog,
    autoReceive: { ...autoReceive, identities: { Engineer: { allowFrom: 'dsh' } } } }));
  assert.deepEqual(badHost.commands.map(c => c.name), []);
  const written = fs.readFileSync(badLog, 'utf8');
  assert.match(written, /生产自动收信未启用（identity_invalid：Engineer）/);
  assert.match(written, /插件就绪/, '非法身份配置不许连累内核定时器');
});

test('插件入口：接线未启用时照旧只注册内核工具（默认关）', async t => {
  const dir = scratch(t, 'disabled');
  const host = fakeCtx();
  const logFile = path.join(dir, 'plugin.log');
  const mod = await import(new URL('../lib/index.js', import.meta.url).href + '?entry-test=2');

  assert.doesNotThrow(() => mod.apply(host.ctx, {
    root: PRODUCTION_ROOT,
    intervalMinutes: 999,
    startupDelayMs: 60000,
    ntfyEnabled: false,
    toastEnabled: false,
    stateFile: path.join(dir, 'state.json'),
    logFile,
  }));
  assert.deepEqual(host.commands.map(c => c.name), []);
  assert.deepEqual(host.tools.map(t => t.name), ['localpost_check']);
  assert.match(fs.readFileSync(logFile, 'utf8'), /未启用/);
});

test('插件入口：以上装配全程没有往真实生产信箱写过任何东西（调用期见证）', () => {
  assert.deepEqual(writesUnder(PRODUCTION_ROOT), []);
});
