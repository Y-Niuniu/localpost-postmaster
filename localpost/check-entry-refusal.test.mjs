/**
 * 首阶段入口拒绝的负向测试（用户 2026-10-04 拍板"人工也先拒"；方案 v4 §1/§4）。
 *
 * 契约：localpost_check 的模型可调用入口**无条件拒绝**，且拒绝发生在任何 IO 之前 ——
 *   · 不取根锁（不得出现 .postmaster.lock）、不 mkdir、不读写信箱/账本/告警/内核日志
 *   · 不写插件 stateFile、不追加插件日志、不冒泡（ntfy/toast）
 *   · 不加载、不调用内核（含 dry-run）
 * 对照实验：后台定时器**不经过**该入口，必须照常调用内核（证明停用范围只限工具入口）。
 *
 * 夹具全部合成：root/state/log/kernel 都在临时目录里，绝不触碰真实 .mailbox。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { after } from 'node:test';
import { removeTreeSync } from './temp-tree.mjs';

const PLUGIN = new URL('../lib/index.js', import.meta.url).href;
const TEMP_DIRS = [];
let seq = 0;

/** 每个用例独立夹具：假生产根 + 假状态/日志 + 会留下"被加载"证据的假内核 */
function fixture() {
  // 用确定性目录名 + mkdirSync：本机沙箱会拦 mkdtemp（EPERM），mkdir 不受影响
  const tmp = path.join(os.tmpdir(), 'localpost-entry-' + process.pid + '-' + seq++);
  fs.mkdirSync(tmp, { recursive: true });
  TEMP_DIRS.push(tmp);
  const root = path.join(tmp, 'mailbox');
  const stateFile = path.join(tmp, 'state.json');
  const logFile = path.join(tmp, 'plugin.log');
  const marker = path.join(tmp, 'kernel-imported.marker');
  const kernelPath = path.join(tmp, 'kernel-fixture.mjs');
  fs.mkdirSync(root, { recursive: true });
  // 内核夹具：**顶层 import 即写 marker**，所以"被加载"和"被调用"都能被发现
  fs.writeFileSync(kernelPath, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'imported', 'utf8');`,
    'export async function runOnce() {',
    "  return { kernel: 'fixture', exit_code: 0, skipped: false, alerts: { alerts: [] }, ledger_summary: null };",
    '}',
    '',
  ].join('\n'), 'utf8');
  return { tmp, root, stateFile, logFile, marker, kernelPath };
}

function fakeCtx() {
  const captured = { tool: null, startup: null, interval: null };
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m) },
    effect(fn) { return fn() },
    on() { return () => {} },
    setTimeout(fn) { captured.startup = fn; return () => {} },
    setInterval(fn) { captured.interval = fn; return () => {} },
    tools: { register(def) { captured.tool = def; return () => { captured.tool = null } } },
  };
  return { ctx, captured, logs };
}

async function boot(f, tag) {
  const { ctx, captured, logs } = fakeCtx();
  const mod = await import(PLUGIN + '?fixture=' + tag);
  mod.apply(ctx, {
    root: f.root, kernelPath: f.kernelPath, intervalMinutes: 999, startupDelayMs: 0,
    ntfyEnabled: false, toastEnabled: false, stateFile: f.stateFile, logFile: f.logFile,
  });
  assert.equal(captured.tool?.name, 'localpost_check', '入口必须仍然注册（保入口、拒执行）');
  return { captured, logs };
}

after(() => {
  // 本机删除常撞瞬时 EPERM：用仓库自己的重试删除器，别让清理失败掩盖断言结果
  for (const dir of TEMP_DIRS) removeTreeSync(dir, { attempts: 5, delayMs: 50 });
});

test('入口拒绝（含 dry-run）：零锁、零读写信箱/账本/状态、零日志、零内核加载', async () => {
  const f = fixture();
  const { captured } = await boot(f, 'refusal');
  assert.match(String(captured.tool.description), /已停用/, '描述必须如实标注停用，避免模型反复试');

  const logBefore = fs.existsSync(f.logFile) ? fs.readFileSync(f.logFile, 'utf8') : '';
  const plain = await captured.tool.execute({});
  const dry = await captured.tool.execute({ dry_run: true, verbose: true });

  for (const out of [plain, dry]) {
    assert.match(String(out), /已停用/, '必须返回停用说明');
    assert.match(String(out), /入口无条件拒绝/, '必须说明是入口拒绝');
    assert.doesNotMatch(String(out), /超时|已在对话内回报|dry-run 预览/, '不得泄漏对账结论或旧预览文案');
  }

  // 零 root 写入：根锁是 acquireLease 的第一个动作（fs-safe.mjs:151 mkdir + :137 open 'wx'）
  assert.equal(fs.existsSync(path.join(f.root, '.postmaster.lock')), false, '拒绝路径不得创建根锁');
  assert.equal(fs.existsSync(path.join(f.root, 'ledger.json')), false, '拒绝路径不得落账本');
  assert.equal(fs.existsSync(path.join(f.root, 'alerts.json')), false, '拒绝路径不得落告警');
  assert.equal(fs.existsSync(path.join(f.root, 'postmaster.log')), false, '拒绝路径不得写内核日志');

  // 零插件状态/日志写入
  assert.equal(fs.existsSync(f.stateFile), false, '拒绝路径不得写插件状态');
  assert.equal(fs.existsSync(f.logFile) ? fs.readFileSync(f.logFile, 'utf8') : '', logBefore,
    '拒绝路径不得追加插件日志');

  // 零内核加载/调用
  assert.equal(fs.existsSync(f.marker), false, '拒绝路径不得加载或调用内核');

  // 文案：只引导真实存在的工具，不引导 localpost_e_*
  assert.match(String(plain), /localpost_status/);
  assert.match(String(plain), /localpost_archive/);
  assert.doesNotMatch(String(plain), /localpost_e_/);
});

test('对照实验：后台定时器不经过该入口，照常加载并调用内核', async () => {
  const f = fixture();
  const { captured } = await boot(f, 'timer');
  assert.equal(typeof captured.interval, 'function', '定时器必须仍然挂上');

  await captured.interval();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(fs.existsSync(f.marker), true, '定时器路径应当调用内核（停用范围只限工具入口）');
  assert.equal(fs.existsSync(f.stateFile), true, '定时器路径照常推进冷却状态');
  assert.match(fs.readFileSync(f.logFile, 'utf8'), /run\(timer\)/, '定时器路径照常写插件日志');
});
