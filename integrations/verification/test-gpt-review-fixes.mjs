/**
 * 对照 GPT（codex）复审的 8 个反例 + 3 项静态问题，逐条验证修复。
 *   反例1 Gemini indeterminate 不再自动重发（挂起等人核对）
 *   反例2 自定义 reply_id 的有效等待回执 ⇒ 静默（不再只认文件名前缀）
 *   反例3 伪造/错配回执不得抑制提醒（按内核 postmaster:235-249 判定）
 *   反例3b 终态回执优先 ⇒ 有终态就不再静默
 *   反例4 MCP 路径穿越（../../dsh/inbox/victim）被拒
 *   反例5 旧演练 attempts=3 迁移后不 exhausted，仍有真实发送机会
 *   反例6 提醒上限不是永久静默：冷却到点会再提醒
 *   反例7 MCP 部分完成故障保留结构化字段（REPLIED_ARCHIVE_PENDING 等）
 *   反例8 锁：同时启动只有一个守望；失锁即停；续租验所有权
 *
 *   node C:\AI_ASSIST\work\scripts\test-gpt-review-fixes.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SRC as SRCROOT, makeRoot, fakeAgentapi, isolatedEnv, stageKernel, TEST_CONVERSATION_ID } from './lib/harness.mjs';

const T = makeRoot('gpt-fixes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = path.join(T, 'agents');
const results = [];
const rec = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

const CLAUDE_CHECK = path.join(SRCROOT.claude, 'claude-check.mjs');
const CODEX_CHECK = path.join(SRCROOT.codex, 'codex-check.mjs');
const GEMINI_WAKE = path.join(SRCROOT.gemini, 'wake.mjs');
const CLAUDE_WAKE = path.join(SRCROOT.claude, 'claude-wake.mjs');
const MCP_SERVER = SRCROOT.wrapper;
const PROD_MAILBOX = SRCROOT.kernel;   // 内核闭包取自仓库

const wipe = () => { fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T, { recursive: true }); };
const mk = (p) => fs.mkdirSync(p, { recursive: true });
/**
 * 必须把被测脚本**拷进临时根再跑**：这些脚本用 import.meta.dirname 定位自己的 config/state/log，
 * 原地运行会读到真实配置、扫到生产信箱（只读，但测的就不是临时夹具了）。
 */
const stage = (src) => { const dest = path.join(T, path.basename(src)); fs.copyFileSync(src, dest); return dest; };
const letter = (id, from, to, type = 'task') => ({ id, thread_id: 'fix-thread', from, to, type, subject: `t ${id}`, body: 'b', budget: 'standard', created_at: new Date().toISOString() });
const result = (id, from, to, opts = {}) => ({
  id, thread_id: opts.thread_id ?? 'fix-thread', from, to, type: opts.type ?? 'result',
  subject: 'r', body: 'r', budget: 'standard', created_at: new Date().toISOString(),
  reply_to: opts.reply_to, ...(opts.outcome ? { outcome: opts.outcome } : {}),
});
const put = (agent, folder, env, name) => {
  mk(path.join(A, agent, folder));
  fs.writeFileSync(path.join(A, agent, folder, name ?? `${env.id}.json`), JSON.stringify(env, null, 2));
};
const checkerRun = (src, args = []) => {
  // 每次运行前把脚本拷进临时根：脚本用 import.meta.dirname 定位 config/state/log，
  // 原地运行会读真实配置、扫生产信箱（只读，但测的就不是夹具了）。
  const dest = path.join(T, path.basename(src));
  fs.copyFileSync(src, dest);
  return spawnSync(process.execPath, [dest, ...args], { encoding: 'utf8' });
};

