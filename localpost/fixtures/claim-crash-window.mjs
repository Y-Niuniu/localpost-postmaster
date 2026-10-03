/**
 * P0-3 崩溃窗口 fixture（codex 2026-10-03 审查）：在**本子进程**里执行 mailbox.archive / reply，
 * 原信一被移进 archive，就在下一次申请会话状态锁（把 claim 标成 done 的那一步）之前自杀——
 * 不释放锁、不跑 finally，等同断电。此时写锁已经释放，所以不会留下挡住重试的陈旧锁。
 *
 * 用法：node claim-crash-window.mjs <根目录> <archive|reply> <信 id> <调用聊天 id>
 * 没崩就在 stdout 打一行 'finished'；断言全部在父测试里做。
 * 为什么是落盘文件而不是 node -e：见 reply-then-hang.mjs 的说明（本机规则禁止内联脚本）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMailbox } from '../mailbox.mjs';

const [root, op, id, session] = process.argv.slice(2);
let archived = false;
const renameSync = fs.renameSync;
fs.renameSync = (from, to, ...rest) => {
  const out = renameSync(from, to, ...rest);
  if (/[\\/]archive[\\/]/.test(String(to))) archived = true;
  return out;
};
const open = fsp.open;
fsp.open = async (file, ...rest) => {
  if (archived && /[\\/]\.session-[^\\/]+\.lock$/.test(String(file))) process.kill(process.pid, 'SIGKILL');
  return open(file, ...rest);
};

const mail = createMailbox({ root, identity: 'dsh' });
const caller = { host: 'local', session };
if (op === 'archive') await mail.archive('dsh', id, { caller });
else if (op === 'reply') await mail.reply('dsh', { reply_to: id, body: 'Done', outcome: 'completed' }, { caller });
else { process.stderr.write('unknown op ' + op + '\n'); process.exit(2); }
process.stdout.write('finished\n');
