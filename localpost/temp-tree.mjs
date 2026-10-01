/**
 * 测试支持：Windows 上删除临时目录会瞬时失败。
 *
 * 已确认根因（2026-10-01，改前 30 轮基线中复现）：
 *   mailbox.test.mjs after 钩子 fs.rmSync() 报
 *   EPERM: Permission denied ... \\?\C:\...\.localpost-tmp\mailbox\case-xxxx
 * 这是文件系统句柄释放/索引器扫描造成的**瞬时** EPERM，
 * 与业务断言无关 —— 但会让整套测试随机变红（假红灯会掩盖真回归）。
 *
 * 处理：只对可恢复错误码重试（指数退避），非瞬时错误立刻抛出；
 * 重试耗尽仍失败则抛出最后一次错误（不吞掉真实泄漏）。
 * remover 可注入，便于确定性地回归测试这条逻辑本身。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function removeTree(dir, { attempts = 6, delayMs = 25, remover } = {}) {
  const erase = remover || ((target) => fsp.rm(target, { recursive: true, force: true }));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { await erase(dir); return { removed: true, attempts: attempt }; }
    catch (error) {
      last = error;
      if (!TRANSIENT.has(error.code)) throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw last;
}

export function removeTreeSync(dir, { attempts = 6, delayMs = 25, remover } = {}) {
  const erase = remover || ((target) => fs.rmSync(target, { recursive: true, force: true }));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { erase(dir); return { removed: true, attempts: attempt }; }
    catch (error) {
      last = error;
      if (!TRANSIENT.has(error.code)) throw error;
      if (attempt < attempts) sleepSync(delayMs * attempt);
    }
  }
  throw last;
}

export function isTransient(error) {
  const code = error?.code || (/^EPERM|^EBUSY|^ENOTEMPTY|^EACCES/.exec(String(error?.message || ''))?.[0]);
  return TRANSIENT.has(code);
}