/* ============================ 反例 2 / 3 / 3b / 6：两个 checker ============================ */
for (const [label, src, identity] of [['claude', CLAUDE_CHECK, 'claude'], ['codex', CODEX_CHECK, 'codex']]) {
  const base = (extra = {}) => {
    wipe();
    fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
      identity, mailboxRoot: T, allowFrom: ['dsh'], maxRemindersPerLetter: 2,
      reminderCooldownHours: 1, ...extra,
    }, null, 2));
  };
  const exitCodeOf = (r) => r.status;
  const blocked = (r) => (label === 'claude' ? r.status === 2 : /"decision":"block"/.test(r.stdout));
  const silent = (r) => (label === 'claude' ? r.status === 0 && r.stderr.trim() === '' : r.stdout.trim() === '');

  // 反例 2：自定义 reply_id 的有效等待回执（信封内容匹配，文件名无前缀）
  base();
  const L2 = letter('task-custom', 'dsh', identity);
  put(identity, 'inbox', L2);
  put('dsh', 'inbox', result('custom-wait-reply', identity, 'dsh', { reply_to: 'task-custom', outcome: 'needs_authorization' }));
  let r = checkerRun(src);
  rec(`反例2[${label}] 自定义 reply_id 的等待回执 ⇒ 静默`, silent(r), `exit=${exitCodeOf(r)}`);

  // 反例 3：伪造/错配回执（type/from/to/thread/位置都不对）⇒ 必须仍然提醒
  base();
  const L3 = letter('task-forged', 'dsh', identity);
  put(identity, 'inbox', L3);
  put('dsh', 'inbox', result('task-forged.result.aaaa', 'stranger', 'wrong', { reply_to: 'task-forged', outcome: 'needs_authorization', type: 'ping', thread_id: 'wrong-thread' }));
  r = checkerRun(src);
  rec(`反例3[${label}] 伪造/错配回执不抑制提醒`, blocked(r), `exit=${exitCodeOf(r)}`);

  // 反例 3b：同信同时存在有效终态回执 ⇒ 不静默（终态优先）
  base();
  const L3b = letter('task-terminal', 'dsh', identity);
  put(identity, 'inbox', L3b);
  put('dsh', 'inbox', result('task-terminal.result.waiting', identity, 'dsh', { reply_to: 'task-terminal', outcome: 'needs_authorization' }));
  put('dsh', 'inbox', result('task-terminal.result', identity, 'dsh', { reply_to: 'task-terminal', outcome: 'completed' }));
  r = checkerRun(src);
  rec(`反例3b[${label}] 终态回执优先 ⇒ 仍提醒`, blocked(r), `exit=${exitCodeOf(r)}`);

  // 反例 6：达到上限后不是永久静默 —— 冷却到点会再提醒
  base();
  const L6 = letter('task-cap', 'dsh', identity);
  put(identity, 'inbox', L6);
  const r1 = checkerRun(src); const r2 = checkerRun(src); const r3 = checkerRun(src);
  const st = JSON.parse(fs.readFileSync(path.join(T, 'check-state.json'), 'utf8'));
  const capped = st.counts['task-cap'];
  // 把 lastAt 拨回 2 小时前（冷却 1 小时）⇒ 下一次应恢复提醒
  capped.lastAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(T, 'check-state.json'), JSON.stringify({ counts: { 'task-cap': capped } }, null, 2));
  const r4 = checkerRun(src);
  rec(`反例6[${label}] 上限后进入冷却、冷却到点恢复提醒`,
    blocked(r1) && blocked(r2) && silent(r3) && blocked(r4),
    `前三次=${[exitCodeOf(r1), exitCodeOf(r2), exitCodeOf(r3)].join('/')} 冷却后=${exitCodeOf(r4)} manualReview=${capped.manualReview}`);
}

