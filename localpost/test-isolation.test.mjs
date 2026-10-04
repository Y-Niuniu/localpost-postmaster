/**
 * 测试隔离回归门禁（v2 · 合成 homedir + 受控注入接缝）
 *
 * 背景：codex 2026-10-04 复审（`work/codex-a-b-review-20261004.md`）指出 v1 的两处问题：
 *   [P2-1] v1 拿**真实** `~/.dsh/localpost-postmaster` 当哨兵：一旦旧缺陷回归，自测会**先写真实日志**，
 *          哈希断言只是事后发现污染 —— 不是安全验证；真实后台写日志还会误报。
 *   [P2-2] 末尾源码门禁只匹配字符串，注释或失效赋值也能满足。
 *
 * v2 做法（真实用户目录**完全不参与**）：
 *   1. **合成 homedir**：子进程给 `USERPROFILE`/`HOME` 指向合成家目录，DSH_HOME **缺失** ⇒
 *      `os.homedir()` 解析到合成目录，插件默认路径 = `<合成家>/.dsh/localpost-postmaster`；
 *      事先在里面种入「假生产日志/状态」，断言跑完**一字未变**。
 *   2. **不可信继承值**：另一路把 `DSH_HOME` 指向第二个合成目录（同样种入假生产文件），断言一字未变。
 *   3. **非空转**：子进程确实写了插件日志 —— 写在它自己的隔离 fixture 里。
 *   4. **红绿演示（隔离副本内）**：一个合成家目录里运行「旧行为」驱动（照 v1 缺陷那样 apply 时不给
 *      stateFile/logFile），断言假生产日志**确实被写** ⇒ 证明上面的哨兵真的能抓到回归，
 *      而全过程真实用户目录零接触。
 * 说明：`scripts/test.mjs` 的字符串门禁仍保留为**绊线**（tripwire），并在注释里标明它**不是**隔离充分证据；
 *       真正的证据是上面这些行为断言（子进程实际环境 + 实际输出路径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './temp-tree.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256 = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** 造一个"假生产用户目录"：<home>/.dsh/localpost-postmaster/{plugin.log,state.json}，内容可辨识 */
function seedFakeUserDir(home) {
  const dir = path.join(home, '.dsh', 'localpost-postmaster');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.log'),
    'FAKE-PRODUCTION-LOG 2026-01-01T00:00:00.000Z  info  种入的假生产日志（不得被测试改写）\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'state.json'),
    JSON.stringify({ schema: 'localpost-plugin-state-v1', notified: { 'fake|sentinel|path|': { at: '2026-01-01T00:00:00.000Z', severity: 'warn' } } }) + '\n', 'utf8');
  return dir;
}

function makeTmp(tag) {
  const tmp = path.join(os.tmpdir(), `localpost-isolation-${tag}-${process.pid}`);
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

/** 子进程环境：合成家目录、合成 TEMP、隔离内核 fixture 根；DSH_HOME 按用例决定 */
function childEnv({ tmp, home, dshHome }) {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HOMEDRIVE: path.parse(home).root.replace(/\\$/, ''),
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    TEMP: path.join(tmp, 'child-temp'),
    TMP: path.join(tmp, 'child-temp'),
    TMPDIR: path.join(tmp, 'child-temp'),
    LOCALPOST_MAILBOX: path.join(REPO, 'localpost'),
  };
  fs.mkdirSync(env.TEMP, { recursive: true });
  if (dshHome === undefined) delete env.DSH_HOME;
  else env.DSH_HOME = dshHome;
  return env;
}

const runSelftest = (env) => spawnSync(process.execPath, [path.join(REPO, 'test', 'selftest.mjs')], {
  cwd: REPO, encoding: 'utf8', env,
});

test('DSH_HOME 缺失（合成 homedir）：默认路径未被写，假生产日志/状态一字未变', () => {
  const tmp = makeTmp('nohome');
  try {
    const home = path.join(tmp, 'synthetic-home');
    const fakeDir = seedFakeUserDir(home);
    const before = { log: sha256(path.join(fakeDir, 'plugin.log')), state: sha256(path.join(fakeDir, 'state.json')) };

    const run = runSelftest(childEnv({ tmp, home }));
    const out = String(run.stdout || '') + String(run.stderr || '');
    assert.equal(run.status, 0, 'legacy 自测退出码应为 0，末尾输出：' + out.slice(-400));
    assert.match(out, /自测小结: 45\/45 通过/, 'legacy 自测应 45/45 通过');

    assert.equal(sha256(path.join(fakeDir, 'plugin.log')), before.log,
      '合成默认路径下的假生产 plugin.log 被改写了（测试隔离回潮）');
    assert.equal(sha256(path.join(fakeDir, 'state.json')), before.state,
      '合成默认路径下的假生产 state.json 被改写了（测试隔离回潮）');

    // 非空转：日志确实写了，写在子进程自己的隔离 fixture 里
    const fixtureLog = path.join(tmp, 'child-temp', 'localpost-selftest', 'plugin.log');
    assert.ok(fs.existsSync(fixtureLog), '隔离 fixture 里应有 plugin.log（否则上面的"未改写"可能是空转）');
    assert.match(readIf(fixtureLog) ?? '', /插件就绪/, '隔离 fixture 日志应含插件启动记录');
  } finally {
    removeTreeSync(tmp, { attempts: 5, delayMs: 50 });
  }
});

