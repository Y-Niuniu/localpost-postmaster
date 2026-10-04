/**
 * 首阶段入口拒绝的负向测试（v2 · 含 codex 复审的两项 P2 加固）
 *
 * 契约：localpost_check 的模型可调用入口**无条件拒绝**，且拒绝发生在任何 IO 之前 ——
 *   不取根锁、不 mkdir、不读写信箱/账本/告警/内核日志、不写插件 stateFile、不追加插件日志、
 *   不冒泡、不加载也不调用内核（含 dry-run）。
 *
 * v2 加固（回应 codex 2026-10-04 复审的两项 P2）：
 *   1. **调用期 IO 观测**：用 `module.registerHooks` 把插件自身模块的 `node:fs` / `node:fs/promises`
 *      导入改写到 `fixtures/fs-witness*.mjs`，于是插件的每一次 fs 调用（含 statSync 这类元数据读取、
 *      以及"创建后立刻删除"的瞬时锁写入）都被看见 —— 不再依赖事后快照。
 *      正对照：观测器直接调用必须记得到（否则测试是空转）；对照实验：定时器路径必须观测到插件 IO。
 *   2. **有界完成等待**：内核夹具用计数文件记录调用次数，定时器路径改为"轮询到有界上限"，
 *      不再用固定 50ms 睡眠（慢机不再假失败），并断言恰好调用一次。
 *
 * 夹具全部合成：root/state/log/kernel 都在临时目录里，绝不触碰真实 .mailbox。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { removeTreeSync } from './temp-tree.mjs';
import fsWitness, { witness as fsWatch } from './fixtures/fs-witness.mjs';
import fspWitness, { witness as fspWatch } from './fixtures/fs-promises-witness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const PLUGIN = new URL('../lib/index.js', import.meta.url).href;
const FS_WITNESS = new URL('./fixtures/fs-witness.mjs', import.meta.url).href;
const FSP_WITNESS = new URL('./fixtures/fs-promises-witness.mjs', import.meta.url).href;

/* ------------------------- 调用期观测：模块钩子 ------------------------- */

/**
 * 只改写插件自身的模块：仓库内（或 LOCALPOST_ENTRY_WATCH_ROOTS 指定的变异目录内）、
 * 非 fixtures、非 *.test.mjs（避免观测器自己观测自己）。
 * 变异测试把被测 plugin.mjs 放在仓库外，故需要额外监视根。
 */
const EXTRA_WATCH_ROOTS = String(process.env.LOCALPOST_ENTRY_WATCH_ROOTS ?? '')
  .split(path.delimiter)
  .filter(Boolean)
  .map((root) => path.resolve(root));

function watched(url) {
  if (!url.startsWith('file:')) return false;
  const file = fileURLToPath(url);
  const under = (root) => file.startsWith(root);
  const inScope = under(REPO) || EXTRA_WATCH_ROOTS.some(under);
  return inScope && !file.includes(`${path.sep}fixtures${path.sep}`) && !file.endsWith('.test.mjs');
}

/** `{ a, b as c }` → `a, b: c`（对象解构没有 as 语法，必须转换） */
function toDestructuring(names) {
  return names
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+/, ': '))
    .join(', ');
}

