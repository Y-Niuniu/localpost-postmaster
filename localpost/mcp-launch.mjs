#!/usr/bin/env node
/**
 * LocalPost MCP 受控启动层：宿主（dsh）注册的入口是本文件；它按允许表构造环境，再启动**同目录固定的** mcp-server.mjs。
 *
 * 边界（如实写）：本进程自己仍会拿到宿主传来的完整环境（含宿主过滤后剩下的一切）；
 * 隔离的只是它再启动的 server 子进程。宿主那一层的环境本文件管不到。
 *
 * 实测（node v24.15.0 / Windows 11，2026-10-02；复现见 scripts/measure-mcp-env.mjs 与 docs/mcp-launch.md）：
 * - 只给 spawn 一个干净的 env 对象**不够**：Node（libuv）会把父进程环境里的 PATH、USERPROFILE、USERNAME、HOMEDRIVE、
 *   HOMEPATH、LOGONSERVER、USERDOMAIN、SYSTEMROOT、SYSTEMDRIVE、WINDIR、TEMP 补进子进程。
 *   所以先取出允许的变量，再清空本进程环境，最后才启动子进程。
 * - 环境里没有 SystemRoot 时 node 启动即崩溃（ncrypto::CSPRNG 断言，退出码 134）；
 *   只给 SystemRoot + MAILBOX_* 时 server 能完成握手并跑通全部 7 个工具。windir / SystemDrive / TEMP / TMP 都不是必需。
 * - 本进程被强制结束（SDK 关闭时的 kill，在 Windows 上是 TerminateProcess）时，server 被一并终止；
 *   改成 detached 启动时则不会（Node 文档：Windows 上只有 detached 的子进程能在父进程退出后继续运行）。所以这里不能用 detached。
 *
 * MAILBOX_ENV_REPORT=1 时往 stderr 写一行：server 的 pid、入口路径和交给它的变量**名**（永不写值）。
 * 本进程不读写 stdout/stdin（stdio 原样交给 server），所以不会弄乱 MCP 报文。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Windows 上 process.env 按名取值不区分大小写：systemroot / SYSTEMROOT 都能取到，统一成这里的写法交给 server。
const ALLOWED = ['SystemRoot', 'MAILBOX_ROOT', 'MAILBOX_IDENTITY', 'MAILBOX_ADMIN', 'MAILBOX_TOOLS'];
const SERVER = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

function fail(message) {
  process.stderr.write('[mcp-launch] ' + message + '\n');
  process.exitCode = 2;
}

function main() {
  if (process.argv.length > 2) return fail('takes no arguments; the server entry is fixed: ' + SERVER);
  const report = process.env.MAILBOX_ENV_REPORT === '1';
  // 显式设成空串的变量（如 MAILBOX_TOOLS=''）也照传：server 要靠它区分「未设置」和「显式为空 → fail closed」。
  const env = {};
  for (const name of ALLOWED) if (process.env[name] !== undefined) env[name] = process.env[name];
  // 清空本进程环境：否则 Node 会把这里的 PATH、USERPROFILE 等补回子进程（见文件头）。
  for (const name of Object.keys(process.env)) delete process.env[name];
  const left = Object.keys(process.env);
  if (left.length) return fail('cannot clear the launcher environment: ' + left.join(','));
  const child = spawn(process.execPath, [SERVER], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => fail('cannot start the server: ' + error.message));
  child.on('spawn', () => {
    if (report) process.stderr.write(`[mcp-launch] server pid=${child.pid} entry=${SERVER} env=${Object.keys(env).sort().join(',')}\n`);
  });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

main();