/* ============================ 反例 1 / 5：Gemini 桥 ============================ */
{
  const setupGemini = (state, letters, extra = {}) => {
    wipe(); mk(path.join(A, 'gemini', 'inbox'));
    fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
      identity: 'gemini', conversationId: TEST_CONVERSATION_ID,
      mailboxRoot: T, allowFrom: ['dsh'], dryRun: false, maxAttemptsPerLetter: 3, ...extra,
    }, null, 2));
    stagedGemini = stage(GEMINI_WAKE);
    fs.mkdirSync(path.join(T, 'data'), { recursive: true });
    fs.writeFileSync(path.join(T, 'data', 'wake-state.json'), JSON.stringify(state, null, 2));
    for (const l of letters) put('gemini', 'inbox', l);
  };
  let stagedGemini = null;
  const runGemini = () => {
    const dest = path.join(T, path.basename(GEMINI_WAKE));
    fs.copyFileSync(GEMINI_WAKE, dest);
    // 状态/日志落在 DATA=ANTIGRAVITY_EXECUTABLE_DATA_DIR（缺省=脚本目录）⇒ 测试里显式指向临时根，
    // 避免碰宿主真实 sidecar 数据目录（这也是 GPT 复审建议的做法）。
    fs.mkdirSync(path.join(T, 'data'), { recursive: true });
    return spawnSync(process.execPath, [dest], { encoding: 'utf8', env: isolatedEnv(T, fakeAgentapi(T, { exitCode: 1 })) });
  };
  // 状态/日志都落在隔离 DATA 目录（= <T>/data）里
  const GDATA = path.join(T, 'data');
  const geminiLog = () => (fs.existsSync(path.join(GDATA, 'wake.log')) ? fs.readFileSync(path.join(GDATA, 'wake.log'), 'utf8') : '');
  const geminiState = () => JSON.parse(fs.readFileSync(path.join(GDATA, 'wake-state.json'), 'utf8'));

  // 反例 1：indeterminate ⇒ 挂起，不进发送队列（agentapi 不存在时若误入队列会被计为 failed）
  setupGemini({ baselineAt: 'x', seen: { 'i-1': { firstSeenAt: 'x', attempts: 1, lastResult: 'indeterminate', lastOut: 'timeout after 60s' } } }, [letter('i-1', 'dsh', 'gemini')]);
  runGemini();
  const s1 = geminiState().seen['i-1'];
  rec('反例1 indeterminate 不自动重发（挂起）',
    s1.attempts === 1 && !!s1.heldAt && /held\(|held:/.test(geminiLog() + JSON.stringify(s1)),
    `attempts=${s1.attempts} heldAt=${s1.heldAt ? 'set' : '-'} log=${geminiLog().trim().split('\n').pop()}`);

  // 反例 1b：显式打开 retryIndeterminate 才重试
  setupGemini({ baselineAt: 'x', seen: { 'i-2': { firstSeenAt: 'x', attempts: 1, lastResult: 'indeterminate', lastOut: 'timeout' } } }, [letter('i-2', 'dsh', 'gemini')], { retryIndeterminate: true });
  runGemini();
  const s1b = geminiState().seen['i-2'];
  rec('反例1b retryIndeterminate=true 时才重试', s1b.attempts === 2, `attempts=${s1b.attempts} last=${s1b.lastResult}`);

  // 反例 5：旧演练 attempts=3 迁移后不 exhausted，且真发一次
  setupGemini({ baselineAt: 'x', seen: { 'd-1': { firstSeenAt: 'x', attempts: 3, lastResult: 'sent', lastOut: '(dryRun: not sent)', lastAttemptAt: 'y' } } }, [letter('d-1', 'dsh', 'gemini')]);
  runGemini();
  const s5 = geminiState().seen['d-1'];
  rec('反例5 旧演练计数不消耗正式额度（迁移为 attempts=1 真发一次）',
    s5.dryRunAttempts === 3 && s5.attempts === 1 && s5.lastResult === 'failed',
    `dryRunAttempts=${s5.dryRunAttempts} attempts=${s5.attempts} last=${s5.lastResult}`);
}

