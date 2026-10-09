/**
 * 验证套件共用夹具助手（测试隔离铁律 —— 2026-10-06 GPT 复审后加固）
 *
 * 四条规矩：
 *   1) **被测源码从本仓库取**（`integrations/` + `localpost/`）⇒ 克隆仓库即可复现本提交；
 *      不再指向 `C:/Users/<user>/...` 的生产桥或仓库外 wrapper。
 *   2) 每个用例在**临时根**里跑（系统 temp），不碰生产目录、生产信箱。
 *   3) 一律显式隔离环境：临时 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` + **假 `agentapi` 前置 PATH**
 *      ⇒ 既不依赖"本机恰巧没有该命令"，也**永远不会真发消息**（旧夹具靠"命令不存在"来避免真发，
 *      GPT 指出那是侥幸：夹具继承 PATH + dryRun=false + 真实会话 id 时，装了 agentapi 的机器会真唤醒）。
 *   4) 测试用 `conversationId` 是**专用测试 UUID**，绝不使用生产会话 id。
 *
 * 用法：
 *   import { SRC, makeRoot, fakeAgentapi, isolatedEnv, TEST_CONVERSATION_ID } from './lib/harness.mjs';
 *   const root = makeRoot('gemini');
 *   const api = fakeAgentapi(root, { exitCode: 1 });          // 想模拟失败就换退出码
 *   spawnSync(process.execPath, [staged,], { env: isolatedEnv(root, api) });
 *   readCalls(api.calls)                                       // 断言"到底有没有被调用"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 仓库根：<repo>/integrations/verification/lib/harness.mjs → <repo> */
export const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

/** 被测源码（全部在仓库内） */
export const SRC = {
  wrapper: path.join(REPO, 'integrations', 'dsh-mailbox-mcp', 'server.mjs'),
  bridges: path.join(REPO, 'integrations', 'bridges'),
  kernel: path.join(REPO, 'localpost'),
  gemini: path.join(REPO, 'integrations', 'bridges', 'gemini'),
  claude: path.join(REPO, 'integrations', 'bridges', 'claude'),
  codex: path.join(REPO, 'integrations', 'bridges', 'codex'),
  // 收信聊天开关（2026-10-09）：与每个桥部署在同一目录的 wake-binding.mjs + localpost-switch.mjs
  shared: path.join(REPO, 'integrations', 'bridges', 'shared'),
};

/** 专用测试会话 id（**不是**生产会话 id） */
export const TEST_CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';

export function makeRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `localpost-verify-${tag}-`));
}

/** 在临时根里建一个"假 agentapi"：记录调用、可控退出码与 stdout。 */
export function fakeAgentapi(root, { exitCode = 0, stdout = '{"response":{"sendMessage":{"recipientId":"TEST"}}}' } = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(root, 'agentapi-calls.log');
  fs.writeFileSync(path.join(bin, 'agentapi.cmd'),
    `@echo off\r\necho %* >> "${calls}"\r\necho ${stdout}\r\nexit /b ${exitCode}\r\n`, 'ascii');
  fs.writeFileSync(path.join(bin, 'agentapi'),
    `#!/bin/sh\necho "$@" >> "${calls}"\necho '${stdout}'\nexit ${exitCode}\n`, 'utf8');
  return { bin, calls };
}

export const readCalls = (calls) => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);

/**
 * 隔离环境：假 agentapi 前置 PATH + 临时 DATA 目录。
 * 传 api 则用它的 bin；不传则临时造一个"永远失败"的，避免任何真实命令被解析到。
 */
export function isolatedEnv(root, api = null, extra = {}) {
  const bin = api?.bin ?? fakeAgentapi(root, { exitCode: 1 }).bin;
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });   // 脚本会往 DATA 写状态/日志：目录必须先存在
  return {
    ...process.env,
    PATH: bin + path.delimiter + (process.env.PATH ?? ''),
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
    ...extra,
  };
}

/** 把被测脚本拷进临时根（脚本用 import.meta.dirname 定位自己的 config/state/log）。 */
export function stage(srcFile, root, name = null) {
  const dest = path.join(root, name ?? path.basename(srcFile));
  fs.copyFileSync(srcFile, dest);
  return dest;
}

/** 拷内核闭包（mailbox.mjs 及其同目录依赖）到临时根，供 wrapper 用 LOCALPOST_MAILBOX_API 指过去。 */
export function stageKernel(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const f of fs.readdirSync(SRC.kernel).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
    fs.copyFileSync(path.join(SRC.kernel, f), path.join(root, f));
  }
  return path.join(root, 'mailbox.mjs');
}
