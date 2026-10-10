/**
 * 自测 gemini wake.mjs 对"孤儿调度"的处理（2026-10-10）。
 *
 * 背景：Antigravity 每次重启都留下一个旧的 schedule 进程，它照样每分钟跑 wake.mjs，但 ANTIGRAVITY_LS_ADDRESS 指向已不存在的
 * 语言服务。10-10 12:38 三个孤儿各试一次（连接被拒），把一封信的 3 次额度在 35 秒内用光，活着的实例没轮上。
 *
 *   O1 语言服务明确被拒 ⇒ 这一轮什么都不发、不占次数、不碰状态，只记一笔
 *   O2 连续被拒但不到 2 分钟 ⇒ 仍只退出，不结束调度进程
 *   O3 同一地址连续 3 轮、跨 2 分钟以上被拒 ⇒ 结束自己的 schedule 进程（这里用假调度进程当父进程）
 *   O4 语言服务连得上（127.0.0.1）⇒ 照常发送；该地址的孤儿记录被清掉
 *   O5 地址写成 localhost ⇒ IPv4 / IPv6 任一连上都算连得上
 *   O6 发送时报"连不上语言服务" ⇒ 不占尝试次数；下一轮成功送达
 *   O7 传输失败连续到上限 ⇒ 停下来等人看，之后不再发
 *   O8 地址看不懂 ⇒ 不作判断，照旧运行
 *
 * 隔离：临时根 + 假 agentapi（isolatedEnv，永不真发）+ 测试专用会话 id；被测脚本取自本仓库。
 *
 *   node integrations/verification/test-gemini-orphan.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SRC, TEST_CONVERSATION_ID, makeRoot, fakeAgentapi, isolatedEnv, readCalls, stage } from './lib/harness.mjs';

const ROOTS = [];
const checks = [];
const record = (name, ok, detail = '') => { checks.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`); };
const UNAVAILABLE = 'rpc error: code = Unavailable desc = connection error: transport: dial tcp [::1]:1: connectex: No connection could be made because the target machine actively refused it.';

/** 一个装好的 sidecar 目录：先跑一轮记基线（空信箱），再投一封新信。 */
function world({ maxTransportFailures = 60 } = {}) {
  const root = makeRoot('gemini-orphan');
  ROOTS.push(root);
  fs.mkdirSync(path.join(root, 'agents', 'gemini', 'inbox'), { recursive: true });
  const wake = stage(path.join(SRC.gemini, 'wake.mjs'), root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    identity: 'gemini', conversationId: TEST_CONVERSATION_ID, mailboxRoot: root, allowFrom: ['dsh'], dryRun: false,
    maxAttemptsPerLetter: 3, maxTransportFailures,
  }, null, 2) + '\n');
  const api = fakeAgentapi(root, { exitCode: 0 });
  const data = path.join(root, 'data');
  const envFor = (address) => {
    const env = isolatedEnv(root, api, address === undefined ? {} : { ANTIGRAVITY_LS_ADDRESS: address });
    if (address === undefined) delete env.ANTIGRAVITY_LS_ADDRESS;
    delete env.CLAUDE_CODE_SESSION_ID;
    return env;
  };
  const run = (address) => spawnSync(process.execPath, [wake], { encoding: 'utf8', env: envFor(address), cwd: root });
  run(undefined);                                                      // 首轮只记基线
  fs.writeFileSync(path.join(root, 'agents', 'gemini', 'inbox', 'or-1.json'), JSON.stringify({
    id: 'or-1', thread_id: 'orphan', from: 'dsh', to: 'gemini', type: 'task', subject: 'orphan test', body: 'x', budget: 'standard',
    created_at: new Date().toISOString(),
  }, null, 2));
  /**
   * 像真实 sidecar 那样跑一轮：假 schedule 进程拉起 wake.mjs（于是 wake.mjs 的父进程是它，不是测试本身），
   * wake.mjs 正常结束时它以 42 退出；被 wake.mjs 结束（退场）时退出码就不是 42。返回 'finished' | 'ended' | 'timeout'。
   */
  const underScheduler = async (address) => {
    const script = path.join(root, 'fake-scheduler.mjs');
    fs.writeFileSync(script, "import { spawn } from 'node:child_process';\n"
      + "const child = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore', env: process.env });\n"
      + "child.on('exit', () => setTimeout(() => process.exit(42), 300));\nsetInterval(() => {}, 1000);\n");
    const scheduler = spawn(process.execPath, [script, wake], { stdio: 'ignore', env: envFor(address), cwd: root });
    const outcome = await Promise.race([
      new Promise((resolve) => scheduler.on('exit', (code) => resolve(code === 42 ? 'finished' : 'ended'))),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]);
    if (outcome === 'timeout') scheduler.kill();
    return outcome;
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(data, 'wake-state.json'), 'utf8'));
  const orphans = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'orphans.json'), 'utf8')); } catch { return {}; } };
  const logText = () => fs.readFileSync(path.join(data, 'wake.log'), 'utf8');
  const calls = () => readCalls(api.calls);
  const failWith = (stdout, exitCode = 1) => fakeAgentapi(root, { exitCode, stdout });
  const succeed = () => fakeAgentapi(root, { exitCode: 0 });
  return { root, wake, data, run, underScheduler, envFor, state, orphans, logText, calls, failWith, succeed };
}