test('不可信继承值（DSH_HOME 指向合成目录）：同样一字未变', () => {
  const tmp = makeTmp('inherited');
  try {
    const home = path.join(tmp, 'synthetic-home');
    fs.mkdirSync(home, { recursive: true });
    const inheritedDshHome = path.join(tmp, 'inherited-dsh-home');
    const fakeDir = path.join(inheritedDshHome, 'localpost-postmaster');
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'plugin.log'), 'FAKE-INHERITED-DSH-HOME log\n', 'utf8');
    fs.writeFileSync(path.join(fakeDir, 'state.json'), '{"schema":"localpost-plugin-state-v1","notified":{}}\n', 'utf8');
    const before = { log: sha256(path.join(fakeDir, 'plugin.log')), state: sha256(path.join(fakeDir, 'state.json')) };

    const run = runSelftest(childEnv({ tmp, home, dshHome: inheritedDshHome }));
    const out = String(run.stdout || '') + String(run.stderr || '');
    assert.equal(run.status, 0, 'legacy 自测退出码应为 0，末尾输出：' + out.slice(-400));
    assert.match(out, /自测小结: 45\/45 通过/, 'legacy 自测应 45/45 通过');

    assert.equal(sha256(path.join(fakeDir, 'plugin.log')), before.log, '继承的 DSH_HOME 下假生产日志被改写');
    assert.equal(sha256(path.join(fakeDir, 'state.json')), before.state, '继承的 DSH_HOME 下假生产状态被改写');
  } finally {
    removeTreeSync(tmp, { attempts: 5, delayMs: 50 });
  }
});

test('红绿演示（隔离副本）：故意回到旧行为 ⇒ 假生产日志必须被写（证明哨兵有效，且真实目录零接触）', () => {
  const tmp = makeTmp('red-demo');
  try {
    const home = path.join(tmp, 'synthetic-home');
    const fakeDir = seedFakeUserDir(home);
    const fakeLog = path.join(fakeDir, 'plugin.log');
    const before = sha256(fakeLog);

    // 旧行为驱动：照 v1 缺陷那样 apply 时**不给** stateFile/logFile（其余配置给合成值）
    const driver = path.join(tmp, 'old-behavior-driver.mjs');
    fs.writeFileSync(driver, [
      `const mod = await import(${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)});`,
      'let tool = null;',
      'const ctx = { logger: { info() {}, warn() {} }, effect: (fn) => fn(), on: () => () => {},',
      '  setTimeout: () => () => {}, setInterval: () => () => {},',
      '  tools: { register: (def) => { tool = def; return () => {}; } } };',
      `mod.apply(ctx, { root: ${JSON.stringify(path.join(tmp, 'fixture-root'))}, kernelPath: ${JSON.stringify(path.join(tmp, 'no-such-kernel.mjs'))}, startupDelayMs: 0 });`,
      "if (!tool) throw new Error('工具未注册');",
      "console.log('OLD-BEHAVIOUR-APPLIED');",
    ].join('\n'), 'utf8');

    const run = spawnSync(process.execPath, [driver], { cwd: REPO, encoding: 'utf8', env: childEnv({ tmp, home }) });
    const out = String(run.stdout || '') + String(run.stderr || '');
    assert.equal(run.status, 0, '旧行为驱动应能跑完：' + out.slice(-300));
    assert.match(out, /OLD-BEHAVIOUR-APPLIED/);

    assert.notEqual(sha256(fakeLog), before,
      '旧行为没有写合成假生产日志 ⇒ 本门禁的哨兵是哑的（红绿演示失败）');
    assert.match(readIf(fakeLog) ?? '', /插件就绪/, '假生产日志里应出现旧行为的插件就绪记录');
  } finally {
    removeTreeSync(tmp, { attempts: 5, delayMs: 50 });
  }
});

test('绊线（非充分证据）：scripts/test.mjs 仍显式设置 DSH_HOME', () => {
  const source = fs.readFileSync(path.join(REPO, 'scripts', 'test.mjs'), 'utf8');
  assert.match(source, /DSH_HOME/, 'scripts/test.mjs 未设置 DSH_HOME —— 测试会写进默认用户目录');
  assert.match(source, /isolatedHome|dsh-home/, 'scripts/test.mjs 应指向隔离的 DSH_HOME 目录');
  // 注意：本用例只是廉价绊线；隔离是否成立以上面三个行为用例为准（子进程实际环境 + 实际输出路径）。
});