/* ============================ 反例 4 / 7：MCP wrapper ============================ */
async function mcpSession({ identity, apiOverride, root }) {
  const env = { ...process.env, MAILBOX_ROOT: root, LOCALPOST_MAILBOX_API: apiOverride ?? path.join(root, 'mailbox.mjs') };
  if (identity) env.LOCALPOST_IDENTITY = identity; else delete env.LOCALPOST_IDENTITY;
  const child = spawn(process.execPath, [MCP_SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = []; let err = '';
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => { err += String(d); });
  let n = 1;
  const call = async (name, args) => {
    const id = n++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 40; i += 1) {
      await sleep(150);
      for (const l of out.join('').split('\n').filter(Boolean)) {
        try { const j = JSON.parse(l); if (j.id === id) return j?.result ?? {}; } catch { /* 半行 */ }
      }
    }
    return null;
  };
  return { child, call, stderr: () => err };
}

// 反例 4：路径穿越
{
  wipe();
  for (const f of fs.readdirSync(PROD_MAILBOX).filter((n) => n.endsWith('.mjs'))) fs.copyFileSync(path.join(PROD_MAILBOX, f), path.join(T, f));
  mk(path.join(A, 'gemini', 'inbox')); mk(path.join(A, 'dsh', 'inbox'));
  put('dsh', 'inbox', letter('victim', 'codex', 'dsh'));
  fs.writeFileSync(path.join(T, 'README.md'), '# t\n');
  const s = await mcpSession({ identity: 'gemini', root: T });
  const bad = await s.call('mailbox_read', { id: '../../dsh/inbox/victim' });
  const badText = bad?.content?.[0]?.text ?? '';
  const leaked = /victim|CONTROLLED/.test(badText) && !/非法|找不到|error/i.test(badText);
  rec('反例4 路径穿越读他人信箱被拒', !leaked && /非法信件 id/.test(badText), badText.slice(0, 110));
  const ok = await s.call('mailbox_read', { id: 'nope' });
  rec('反例4b 正常 id 走内核（找不到时报错而非穿越）', /letter not found|找不到信/.test(ok?.content?.[0]?.text ?? ''), (ok?.content?.[0]?.text ?? '').slice(0, 70));
  s.child.kill();
}

// 反例 7：结构化故障透传（受控假内核）
// 校准（GPT 二轮保留项 1）：fake 只赋**真实内核**会赋的字段 —— 见 production `.mailbox/mailbox.mjs:294-300`，
// 那里构造的 fault 只有 `code` / `reply` / `pending`（外加 Error 的 `cause`）。
// reply_delivered/archive_pending/retry_action 必须来自 **wrapper 的明确转换**，不能靠 fake 造。
{
  wipe();
  fs.writeFileSync(path.join(T, 'README.md'), '# t\n');
  const fake = path.join(T, 'fake-mailbox.mjs');
  fs.writeFileSync(fake, `
export function createMailbox() {
  return {
    async reply() {
      const cause = new Error('EACCES: archive denied');
      const e = new Error('replied but archive pending (已回执但待归档): result l-1.result was delivered; original l-1 was not archived', { cause });
      e.code = 'REPLIED_ARCHIVE_PENDING';
      e.pending = 'l-1';
      e.reply = { id: 'l-1.result', outcome: 'completed', delivered_to: 'agents/dsh/inbox/l-1.result.json' };
      throw e;
    },
    async fail() { throw new Error('boom: 普通失败，无 code'); },
    read() { throw new Error('boom: 普通失败，无 code'); },
    inbox() { return []; }, archive() { return {}; }, deliver() { return {}; }, roster() { return []; },
  };
}
`);
  const s = await mcpSession({ identity: 'gemini', root: T, apiOverride: fake });
  const r = await s.call('mailbox_reply', { reply_to: 'l-1', body: 'x' });
  const txt = r?.content?.[0]?.text ?? '';
  let j = null; try { j = JSON.parse(txt); } catch { /* 非 JSON = 旧行为 */ }
  rec('反例7 内核真实字段原样透传（code/reply/pending/cause）',
    j?.code === 'REPLIED_ARCHIVE_PENDING' && j?.pending === 'l-1'
    && j?.reply?.id === 'l-1.result' && j?.reply?.outcome === 'completed' && /EACCES/.test(String(j?.cause)),
    `code=${j?.code ?? '(无)'} pending=${j?.pending ?? '-'} reply.id=${j?.reply?.id ?? '-'} cause=${String(j?.cause ?? '-').slice(0, 24)}`);
  rec('反例7b wrapper 明确转换出稳定布尔字段',
    j?.reply_delivered === true && j?.archive_pending === true && /identical mailbox_reply/.test(String(j?.retry_action ?? '')),
    `reply_delivered=${j?.reply_delivered ?? '-'} archive_pending=${j?.archive_pending ?? '-'}`);
  // 反向：普通错误（无 code）**不得**凭空造出这三个字段
  const rPlain = await s.call('mailbox_read', { id: 'whatever' });
  const plainTxt = rPlain?.content?.[0]?.text ?? '';
  let plainJson = null; try { plainJson = JSON.parse(plainTxt); } catch { /* 非 JSON */ }
  rec('反例7c 无 code 的错误不凭空造字段',
    /boom/.test(plainTxt) && plainJson?.reply_delivered === undefined && plainJson?.archive_pending === undefined && plainJson?.code === undefined,
    plainTxt.slice(0, 70).replace(/\n/g, ' '));
  s.child.kill();
}

