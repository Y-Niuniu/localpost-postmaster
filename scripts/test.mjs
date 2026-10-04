import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const temporary = path.join(root, '.localpost-tmp', 'suite');
fs.mkdirSync(temporary, { recursive: true });
/*
 * 测试必须在**隔离环境**下跑：
 *   · TEMP/TMP/TMPDIR —— fixture 临时区
 *   · DSH_HOME        —— lib/index.js 在 DSH_HOME 未设置时会把插件 state/log 落到真实用户目录
 *                        (~/.dsh/localpost-postmaster)，历史测试因此污染过真实 plugin.log；
 *                        这里显式指向临时区，直接跑旧自测也不碰用户目录
 *   · LOCALPOST_MAILBOX —— 内核 fixture 根（legacy 自测用）
 * 回归门禁见 localpost/test-isolation.test.mjs（哨兵 + 真实日志哈希不变）。
 */
const isolatedHome = path.join(temporary, 'dsh-home');
fs.mkdirSync(isolatedHome, { recursive: true });
const isolatedEnv = {
  ...process.env,
  TEMP: temporary,
  TMP: temporary,
  TMPDIR: temporary,
  DSH_HOME: isolatedHome,
};
const tests = fs.readdirSync(path.join(root, 'localpost')).filter(x => x.endsWith('.test.mjs')).map(x => `localpost/${x}`);
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', env: isolatedEnv });
if (result.error) console.error(result.error.message);
if (result.status === 0) {
  const legacy = spawnSync(process.execPath, ['test/selftest.mjs'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...isolatedEnv, LOCALPOST_MAILBOX: path.join(root, 'localpost') },
  });
  if (legacy.error) console.error(legacy.error.message);
  process.exitCode = legacy.status ?? 1;
} else process.exitCode = result.status ?? 1;