function rewrite(source) {
  return source
    // 先长后短：node:fs/promises 必须先于 node:fs 匹配
    .replace(/import\s*\{([^}]+)\}\s*from\s*'node:fs\/promises'/g,
      (_m, names) => `import __w2 from '${FSP_WITNESS}'; const {${toDestructuring(names)}} = __w2;`)
    .replace(/import\s*(\w+)\s*,\s*\{([^}]+)\}\s*from\s*'node:fs\/promises'/g,
      (_m, local, names) => `import ${local} from '${FSP_WITNESS}'; const {${toDestructuring(names)}} = ${local};`)
    .replace(/import\s+\*\s+as\s+(\w+)\s+from\s*'node:fs\/promises'/g,
      (_m, local) => `import ${local} from '${FSP_WITNESS}';`)
    .replace(/import\s+(\w+)\s+from\s*'node:fs\/promises'/g,
      (_m, local) => `import ${local} from '${FSP_WITNESS}';`)
    .replace(/import\s*\{([^}]+)\}\s*from\s*'node:fs'/g,
      (_m, names) => `import __w1 from '${FS_WITNESS}'; const {${toDestructuring(names)}} = __w1;`)
    .replace(/import\s*(\w+)\s*,\s*\{([^}]+)\}\s*from\s*'node:fs'/g,
      (_m, local, names) => `import ${local} from '${FS_WITNESS}'; const {${toDestructuring(names)}} = ${local};`)
    .replace(/import\s+\*\s+as\s+(\w+)\s+from\s*'node:fs'/g,
      (_m, local) => `import ${local} from '${FS_WITNESS}';`)
    .replace(/import\s+(\w+)\s+from\s*'node:fs'/g,
      (_m, local) => `import ${local} from '${FS_WITNESS}';`);
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!watched(url) || result?.format !== 'module' || result.source === undefined) return result;
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source);
    if (!source.includes("'node:fs")) return result;
    return { ...result, source: rewrite(source), shortCircuit: true };
  },
});

function watchOn() {
  fsWatch.hits.length = 0; fspWatch.hits.length = 0;
  fsWatch.on = true; fspWatch.on = true;
}
function watchOff() {
  fsWatch.on = false; fspWatch.on = false;
  return [...fsWatch.hits, ...fspWatch.hits];
}

/* ------------------------------- 夹具 ------------------------------- */

const TEMP_DIRS = [];
let seq = 0;

/** 每个用例独立夹具：假生产根 + 假状态/日志 + 会留下"被加载/被调用"证据的假内核 */
function fixture() {
  // 用确定性目录名 + mkdirSync：本机沙箱会拦 mkdtemp（EPERM），mkdir 不受影响
  const tmp = path.join(os.tmpdir(), 'localpost-entry-' + process.pid + '-' + seq++);
  fs.mkdirSync(tmp, { recursive: true });
  TEMP_DIRS.push(tmp);
  const root = path.join(tmp, 'mailbox');
  const stateFile = path.join(tmp, 'state.json');
  const logFile = path.join(tmp, 'plugin.log');
  const marker = path.join(tmp, 'kernel-imported.marker');
  const counter = path.join(tmp, 'kernel-run-count.txt');
  const kernelPath = path.join(tmp, 'kernel-fixture.mjs');
  fs.mkdirSync(root, { recursive: true });
  // 内核夹具：顶层 import 写 marker（"被加载"），runOnce 累加计数（"被调用几次"）
  fs.writeFileSync(kernelPath, [
    "import { writeFileSync, readFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'imported', 'utf8');`,
    'export async function runOnce() {',
    `  let n = 0; try { n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) || 0; } catch { /* 首次 */ }`,
    `  writeFileSync(${JSON.stringify(counter)}, String(n + 1), 'utf8');`,
    "  return { kernel: 'fixture', exit_code: 0, skipped: false, alerts: { alerts: [] }, ledger_summary: null };",
    '}',
    '',
  ].join('\n'), 'utf8');
  return { tmp, root, stateFile, logFile, marker, counter, kernelPath };
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

/** 目录结构指纹：类型/相对路径/大小/内容哈希 —— 同大小替换也能查出 */
function fingerprint(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) { out.push('d ' + rel); walk(full); }
      else {
        const stat = fs.statSync(full);
        out.push('f ' + rel + ' ' + stat.size + ' ' + createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      }
    }
  };
  walk(dir);
  return out;
}

/** 有界完成等待：不用固定睡眠，慢机不假失败 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const readCount = (file) => {
  try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; }
};

after(() => {
  // 本机删除常撞瞬时 EPERM：用仓库自己的重试删除器，别让清理失败掩盖断言结果
  for (const dir of TEMP_DIRS) removeTreeSync(dir, { attempts: 5, delayMs: 50 });
});

/* ------------------------------- 用例 ------------------------------- */

test('正对照：观测器必须能记到 fs 调用（否则下面的零命中断言是空转）', async () => {
  const f = fixture();
  watchOn();
  fsWitness.statSync(f.root);
  await fspWitness.access(f.root);
  const hits = watchOff();
  assert.ok(hits.length >= 2, '观测器未记录到直接调用，测试会空转：' + JSON.stringify(hits));
});

