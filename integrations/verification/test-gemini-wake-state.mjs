/**
 * 自测 gemini wake.mjs 的状态语义（P1-3 修复）。
 *
 * 隔离（2026-10-06 GPT 复审后加固）：
 *   - 被测源码 = **本仓库** `integrations/bridges/gemini/wake.mjs`（不是生产目录）；
 *   - 一律 `isolatedEnv()`：假 `agentapi` 前置 PATH + 临时 ANTIGRAVITY_EXECUTABLE_DATA_DIR
 *     ⇒ **永不真发消息**，也不依赖"本机没有该命令"；调用次数可从 `agentapi-calls.log` 断言；
 *   - conversationId 用专用测试 UUID（`TEST_CONVERSATION_ID`），不是生产会话。
 *
 * 场景：
 *   S1 首次运行只记基线（不发送）
 *   S2 已送达（sentAt）→ 跳过，不再重试（不发送）
 *   S3 旧格式"演练"记录迁移为仍待发 + dryRun 模式不消耗（不发送）
 *   S4 真实发送成功（假 agentapi 退出码 0）→ sentAt 落盘，且**恰好调用 1 次**
 *   S5 发送失败（退出码 1）→ 计 attempts、不写 sent（调用 1 次）
 *   S6 重试到 maxAttempts=3 → exhausted；再跑不再调用（总调用=3）
 *   S7 旧格式"真送达"迁移为 sentAt → 跳过（不发送）
 *
 *   node integrations/verification/test-gemini-wake-state.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SRC, TEST_CONVERSATION_ID, makeRoot, fakeAgentapi, isolatedEnv, readCalls, stage } from './lib/harness.mjs';

const T = makeRoot('gemini');
const INBOX = path.join(T, 'agents', 'gemini', 'inbox');
// 脚本把状态/日志写在 DATA = ANTIGRAVITY_EXECUTABLE_DATA_DIR（isolatedEnv 指向 <root>/data）
const DATA = path.join(T, 'data');
const STATE = path.join(DATA, 'wake-state.json');
const LOG = path.join(DATA, 'wake.log');
let staged = null;
let api = null;

const checks = [];
const record = (name, ok, detail = '') => { checks.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`); };

function setup({ dryRun, state = null, letters = [], exitCode = 0 }) {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });   // 预置状态要写进 DATA，目录先建
  staged = stage(path.join(SRC.gemini, 'wake.mjs'), T);
  api = fakeAgentapi(T, { exitCode });
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    identity: 'gemini', conversationId: TEST_CONVERSATION_ID, mailboxRoot: T, allowFrom: ['dsh'],
    dryRun, maxAttemptsPerLetter: 3, pollSeconds: 15, watchSeconds: 60,
  }, null, 2));
  if (state) fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  for (const l of letters) fs.writeFileSync(path.join(INBOX, `${l.id}.json`), JSON.stringify(l, null, 2));
}
const letter = (id) => ({ id, thread_id: 'selftest', from: 'dsh', to: 'gemini', type: 'task', subject: `自测 ${id}`, body: '正文', budget: 'standard', created_at: new Date().toISOString() });
const run = () => spawnSync(process.execPath, [staged], { encoding: 'utf8', env: isolatedEnv(T, api) });
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const callCount = () => readCalls(api.calls).length;

/* S1 基线 */
setup({ dryRun: false, letters: [letter('old-1')] });
run();
record('S1 首次运行只记基线（且未发送）', readState().seen['old-1']?.note === 'baseline' && callCount() === 0, JSON.stringify(readState().seen['old-1']));

/* S2 已送达 → 跳过 */
setup({ dryRun: false, letters: [letter('a-1')], state: { baselineAt: 'x', seen: { 'a-1': { firstSeenAt: 'x', attempts: 1, sentAt: 'y', lastResult: 'sent' } } } });
run();
record('S2 已送达不再重试（不发送）', /no new mail/.test(readLog()) && readState().seen['a-1'].attempts === 1 && callCount() === 0, readLog().trim().split('\n').pop());

/* S3 旧"演练"迁移 + dryRun 不消耗 */
setup({ dryRun: true, letters: [letter('b-1')], state: { baselineAt: 'x', seen: { 'b-1': { firstSeenAt: 'x', attempts: 1, lastResult: 'sent', lastOut: '(dryRun: not sent)' } } } });
run();
const s3 = readState().seen['b-1'];
record('S3 旧“演练”迁移为待发、演练不消耗（不发送）', !s3.sentAt && !!s3.dryRunAt && callCount() === 0, JSON.stringify(s3));

/* S4 真实发送成功 → sentAt + 恰好 1 次调用 */
setup({ dryRun: false, letters: [letter('ok-1')], state: { baselineAt: 'x', seen: { 'ok-1': { firstSeenAt: 'x', attempts: 0, dryRunAt: 'y' } } }, exitCode: 0 });
run();
const s4 = readState().seen['ok-1'];
record('S4 假 agentapi 成功 ⇒ sentAt 落盘且恰好调用 1 次', !!s4.sentAt && callCount() === 1, `sentAt=${!!s4.sentAt} calls=${callCount()}`);
record('S4b 调用参数指向测试会话 id（不是生产会话）', (readCalls(api.calls)[0] ?? '').includes(TEST_CONVERSATION_ID), (readCalls(api.calls)[0] ?? '').slice(0, 90));

/* S5 失败 → 计数、不写 sent（调用 1 次） */
setup({ dryRun: false, letters: [letter('c-1')], state: { baselineAt: 'x', seen: { 'c-1': { firstSeenAt: 'x', attempts: 0, dryRunAt: 'y' } } }, exitCode: 1 });
run();
const a1 = readState().seen['c-1'];
record('S5 失败计入 attempts 且不写 sent（调用 1 次）', !!a1.lastResult && !a1.sentAt && a1.attempts === 1 && callCount() === 1, `attempts=${a1.attempts} last=${a1.lastResult} calls=${callCount()}`);

/* S6 重试到上限 → exhausted，不再调用 */
run(); const a2 = readState().seen['c-1'];
run(); const a3 = readState().seen['c-1'];
run(); const a4 = readState().seen['c-1'];
record('S6 重试到 maxAttempts=3 后 exhausted 且不再调用', a3.attempts === 3 && a4.attempts === 3 && callCount() === 3, `attempts=${a3.attempts}/${a4.attempts} calls=${callCount()}`);
record('S6b 第二轮确实重试（attempts 递增）', a2.attempts === 2, `attempts=${a2.attempts}`);

/* S7 旧"真送达"迁移 → 跳过 */
setup({ dryRun: false, letters: [letter('d-1')], state: { baselineAt: 'x', seen: { 'd-1': { firstSeenAt: 'x', attempts: 1, lastResult: 'sent', lastOut: '{"response":{"sendMessage":{}}}' } } } });
run();
record('S7 旧“真送达”迁移为 sentAt 且跳过（不发送）', !!readState().seen['d-1'].sentAt && /no new mail/.test(readLog()) && callCount() === 0, JSON.stringify(readState().seen['d-1']).slice(0, 110));

fs.rmSync(T, { recursive: true, force: true });
const bad = checks.filter(([, ok]) => !ok).length;
console.log(`\n小结：${checks.length - bad}/${checks.length} 通过；临时根已删 ${T}（被测源码取自仓库 ${path.relative(process.cwd(), SRC.gemini)}）`);
process.exitCode = bad === 0 ? 0 : 1;
