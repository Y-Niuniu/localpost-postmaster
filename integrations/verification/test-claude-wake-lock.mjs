/**
 * 自测 claude-wake.mjs 的单实例锁（P2 修复）。
 *   L1 有活着的守望 ⇒ 第二个实例必须跳过（不接管）
 *   L2 锁持有者进程已死 ⇒ 必须接管并写下自己的锁
 *   L3 退出时只删"属于自己的"锁 ⇒ 别人的锁不能被删
 *
 *   node C:\AI_ASSIST\work\scripts\test-claude-wake-lock.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SRC as SRCROOT, makeRoot, fakeAgentapi, isolatedEnv, stage, stageKernel, TEST_CONVERSATION_ID } from './lib/harness.mjs';

const WAKE_SRC = path.join(SRCROOT.claude, 'claude-wake.mjs');
const T = makeRoot('lock');
const LOCK = path.join(T, 'watch.lock');
const LOG = path.join(T, 'wake.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(T, 'agents', 'claude', 'inbox'), { recursive: true });
fs.copyFileSync(WAKE_SRC, path.join(T, 'claude-wake.mjs'));
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  identity: 'claude', mailboxRoot: T,
  allowFrom: ['dsh'], pollSeconds: 15, watchSeconds: 60,
}, null, 2));

const logText = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const start = () => spawn(process.execPath, [path.join(T, 'claude-wake.mjs')], { stdio: 'ignore', detached: false });

// L1 活着的守望 → 第二个实例跳过
const a = start();
await sleep(2500);
const aPid = JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid;
const b = start();
await new Promise((r) => b.on('exit', r));
record('L1 有活守望时第二实例跳过', /another watcher (is alive|holds the lock)/.test(logText()), logText().trim().split('\n').pop());

// L2 死锁持有者 → 接管
fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: Date.now() }, null, 2));
const c = start();
await sleep(2500);
const cLock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
record('L2 死锁持有者被接管', cLock.pid !== 999999 && /take over/.test(logText()), `lock.pid=${cLock.pid}`);

// L3 别人的锁不能被退出者删掉
const foreignPid = 999998;
fs.writeFileSync(LOCK, JSON.stringify({ pid: foreignPid, at: Date.now() }, null, 2));
c.kill('SIGTERM');
await sleep(1200);
const after = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : null;
record('L3 退出不删别人的锁', after?.pid === foreignPid, `lock=${JSON.stringify(after)}`);

a.kill('SIGTERM');
await sleep(600);
fs.rmSync(T, { recursive: true, force: true });
const bad = results.filter(([, ok]) => !ok).length;
console.log(`\n小结：${results.length - bad}/${results.length} 通过（a/b/c pid=${aPid}）`);
process.exitCode = bad === 0 ? 0 : 1;
