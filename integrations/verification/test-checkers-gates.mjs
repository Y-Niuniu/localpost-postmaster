/**
 * 自测 claude-check.mjs 与 codex-check.mjs 的四道闸门（P1-2 修复）。
 *
 * 场景（对两个 checker 各跑一遍，用同一个临时信箱根）：
 *   C1 合格来信、无等待回执 → 必须提醒（claude: exit 2；codex: JSON decision=block）
 *   C2 同一封信 + 已存在等待授权回执（agents/dsh/inbox/<id>.result.waiting.json）→ 必须静默
 *   C3 提醒上限：maxRemindersPerLetter=2，第 3 次必须静默（兜底生效）
 *   C4 新信出现 → 照常提醒（不被上一封的计数/上限挡住）
 *   C5 claude --context 模式：有信时输出 additionalContext JSON；有等待回执时静默
 *   C6 result 类型不提醒、非白名单不提醒（回归）
 *
 *   node C:\AI_ASSIST\work\scripts\test-checkers-gates.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SRC as SRCROOT, makeRoot, fakeAgentapi, isolatedEnv, stage, stageKernel, TEST_CONVERSATION_ID } from './lib/harness.mjs';

const CHECKS = [
  { name: 'claude', src: path.join(SRCROOT.claude, 'claude-check.mjs'), identity: 'claude' },
  { name: 'codex', src: path.join(SRCROOT.codex, 'codex-check.mjs'), identity: 'codex' },
];
const T = makeRoot('checkers');
const AGENTS = path.join(T, 'agents');
const ROOTCFG = T;

const results = [];
const record = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`); };

function setup(identity, maxReminders = 2, src = null) {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(path.join(AGENTS, identity, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(AGENTS, identity, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(AGENTS, 'dsh', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(AGENTS, 'dsh', 'archive'), { recursive: true });
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
    identity, mailboxRoot: ROOTCFG, allowFrom: ['dsh'], maxRemindersPerLetter: maxReminders,
  }, null, 2));
  if (src) fs.copyFileSync(src, path.join(T, path.basename(src)));   // 清空后再拷，避免被 setup 删掉
}
// 本轮收件方身份（决定信件的 to 与回执的 from）——判据已对齐内核：回执必须 from===信.to、to===信.from、同 thread。
let CURRENT_IDENTITY = 'claude';
const letter = (id, from = 'dsh', type = 'task', to = CURRENT_IDENTITY) => ({ id, thread_id: 'selftest', from, to, type, subject: `自测 ${id}`, body: '正文', budget: 'standard', created_at: new Date().toISOString() });
const putInbox = (agent, env) => fs.writeFileSync(path.join(AGENTS, agent, 'inbox', `${env.id}.json`), JSON.stringify(env, null, 2));
/** 内核有效的非终态回执：type=result、reply_to=原信、from=原收件人、to=原发件人、同线程、落在原发件人信箱。 */
const putWaitingReply = (id) => fs.writeFileSync(path.join(AGENTS, 'dsh', 'inbox', `${id}.result.waiting.json`), JSON.stringify({
  id: `${id}.result.waiting`, thread_id: 'selftest', from: CURRENT_IDENTITY, to: 'dsh', type: 'result',
  reply_to: id, outcome: 'needs_authorization', subject: '回执', body: '等待授权', budget: 'standard', created_at: new Date().toISOString(),
}, null, 2));
const run = (src, args = []) => spawnSync(process.execPath, [path.join(T, path.basename(src)), ...args], { encoding: 'utf8' });

