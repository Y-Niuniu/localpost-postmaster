/**
 * 写入见证（调用期，不是事后快照）：本进程往被盯的根写过什么。
 *
 * 为什么不用"整棵 runtime 树前后逐字节一致"：生产自动收信上线后（2026-10-05 用户已绑定），生产 receiver 每 30 秒
 * 重写一次 .mailbox/runtime/queues/dsh.json，真实来信还会写 arrivals/ 与 sessions/ —— 快照断言会被真实流量随机
 * 打红（同日实测：只有 queues/dsh.json 的哈希变了），而测试自己有没有写生产根反而说不清。
 *
 * node --test 每个测试文件一个进程，所以这里给本进程 fs / fs.promises 的写类调用套一层见证：本文件里任何代码路径
 * 只要往被盯的根写过一次就记下来（包括"建了又删"的瞬时写），生产宿主自己的写入与此无关。被测模块都是
 * `import fs from 'node:fs'` 再按属性调用；具名导入也经 syncBuiltinESMExports 同步到这里（Node v24.15.0 实测）。
 *
 * 用法：测试文件导入后 watch(PRODUCTION_ROOT)，最后断言 writesUnder(PRODUCTION_ROOT) 为空；
 * 另用 watch(临时根) 自检一次"被测代码的写盘确实经过见证"，免得见证失效还一路绿。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const roots = new Set();
const hits = [];
const normalize = value => path.resolve(value instanceof URL ? fileURLToPath(value) : String(value)).toLowerCase();
const rootOf = value => {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  const full = normalize(value);
  for (const root of roots) if (full === root || full.startsWith(root + path.sep)) return root;
  return null;
};

const WRITERS = ['writeFile', 'appendFile', 'open', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir', 'unlink', 'copyFile', 'cp',
  'truncate', 'link', 'symlink', 'utimes', 'chmod'];
const TWO_PATHS = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']);
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC;
// open 只有带写标志时才算写；其余写类调用一律算。
const isWrite = (base, args) => base !== 'open' ||
  (typeof args[1] === 'number' ? (args[1] & WRITE_FLAGS) !== 0 : /[wax+]/.test(String(args[1] ?? 'r')));

for (const api of [fs, fsp]) {
  for (const base of WRITERS) {
    for (const name of [base, base + 'Sync']) {
      const original = api[name];
      if (typeof original !== 'function') continue;
      api[name] = function witnessed(...args) {
        if (isWrite(base, args)) {
          for (const target of args.slice(0, TWO_PATHS.has(base) ? 2 : 1)) {
            const root = rootOf(target);
            if (root !== null) hits.push({ root, op: name, target: String(target) });
          }
        }
        return original.apply(this, args);
      };
    }
  }
}
syncBuiltinESMExports();

/** Starts watching `root` (and everything under it); returns a function that stops. */
export function watch(root) {
  const key = normalize(root);
  roots.add(key);
  return () => { roots.delete(key); };
}

/** Every write this process made under `root` while it was watched, as "op target" lines. */
export function writesUnder(root) {
  const key = normalize(root);
  return hits.filter(hit => hit.root === key).map(hit => hit.op + ' ' + hit.target);
}
