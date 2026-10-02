#!/usr/bin/env node
/**
 * LocalPost MCP 受控启动层：宿主（dsh）注册的入口是本文件；它按允许表构造环境，再启动**同目录固定的** mcp-server.mjs。
 *
 * 边界（如实写）：本进程自己仍会拿到宿主传来的完整环境（含宿主过滤后剩下的一切）；
 * 隔离的只是它再启动的 server 子进程。宿主那一层的环境本文件管不到。
 *
 * 实测（node v24.15.0 / Windows 11，2026-10-02；复现见 scripts/measure-mcp-env.mjs 与 docs/mcp-launch.md）：
 * - NODE_OPTIONS（--require / --import）和 OPENSSL_CONF（配置里的 provider 模块）会让 node 在本文件运行**之前**加载外部代码，
 *   本文件挡不住。宿主必须在建进程前把它们覆盖为空（注册配置的 env 里写成 ''）；这里再查一遍，没清掉就拒绝启动，
 *   但这只能事后发现，已经执行的预加载收不回来。
 * - 只给 spawn 一个干净的 env 对象**不够**：Node（libuv）会把父进程环境里的 PATH、USERPROFILE、USERNAME、HOMEDRIVE、
 *   HOMEPATH、LOGONSERVER、USERDOMAIN、SYSTEMROOT、SYSTEMDRIVE、WINDIR、TEMP 补进子进程。
 *   所以先取出允许的变量，再清空本进程环境，最后才启动子进程。
 * - 环境里没有 SystemRoot 时 node 启动即崩溃（ncrypto::CSPRNG 断言，退出码 134）；
 *   只给 SystemRoot + MAILBOX_* 时 server 能完成握手并跑通全部 7 个工具。windir / SystemDrive / TEMP / TMP 都不是必需。
 *
 * server 随本进程结束，靠三条互相独立的路径（测试里逐条单独验证过）：
 * 1. 非 detached 启动：本进程被强制结束（SDK 关闭时的 kill，在 Windows 上是 TerminateProcess）时，server 被一并终止
 *    （Node 文档：Windows 上只有 detached 的子进程能在父进程退出后继续运行）；
 * 2. 本进程因 JS 层面的异常退出时，'exit' 处理里先结束 server；
 * 3. 宿主（Node 的 ChildProcess）在本进程退出时关掉 stdin 管道，server 读到 EOF 后自行退出。
 *
 * MAILBOX_ENV_REPORT=1 时：本文件往 stderr 写 server 的 pid 和入口；server 自己再写一行它实际收到的变量**名**（永不写值）。
 * 本进程不读写 stdout/stdin（stdio 原样交给 server），所以不会弄乱 MCP 报文。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Windows 上 process.env 按名取值不区分大小写：systemroot / SYSTEMROOT 都能取到，统一成这里的写法交给 server。
const ALLOWED = ['SystemRoot', 'MAILBOX_ROOT', 'MAILBOX_IDENTITY', 'MAILBOX_ADMIN', 'MAILBOX_TOOLS', 'MAILBOX_ENV_REPORT'];
const CODE_LOADERS = ['NODE_OPTIONS', 'OPENSSL_CONF'];
const SERVER = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

function fail(message) {
  process.stderr.write('[mcp-launch] ' + message + '\n');
  process.exitCode = 2;
}

function main() {
  if (process.argv.length > 2) return fail('takes no arguments; the server entry is fixed: ' + SERVER);
  const loaders = CODE_LOADERS.filter(name => process.env[name]);
  if (loaders.length) return fail(`refusing to start: the host must clear ${loaders.join(', ')} before creating this process (set to '' in the registration env)`);
  const report = process.env.MAILBOX_ENV_REPORT === '1';
  // 显式设成空串的变量（如 MAILBOX_TOOLS=''）也照传：server 要靠它区分「未设置」和「显式为空 → fail closed」。
  const env = {};
  for (const name of ALLOWED) if (process.env[name] !== undefined) env[name] = process.env[name];
  // 清空本进程环境：否则 Node 会把这里的 PATH、USERPROFILE 等补回子进程（见文件头）。
  for (const name of Object.keys(process.env)) delete process.env[name];
  const left = Object.keys(process.env);
  if (left.length) return fail('cannot clear the launcher environment: ' + left.join(','));
  const child = spawn(process.execPath, [SERVER], { env, stdio: 'inherit', windowsHide: true, detached: false });
  process.on('exit', () => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  child.on('error', error => fail('cannot start the server: ' + error.message));
  child.on('spawn', () => {
    if (report) process.stderr.write(`[mcp-launch] server pid=${child.pid} entry=${SERVER}\n`);
  });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

main();
