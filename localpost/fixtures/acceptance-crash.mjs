/**
 * 受理提供者崩溃恢复测试用的子进程 fixture。
 *
 * 行为：对 LP_LETTER 调一次 acceptOnce；走到 LP_CRASH 指定的崩溃点时，先写屏障文件告诉父进程「到点了」，
 * 然后同步阻塞，等父进程硬杀。父进程用同一个信箱根恢复，检查唤醒绝不超过一次。
 *   claim:dispatching   dispatching 写前记录刚落盘，还没唤醒会话
 *   host:enqueued       会话已被唤醒（enqueued.log 已记一行），受理结果还没记账
 *
 * 为什么是落盘文件而不是 node -e：见 reply-then-hang.mjs 的说明（本机规则禁止内联脚本）。
 * 环境变量：LP_ROOT / LP_IDENTITY / LP_CRASH / LP_BARRIER / LP_LETTER（{id, digest}）/ LP_TARGET（解析好的目标）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createSessionStore } from '../session-binding.mjs';
import { createLedgerAcceptance } from '../ledger-acceptance.mjs';

const { LP_ROOT: root, LP_IDENTITY: identity, LP_CRASH: crash, LP_BARRIER: barrier } = process.env;
const letter = JSON.parse(process.env.LP_LETTER), target = JSON.parse(process.env.LP_TARGET);
const stateFile = path.resolve(root, 'runtime', 'sessions', `${identity}.json`);
const hang = () => { fs.writeFileSync(barrier, crash); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };

const rename = fsp.rename;
fsp.rename = async (from, to) => {
  await rename(from, to);
  if (crash === 'claim:dispatching' && path.resolve(to) === stateFile &&
      JSON.parse(fs.readFileSync(stateFile, 'utf8')).claims[letter.id]?.status === 'dispatching') hang();
};

const acceptance = createLedgerAcceptance({ store: createSessionStore({ root }), identity });
await acceptance.acceptOnce({ key: `${identity}:${letter.id}`, target, messageReference: { agent: identity, id: letter.id }, digest: letter.digest }, async () => {
  fs.appendFileSync(path.join(root, 'enqueued.log'), letter.id + '\n');
  if (crash === 'host:enqueued') hang();
});
// 走到这里说明崩溃点没被触发：用非零退出码让父进程的断言失败。
process.exitCode = 3;
