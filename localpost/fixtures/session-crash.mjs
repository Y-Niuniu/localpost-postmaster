/**
 * 轮换 / 派发崩溃恢复测试用的子进程 fixture。
 *
 * 行为：按 LP_ACTION 跑一次轮换（begin + run）或派发一封信（dispatchLetter）；
 * 走到 LP_CRASH 指定的崩溃点时，先写屏障文件告诉父进程「到点了」，然后**同步阻塞**，等父进程硬杀。
 * 父进程杀掉它之后，用同一个信箱根和同一个落盘假宿主做恢复，检查不丢信、不重复受理、不重复建会话。
 *
 * 崩溃点（LP_CRASH）：
 *   state:<轮换状态>      该状态刚原子落盘之后 —— 此时子进程还握着状态锁和 actor 租约
 *   candidate:requested  「要建候选会话」的写前记录刚落盘，还没调宿主
 *   handoff:file         交接文件已原子落盘，轮换日志还没记它的 digest
 *   host:created         宿主已建好候选会话，回包还没记进日志
 *   host:retired         宿主已退役旧会话，日志还没记 retired
 *   claim:dispatching    某封信的 dispatching 写前记录刚落盘，还没调宿主
 *   host:submitted       宿主已受理某封信，结果还没记账
 *
 * 为什么是落盘文件而不是 node -e：见 reply-then-hang.mjs 的说明（本机规则禁止内联脚本）。
 *
 * 环境变量：LP_ROOT 信箱根 / LP_IDENTITY 身份 / LP_ACTION rotate|dispatch / LP_CRASH 崩溃点 /
 *          LP_BARRIER 屏障文件 / LP_HOST 假宿主行为（JSON，可省）/ LP_LETTER 要派发的信（JSON：{id, digest}）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createSessionStore } from '../session-binding.mjs';
import { dispatchLetter } from '../letter-claims.mjs';
import { createRotation } from '../rotation.mjs';
import { createFakeHost } from './fake-session-host.mjs';

const { LP_ROOT: root, LP_IDENTITY: identity, LP_ACTION: action, LP_CRASH: crash, LP_BARRIER: barrier } = process.env;
const stateFile = path.resolve(root, 'runtime', 'sessions', `${identity}.json`);
const hang = () => { fs.writeFileSync(barrier, crash); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };

const persisted = state => {
  const journals = Object.values(state.rotations);
  if (crash.startsWith('state:')) return journals.some(journal => journal.state === crash.slice(6));
  if (crash === 'candidate:requested') return journals.some(journal => journal.state === 'handoff_written' && journal.candidate?.status === 'requested');
  if (crash === 'claim:dispatching') return Object.values(state.claims).some(claim => claim.status === 'dispatching');
  return false;
};
const rename = fsp.rename;
fsp.rename = async (from, to) => {
  await rename(from, to);
  if (crash === 'handoff:file' && path.resolve(to).includes(`${path.sep}handoffs${path.sep}`)) hang();
  if (path.resolve(to) === stateFile && persisted(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) hang();
};

const host = createFakeHost({ root, behavior: JSON.parse(process.env.LP_HOST || '{}') });
for (const [method, point] of [['createSession', 'host:created'], ['retireSession', 'host:retired'], ['submit', 'host:submitted']]) {
  const original = host[method];
  host[method] = async (...args) => { const result = await original(...args); if (crash === point) hang(); return result; };
}

const store = createSessionStore({ root });
if (action === 'rotate') {
  const rotation = createRotation({ store, host });
  await rotation.begin(identity, { reason: 'operator' });
  await rotation.run(identity);
} else await dispatchLetter(store, identity, JSON.parse(process.env.LP_LETTER), host);
// 走到这里说明崩溃点没被触发：用非零退出码让父进程的断言失败，而不是悄悄通过。
process.exitCode = 3;