test('入口拒绝（含 dry-run）：调用期零 fs 命中 + 零锁/账本/状态/日志 + 内核未被加载', async () => {
  const f = fixture();
  const { captured } = await boot(f, 'refusal');
  assert.match(String(captured.tool.description), /已停用/, '描述必须如实标注停用，避免模型反复试');

  const logBefore = fs.existsSync(f.logFile) ? fs.readFileSync(f.logFile, 'utf8') : '';
  const treeBefore = fingerprint(f.root);
  const rootMtimeBefore = fs.statSync(f.root).mtimeMs;

  watchOn();
  const plain = await captured.tool.execute({});
  const dry = await captured.tool.execute({ dry_run: true, verbose: true });
  const hits = watchOff();

  for (const out of [plain, dry]) {
    assert.match(String(out), /已停用/, '必须返回停用说明');
    assert.match(String(out), /入口无条件拒绝/, '必须说明是入口拒绝');
    assert.doesNotMatch(String(out), /超时|已在对话内回报|dry-run 预览/, '不得泄漏对账结论或旧预览文案');
  }

  // 调用期观测：插件在这两次调用里没有碰过任何 fs（含 statSync 这类元数据读取）
  assert.deepEqual(hits, [], '拒绝路径发生了 fs 调用：' + JSON.stringify(hits));

  // 事后快照兜底
  assert.equal(fs.statSync(f.root).mtimeMs, rootMtimeBefore, 'fixture 根目录 mtime 变了（有创建/删除）');
  assert.deepEqual(fingerprint(f.root), treeBefore, 'fixture 根内容被改动');
  assert.equal(fs.existsSync(path.join(f.root, '.postmaster.lock')), false, '拒绝路径不得创建根锁');
  assert.equal(fs.existsSync(path.join(f.root, 'ledger.json')), false, '拒绝路径不得落账本');
  assert.equal(fs.existsSync(path.join(f.root, 'alerts.json')), false, '拒绝路径不得落告警');
  assert.equal(fs.existsSync(path.join(f.root, 'postmaster.log')), false, '拒绝路径不得写内核日志');
  assert.equal(fs.existsSync(f.stateFile), false, '拒绝路径不得写插件状态');
  assert.equal(fs.existsSync(f.logFile) ? fs.readFileSync(f.logFile, 'utf8') : '', logBefore, '拒绝路径不得追加插件日志');
  assert.equal(fs.existsSync(f.marker), false, '拒绝路径不得加载内核');
  assert.equal(readCount(f.counter), 0, '拒绝路径不得调用内核');

  // 文案：只引导真实存在的工具，不引导 localpost_e_*
  assert.match(String(plain), /localpost_status/);
  assert.match(String(plain), /localpost_archive/);
  assert.doesNotMatch(String(plain), /localpost_e_/);
});

test('对照实验：后台定时器不经过该入口，照常加载并调用内核（且有界等待完成）', async () => {
  const f = fixture();
  const { captured } = await boot(f, 'timer');
  assert.equal(typeof captured.interval, 'function', '定时器必须仍然挂上');

  watchOn();
  await captured.interval();
  const done = await waitFor(() => readCount(f.counter) >= 1 && fs.existsSync(f.stateFile));
  const hits = watchOff();

  assert.ok(done, '有界等待超时：定时器路径未在期限内完成（counter=' + readCount(f.counter) + '）');
  assert.equal(readCount(f.counter), 1, '内核应恰好被调用一次');
  assert.equal(fs.existsSync(f.marker), true, '定时器路径应当加载内核（停用范围只限工具入口）');
  assert.equal(fs.existsSync(f.stateFile), true, '定时器路径照常推进冷却状态');
  assert.match(fs.readFileSync(f.logFile, 'utf8'), /run\(timer\)/, '定时器路径照常写插件日志');
  // 观测器对真实插件代码有效的证据：这段确实产生了插件侧 fs 调用
  assert.ok(hits.length > 0, '定时器路径未观测到任何插件 fs 调用 → 观测器可能失效：' + JSON.stringify(hits));
});
