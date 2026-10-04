/**
 * 测试隔离回归门禁。
 *
 * 背景（codex 2026-10-04 对 c469904 的复审 P2）：旧自测的配置用例 `readyLineOf` 只传 root/kernelPath，
 * 没给 stateFile/logFile；而 `lib/index.js:133-136` 在 DSH_HOME 未设置时默认写
 * `~/.dsh/localpost-postmaster/`，`scripts/test.mjs` 也没隔离 DSH_HOME ⇒ 跑测试会污染真实用户日志
 * （真实证据：plugin.log 里出现过 `cfgroot-*` fixture 记录）。
 *
 * 本测试锁住三件事：
 *   1. **直接运行** legacy 自测（显式清掉 DSH_HOME，模拟用户直接敲 `node test/selftest.mjs`）
 *      仍然 45/45、exit 0；
 *   2. 真实用户目录 `~/.dsh/localpost-postmaster/` 的 plugin.log / state.json **哈希前后不变**
 *      —— 谁把默认路径改回去（或去掉 readyLineOf 的显式 state/log），这里就红；
 *   3. **非空转**：这次运行确实写了插件日志，但写在隔离 fixture 里。
 * 另加源码门禁：`scripts/test.mjs` 必须设置 DSH_HOME。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './temp-tree.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL_DIR = path.join(os.homedir(), '.dsh', 'localpost-postmaster');
const sha256 = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

test('直接跑 legacy 自测也不碰真实用户目录（含真实日志哈希不变 + 非空转证据）', () => {
  const tmp = path.join(os.tmpdir(), 'localpost-isolation-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const realBefore = {
      log: sha256(path.join(REAL_DIR, 'plugin.log')),
      state: sha256(path.join(REAL_DIR, 'state.json')),
    };

    const env = {
      ...process.env,
      TEMP: tmp, TMP: tmp, TMPDIR: tmp,
      LOCALPOST_MAILBOX: path.join(REPO, 'localpost'),
    };
    delete env.DSH_HOME;   // 关键：模拟"用户直接跑"，没有任何外部隔离兜底

    const run = spawnSync(process.execPath, [path.join(REPO, 'test', 'selftest.mjs')], {
      cwd: REPO, encoding: 'utf8', env,
    });
    const out = String(run.stdout || '') + String(run.stderr || '');

    assert.equal(run.status, 0, 'legacy 自测退出码应为 0，末尾输出：' + out.slice(-400));
    assert.match(out, /自测小结: 45\/45 通过/, 'legacy 自测应 45/45 通过');

    // 真实用户目录：哈希必须一字不变（不存在则仍不存在）
    assert.equal(sha256(path.join(REAL_DIR, 'plugin.log')), realBefore.log,
      '真实用户 plugin.log 被测试改写了（测试隔离回潮）');
    assert.equal(sha256(path.join(REAL_DIR, 'state.json')), realBefore.state,
      '真实用户 state.json 被测试改写了（测试隔离回潮）');

    // 非空转：日志确实写了，但写在隔离 fixture 里
    const fixtureLog = path.join(tmp, 'localpost-selftest', 'plugin.log');
    assert.ok(fs.existsSync(fixtureLog), '隔离 fixture 里应有 plugin.log（否则上面的哈希断言可能是空转）');
    assert.match(fs.readFileSync(fixtureLog, 'utf8'), /插件就绪/, '隔离 fixture 日志应含插件启动记录');
  } finally {
    removeTreeSync(tmp, { attempts: 5, delayMs: 50 });
  }
});

test('源码门禁：scripts/test.mjs 必须隔离 DSH_HOME', () => {
  const source = fs.readFileSync(path.join(REPO, 'scripts', 'test.mjs'), 'utf8');
  assert.match(source, /DSH_HOME/, 'scripts/test.mjs 未设置 DSH_HOME —— 测试会写进真实用户目录');
  assert.match(source, /isolatedHome|dsh-home/, 'scripts/test.mjs 应指向隔离的 DSH_HOME 目录');
});
