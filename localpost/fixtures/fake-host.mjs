/**
 * 进程树测试用的假宿主：像 dsh 的 MCP SDK 那样（stdio 管道、非 detached、windowsHide）启动 argv[2] 指向的启动层，
 * 等启动层后面的 server（假 server）报出 pid 后，把「启动层 pid + server pid」写成一行 JSON 到自己的 stdout，
 * 然后一直活着，等测试把它硬杀 —— 用来模拟 dsh 崩溃时整棵进程树能否一起结束。
 *
 * 为什么是落盘文件而不是 node -e：见 reply-then-hang.mjs 的说明（本机规则禁止内联脚本）。
 */
import { spawn } from 'node:child_process';

const launcher = spawn(process.execPath, [process.argv[2]], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
let output = '';
launcher.stdout.setEncoding('utf8');
launcher.stdout.on('data', function first(chunk) {
  output += chunk;
  const end = output.indexOf('\n');
  if (end < 0) return;
  launcher.stdout.off('data', first);
  process.stdout.write(JSON.stringify({ launcher: launcher.pid, server: JSON.parse(output.slice(0, end)).pid }) + '\n');
});
setInterval(() => {}, 1 << 30);