// 身份：未绑定 = 兼容模式带警告；严格模式 = 拒绝启动
{
  wipe(); mk(path.join(A, 'gemini', 'inbox')); fs.writeFileSync(path.join(T, 'README.md'), '# t\n');
  const s = await mcpSession({ identity: null, root: T });
  await sleep(600);
  rec('身份未绑定 ⇒ 兼容模式并打警告', /warn: 未绑定身份/.test(s.stderr()), s.stderr().trim().slice(0, 90));
  s.child.kill();
  const strict = spawnSync(process.execPath, [MCP_SERVER], {
    env: { ...process.env, MAILBOX_ROOT: T, LOCALPOST_REQUIRE_IDENTITY: '1' }, encoding: 'utf8', timeout: 8000,
  });
  rec('LOCALPOST_REQUIRE_IDENTITY=1 且无身份 ⇒ 拒绝启动(exit 2)', strict.status === 2, `exit=${strict.status} ${(strict.stderr || '').trim().slice(0, 60)}`);
}

/* ============================ 反例 8：Claude 锁并发/失锁 ============================ */
{
  wipe(); mk(path.join(A, 'claude', 'inbox'));
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({ identity: 'claude', mailboxRoot: T, allowFrom: ['dsh'], pollSeconds: 5, watchSeconds: 60 }, null, 2));
  const LOCK = path.join(T, 'watch.lock');
  const LOG = path.join(T, 'wake.log');
  const stagedWake = stage(CLAUDE_WAKE);
  const startWake = () => spawn(process.execPath, [stagedWake], { stdio: 'ignore' });

  // 同时启动两个
  const a = startWake(); const b = startWake();
  await sleep(2500);
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const logText = fs.readFileSync(LOG, 'utf8');
  const skips = (logText.match(/skip: another watcher holds the lock/g) || []).length;
  rec('反例8a 同时启动 ⇒ 恰好一个守望（另一个跳过）', skips === 1 && !!lock.pid, `skip 次数=${skips} lock.pid=${lock.pid}`);

  // 失锁即停：把锁改成"另一个活着的进程"（用本测试进程的 pid）
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
  await sleep(7000);        // 等一个轮询周期触发 renew
  const after = fs.readFileSync(LOG, 'utf8');
  rec('反例8b 失锁后守望停止（renew 验所有权）', /lock lost/.test(after), (after.trim().split('\n').pop() ?? '').slice(0, 80));
  rec('反例8c 失锁者不删别人的锁', JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid === process.pid, `lock.pid=${JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid}`);

  a.kill(); b.kill();
  await sleep(400);
}

wipe();
const bad = results.filter(([, ok]) => !ok).length;
console.log(`\n小结：${results.length - bad}/${results.length} 通过；临时根已删 ${T}`);
process.exitCode = bad === 0 ? 0 : 1;

