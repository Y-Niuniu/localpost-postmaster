/**
 * 自测 gemini wake.mjs 的状态语义（P1-3 修复）。
 * 场景：
 *   S1 首次运行只记基线
 *   S2 已送达（sentAt）→ 跳过，不再重试
 *   S3 旧格式"演练"记录（lastResult='sent' + lastOut 含 dryRun）→ 迁移为仍待发
 *   S4 dryRun 模式：不真发、不消耗（写 dryRunAt）
 *   S5 dryRun 关掉 + agentapi 不存在 → 失败计数 attempts=1（不再写 sent）
 *   S6 反复跑到 maxAttempts → exhausted，不再尝试
 *   S7 旧格式"真送达"记录 → 迁移为 sentAt → 跳过
 *
 *   node C:\AI_ASSIST\work\scripts\test-gemini-wake-state.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = 'C:/Users/16548/.gemini/config/sidecars/localpost-gemini-wake';
const T = path.resolve('C:/AI_ASSIST/work/tmp_gemini_state');
const INBOX = path.join(T, 'agents', 'gemini', 'inbox');
const STATE = path.join(T, 'wake-state.json');
const LOG = path.join(T, 'wake.log');

const checks = [];
const record = (name, ok, detail = '') => { checks.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`); };

function setup({ dryRun, state = null, letters = [] }) {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(INBOX, { recursive: true });
  fs.copyFileSync(path.join(SRC_DIR, 'wake.mjs'), path.join(T, 'wake.mjs'));
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    identity: 'gemini', conversationId: '1f58f9ab-50c8-4963-b181-876abc0da445',
    mailboxRoot: 'C:/AI_ASSIST/work/tmp_gemini_state', allowFrom: ['dsh'],
    dryRun, maxAttemptsPerLetter: 3, pollSeconds: 15, watchSeconds: 60,
  }, null, 2));
  if (state) fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  for (const l of letters) fs.writeFileSync(path.join(INBOX, `${l.id}.json`), JSON.stringify(l, null, 2));
}
const letter = (id) => ({ id, thread_id: 'selftest', from: 'dsh', to: 'gemini', type: 'task', subject: `自测 ${id}`, body: '正文', budget: 'standard', created_at: new Date().toISOString() });
const run = () => spawnSync(process.execPath, [path.join(T, 'wake.mjs')], { encoding: 'utf8' });
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');

// S1 基线
setup({ dryRun: false, letters: [letter('old-1')] });
run();
record('S1 首次运行只记基线', readState().seen['old-1']?.note === 'baseline', JSON.stringify(readState().seen['old-1']));

// S2 已送达 → 跳过
setup({ dryRun: false, letters: [letter('a-1')], state: { baselineAt: 'x', seen: { 'a-1': { firstSeenAt: 'x', attempts: 1, sentAt: 'y', lastResult: 'sent' } } } });
let r = run();
record('S2 已送达不再重试', /no new mail/.test(readLog()) && readState().seen['a-1'].attempts === 1, readLog().trim().split('\n').pop());

// S3 旧格式"演练" → 迁移为待发（dryRun 模式只记 dryRunAt）
setup({ dryRun: true, letters: [letter('b-1')], state: { baselineAt: 'x', seen: { 'b-1': { firstSeenAt: 'x', attempts: 1, lastResult: 'sent', lastOut: '(dryRun: not sent)' } } } });
run();
const s3 = readState().seen['b-1'];
record('S3 旧"演练"记录迁移为待发且演练不消耗', !s3.sentAt && !!s3.dryRunAt, JSON.stringify(s3));

// S4/S5/S6 dryRun 关掉 + agentapi 不存在 → 失败计数，重试到上限
setup({ dryRun: false, letters: [letter('c-1')], state: { baselineAt: 'x', seen: { 'c-1': { firstSeenAt: 'x', attempts: 0, dryRunAt: 'y' } } } });
run();
const a1 = readState().seen['c-1'];
record('S5 失败计入 attempts 且不写 sent', !!a1.lastResult && !a1.sentAt && a1.attempts === 1, JSON.stringify(a1).slice(0, 140));
run(); const a2 = readState().seen['c-1'];
run(); const a3 = readState().seen['c-1'];
run(); const a4 = readState().seen['c-1'];
record('S6 重试到 maxAttempts=3 后 exhausted 且不再尝试', a3.attempts === 3 && a4.attempts === 3, `attempts 3=${a3.attempts}, 4=${a4.attempts}, note=${a3.lastResult}`);
record('S5b 第二轮确实重试了（attempts 递增）', a2.attempts === 2, `attempts=${a2.attempts}`);

// S7 旧格式"真送达" → 迁移为 sentAt
setup({ dryRun: false, letters: [letter('d-1')], state: { baselineAt: 'x', seen: { 'd-1': { firstSeenAt: 'x', attempts: 1, lastResult: 'sent', lastOut: '{"response":{"sendMessage":{}}}' } } } });
run();
record('S7 旧"真送达"迁移为 sentAt 且跳过', !!readState().seen['d-1'].sentAt && /no new mail/.test(readLog()), JSON.stringify(readState().seen['d-1']).slice(0, 120));

fs.rmSync(T, { recursive: true, force: true });
const bad = checks.filter(([, ok]) => !ok).length;
console.log(`\n小结：${checks.length - bad}/${checks.length} 通过；临时根已删 ${T}`);
process.exitCode = bad === 0 ? 0 : 1;
