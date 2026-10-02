/**
 * 崩溃恢复测试用的子进程 fixture。
 *
 * 行为：调用 mailbox.reply 发布回执；当写操作走到「归档原信」的 rename 时，
 * 先写屏障文件告诉父进程「回执已公开」，然后**同步阻塞**，等父进程硬杀。
 * 这样父进程就能确定性地复现「发布成功、归档未完成、持有写租约的进程已死」。
 *
 * 为什么是文件而不是 node -e：本机规则（AGENTS.md）禁止 node -e 内联脚本
 * —— 卡巴斯基 PDM 会把「读用户目录 / 写文件」的内联脚本判为 Exploit 拦截，
 * 症状是命令无输出且不报错。测试脚本本身就做文件操作，所以必须落盘后用
 * 文件路径启动。
 *
 * 环境变量：
 *   LP_ROOT         信箱根
 *   LP_BARRIER      屏障文件路径（archive rename 前写入）
 *   LP_REPLY        传给 mailbox.reply 的参数（JSON）
 *   LP_MAILBOX_URL  mailbox.mjs 的 file:// URL
 */
import fs from 'node:fs';
import path from 'node:path';

const { createMailbox } = await import(process.env.LP_MAILBOX_URL);
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).includes(path.sep + 'archive' + path.sep)) {
    fs.writeFileSync(process.env.LP_BARRIER, 'published');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return rename(from, to);
};
await createMailbox({ root: process.env.LP_ROOT, identity: 'codex' }).reply('codex', JSON.parse(process.env.LP_REPLY));
