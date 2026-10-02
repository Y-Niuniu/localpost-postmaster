/**
 * mcp-launch 测试用的假 server。测试把它复制成临时目录里的 `mcp-server.mjs`，
 * 与复制过去的 mcp-launch.mjs 放在同一目录（启动层只认同目录的固定入口）。
 *
 * 行为：启动后立刻往 stdout 写一行 JSON —— 本进程的 pid 和**实际收到的**环境变量名（不写值）；
 * 之后只有从 stdin 收到 `exit` 这一行才退出，**stdin 结束本身不退出**。
 * 原因（实测）：启动层被杀时，没被 job object 带走的子进程会收到 stdin end；如果假 server 借此自己退出，
 * 「启动层被杀后 server 也结束」的测试就分不清是 job object 生效，还是 server 自己走了。
 *
 * 为什么是落盘文件而不是 node -e：见 reply-then-hang.mjs 的说明（本机规则禁止内联脚本）。
 */
process.stdout.write(JSON.stringify({ pid: process.pid, names: Object.keys(process.env).sort() }) + '\n');
const keepAlive = setInterval(() => {}, 1 << 30);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.split('\n').includes('exit')) { clearInterval(keepAlive); process.stdin.destroy(); }
});