for (const { name, src, identity } of CHECKS) {
  CURRENT_IDENTITY = identity;
  // checker 的拷贝由 setup() 负责（先清空临时根再拷，顺序才对）

  // C1 合格来信 → 提醒
  setup(identity, 2, src);
  putInbox(identity, letter('l-1'));
  let r = run(src);
  const reminded = name === 'claude' ? r.status === 2 && /l-1/.test(r.stderr) : r.status === 0 && JSON.parse(r.stdout.trim()).decision === 'block';
  record(`C1[${name}] 合格来信 → 提醒`, reminded, name === 'claude' ? `exit=${r.status}` : r.stdout.trim().slice(0, 60));

  // C2 有等待授权回执 → 静默
  setup(identity, 2, src);
  putInbox(identity, letter('l-2'));
  putWaitingReply('l-2');
  r = run(src);
  const silent = name === 'claude' ? r.status === 0 && r.stderr.trim() === '' && r.stdout.trim() === '' : r.status === 0 && r.stdout.trim() === '';
  record(`C2[${name}] 已有等待授权回执 → 静默`, silent, `exit=${r.status} out=${JSON.stringify(r.stdout.trim()).slice(0, 40)}`);

  // C2b 内核式命名（<id>.result.<uuid>.json）+ 回执已被归档 ⇒ 同样要静默（按内容判定，不认文件名）
  setup(identity, 2, src);
  putInbox(identity, letter('l-2b'));
  fs.writeFileSync(path.join(AGENTS, 'dsh', 'archive', 'l-2b.result.8f14e45f-ceea-467a-9e2c-1a2b3c4d5e6f.json'),
    JSON.stringify({
      id: 'l-2b.result.8f14e45f', thread_id: 'selftest', from: identity, to: 'dsh', type: 'result',
      reply_to: 'l-2b', outcome: 'needs_authorization', subject: '回执', body: '等待授权', budget: 'standard', created_at: new Date().toISOString(),
    }, null, 2));
  const r2b = run(src);
  const silent2b = name === 'claude' ? r2b.status === 0 && r2b.stderr.trim() === '' : r2b.stdout.trim() === '';
  record(`C2b[${name}] 内核式命名+已归档的等待回执 → 静默`, silent2b, `exit=${r2b.status}`);

  // C3 提醒上限（max=2）→ 第 3 次静默
  setup(identity, 2, src);
  putInbox(identity, letter('l-3'));
  const r1 = run(src); const r2 = run(src); const r3 = run(src);
  const hit1 = name === 'claude' ? r1.status === 2 : /"decision":"block"/.test(r1.stdout);
  const hit2 = name === 'claude' ? r2.status === 2 : /"decision":"block"/.test(r2.stdout);
  const hit3 = name === 'claude' ? r3.status === 0 && r3.stderr.trim() === '' : r3.stdout.trim() === '';
  record(`C3[${name}] 前两次提醒、第 3 次达上限静默`, hit1 && hit2 && hit3, `exit: ${r1.status}/${r2.status}/${r3.status}`);

  // C4 新信出现 → 照常提醒（旧信已到上限）
  putInbox(identity, letter('l-4', 'dsh'));
  const r4 = run(src);
  const remindsNew = name === 'claude' ? r4.status === 2 : /"decision":"block"/.test(r4.stdout);
  record(`C4[${name}] 新信仍提醒`, remindsNew, `exit=${r4.status}`);

  // C5 claude --context 模式（仅 claude 支持）
  if (name === 'claude') {
    setup(identity, 2, src);
    putInbox(identity, letter('c-1'));
    const rc = run(src, ['--context']);
    let ctxOk = false;
    try { ctxOk = JSON.parse(rc.stdout.trim()).hookSpecificOutput.additionalContext.includes('c-1'); } catch { ctxOk = false; }
    record('C5[claude] --context 输出 additionalContext', rc.status === 0 && ctxOk, rc.stdout.trim().slice(0, 70));
    putWaitingReply('c-1');
    const rc2 = run(src, ['--context']);
    record('C5b[claude] 有等待回执时 --context 静默', rc2.status === 0 && rc2.stdout.trim() === '', JSON.stringify(rc2.stdout.trim()).slice(0, 40));
  }

  // C6 回归：result 与非白名单
  setup(identity, 2, src);
  putInbox(identity, letter('r-1', 'dsh', 'result'));
  putInbox(identity, letter('s-1', 'stranger'));
  const r6 = run(src);
  const regress = name === 'claude' ? r6.status === 0 && r6.stderr.trim() === '' : r6.stdout.trim() === '';
  record(`C6[${name}] result 与非白名单不提醒（回归）`, regress, `exit=${r6.status}`);
}

fs.rmSync(T, { recursive: true, force: true });
const bad = results.filter(([, ok]) => !ok).length;
console.log(`\n小结：${results.length - bad}/${results.length} 通过；临时根已删 ${T}`);
process.exitCode = bad === 0 ? 0 : 1;