/** 一个确定没人监听的端口，和一个确定有人监听的端口（OS 层完成握手，测试进程阻塞在 spawnSync 时也连得上）。 */
async function ports() {
  const closed = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { closed, open: server.address().port, server };
}

const { closed, open, server } = await ports();
try {
  /* ---------------------------------------------------------------- O1 / O2 被拒 ⇒ 只退出 */
  const w1 = world();
  const before = JSON.stringify(w1.state());
  w1.run(`127.0.0.1:${closed}`);
  const o1 = w1.orphans()[`127.0.0.1:${closed}`];
  record('O1 被拒 ⇒ 不发送、不占次数、状态不变、只记一笔', w1.calls().length === 0 && JSON.stringify(w1.state()) === before
    && o1?.refusals === 1 && /refuses connections/.test(w1.logText()), JSON.stringify(o1));
  w1.run(`127.0.0.1:${closed}`);
  const o2 = w1.orphans()[`127.0.0.1:${closed}`];
  record('O2 连续被拒但不到 2 分钟 ⇒ 仍只退出、不结束调度', w1.calls().length === 0 && o2?.refusals === 2 && !/retire orphan scheduler/.test(w1.logText()));
  // 退场要两个条件同时满足：次数够（≥3）而且时间够（≥2 分钟）。各缺一个都不许退场。
  const keyC = `127.0.0.1:${closed}`;
  const long = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const w2b = world();
  fs.writeFileSync(path.join(w2b.data, 'orphans.json'), JSON.stringify({ [keyC]: { firstRefusedAt: new Date().toISOString(), lastRefusedAt: new Date().toISOString(), refusals: 2 } }));
  const r2b = await w2b.underScheduler(keyC);
  record('O2b 次数够了但不到 2 分钟 ⇒ 不退场', r2b === 'finished' && w2b.orphans()[keyC]?.refusals === 3 && !/retire orphan scheduler/.test(w2b.logText()), r2b);
  const w2c = world();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(w2c.data, 'orphans.json'), JSON.stringify({ [keyC]: { firstRefusedAt: old, lastRefusedAt: old, refusals: 1 } }));
  const r2c = await w2c.underScheduler(keyC);
  record('O2c 时间够了但次数不到 3 ⇒ 不退场', r2c === 'finished' && w2c.orphans()[keyC]?.refusals === 2 && !/retire orphan scheduler/.test(w2c.logText()), r2c);

  /* ---------------------------------------------------------------- O3 退场：结束自己的 schedule 进程 */
  const w3 = world();
  fs.writeFileSync(path.join(w3.data, 'orphans.json'), JSON.stringify({ [keyC]: { firstRefusedAt: long, lastRefusedAt: long, refusals: 2 } }));
  const r3 = await w3.underScheduler(keyC);
  record('O3 连续 3 轮、跨 2 分钟被拒 ⇒ 结束自己的 schedule 进程，且不发送', r3 === 'ended' && /retire orphan scheduler/.test(w3.logText()) && w3.calls().length === 0,
    r3 + ' / ' + w3.logText().trim().split('\n').pop());
  // 活着的实例永远不退场：连得上的地址，哪怕状态里记着很久以前的拒绝次数。
  const w3b = world();
  fs.writeFileSync(path.join(w3b.data, 'orphans.json'), JSON.stringify({ [`127.0.0.1:${open}`]: { firstRefusedAt: old, lastRefusedAt: old, refusals: 9 } }));
  const r3b = await w3b.underScheduler(`127.0.0.1:${open}`);
  record('O3b 连得上的实例不退场（旧拒绝记录也不算数），照常发送', r3b === 'finished' && w3b.calls().length === 1 && !/retire orphan scheduler/.test(w3b.logText()), r3b);

  /* ---------------------------------------------------------------- O4 / O5 连得上 ⇒ 照常 */
  const w4 = world();
  fs.writeFileSync(path.join(w4.data, 'orphans.json'), JSON.stringify({ [`127.0.0.1:${open}`]: { firstRefusedAt: long, lastRefusedAt: long, refusals: 1 } }));
  w4.run(`127.0.0.1:${open}`);
  record('O4 连得上 ⇒ 照常发送；该地址的孤儿记录被清掉', w4.calls().length === 1 && w4.state().seen['or-1']?.attempts === 1
    && w4.orphans()[`127.0.0.1:${open}`] === undefined);
  const w5 = world();
  w5.run(`localhost:${open}`);
  record('O5 地址写 localhost ⇒ IPv4/IPv6 任一连上即算连得上', w5.calls().length === 1);

  /* ---------------------------------------------------------------- O6 / O7 传输失败不占次数 */
  const w6 = world();
  w6.failWith(UNAVAILABLE);
  w6.run(`127.0.0.1:${open}`);
  const e6 = w6.state().seen['or-1'];
  record('O6a 发送时连不上语言服务 ⇒ 不占尝试次数，留给下一轮', w6.calls().length === 1 && !e6.attempts && e6.transportFailures === 1 && !e6.lastResult
    && /not delivered/.test(w6.logText()), JSON.stringify({ attempts: e6.attempts, transportFailures: e6.transportFailures, lastResult: e6.lastResult }));
  w6.succeed();
  w6.run(`127.0.0.1:${open}`);
  const e6b = w6.state().seen['or-1'];
  record('O6b 下一轮送达（这才算第 1 次尝试）', w6.calls().length === 2 && e6b.attempts === 1 && Boolean(e6b.sentAt));
  const w7 = world({ maxTransportFailures: 3 });
  w7.failWith(UNAVAILABLE);
  for (let i = 0; i < 3; i += 1) w7.run(`127.0.0.1:${open}`);
  const e7 = w7.state().seen['or-1'];
  w7.succeed();
  w7.run(`127.0.0.1:${open}`);
  record('O7 传输失败连续到上限 ⇒ 停下等人看，之后不再发', e7.lastResult === 'exhausted' && /give up: or-1 — language server unreachable 3 times/.test(w7.logText())
    && w7.calls().length === 3, `calls=${w7.calls().length}`);

  /* ---------------------------------------------------------------- O8 看不懂的地址 ⇒ 照旧 */
  const w8 = world();
  w8.run('pipe:not-an-address');
  record('O8 地址看不懂 ⇒ 不作判断，照旧发送', w8.calls().length === 1 && Object.keys(w8.orphans()).length === 0);
} finally {
  server.close();
  for (const root of ROOTS) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 交给系统 temp 清理 */ } }
}

const bad = checks.filter(([, ok]) => !ok).length;
console.log(`\n小结：${checks.length - bad}/${checks.length} 通过`);
process.exitCode = bad === 0 ? 0 : 1;
