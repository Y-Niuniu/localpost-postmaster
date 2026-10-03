/**
 * 完成窗口崩溃 fixture（codex 2026-10-03 审查 P0-3 / 第三轮）：在**本子进程**里执行 mailbox.archive / reply，
 * 在指定的点自杀——不释放锁、不跑 finally，等同断电。两个点都选在锁已释放、下一把锁尚未建立的时刻，
 * 所以不会留下挡住重试的陈旧锁。
 *   after-archive（默认）：原信一被移进 archive，就在申请会话状态锁（把 claim 标成 done）之前自杀；
 *   before-publish：completing 意图已落盘，就在申请写锁（发布回执 / 归档）之前自杀，什么都还没发布。
 *
 * 用法：node claim-crash-window.mjs <根目录> <archive|reply> <信 id> <调用聊天 id> [after-archive|before-publish] [调用聊天工作目录]
 * 没崩就在 stdout 打一行 'finished'；断言全部在父测试里做。
 * 为什么是落盘文件而不是 node -e：见 reply-then-hang.mjs 的说明（本机规则禁止内联脚本）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMailbox } from '../mailbox.mjs';

const [root, op, id, session, point = 'after-archive', cwd] = process.argv.slice(2);
if (!['after-archive', 'before-publish'].includes(point)) { process.stderr.write('unknown point ' + point + '\n'); process.exit(2); }
let archived = false;
const renameSync = fs.renameSync;
fs.renameSync = (from, to, ...rest) => {
  const out = renameSync(from, to, ...rest);
  if (/[\\/]archive[\\/]/.test(String(to))) archived = true;
  return out;
};
const open = fsp.open;
fsp.open = async (file, ...rest) => {
  const name = String(file);
  if (point === 'after-archive' && archived && /[\\/]\.session-[^\\/]+\.lock$/.test(name)) process.kill(process.pid, 'SIGKILL');
  if (point === 'before-publish' && /[\\/]\.mailbox-write\.lock$/.test(name)) process.kill(process.pid, 'SIGKILL');
  return open(file, ...rest);
};

const mail = createMailbox({ root, identity: 'dsh' });
const caller = { host: 'local', session, ...(cwd ? { cwd } : {}) };
if (op === 'archive') await mail.archive('dsh', id, { caller });
else if (op === 'reply') await mail.reply('dsh', { reply_to: id, body: 'Done', outcome: 'completed' }, { caller });
else { process.stderr.write('unknown op ' + op + '\n'); process.exit(2); }
process.stdout.write('finished\n');
