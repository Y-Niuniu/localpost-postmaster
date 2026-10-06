/**
 * 自测 tools/dsh-mailbox-mcp/server.mjs 的 P1-1 修复（回执/归档收敛到共享内核 + 身份绑定）。
 *
 *   M1 终态回执（outcome=completed）：回执以 <原信id>.result.json 投回发件人，原信进自己的 archive
 *   M2 非终态回执（outcome=needs_authorization）：回执带独立 reply_id（<原信id>.result.<uuid>）且
 *      **原信留在 inbox**（等授权后继续），内核记录 outcome 字段
 *   M3 身份绑定：进程设 LOCALPOST_IDENTITY=gemini 时，用 agent="dsh" 读别人的信必须被拒
 *   M4 非法 outcome 被内核拒绝（不能糊成终态）
 *   M5 stdin 关闭前最后一条异步请求也能完成（旧实现会腰斩）
 *
 *   node C:\AI_ASSIST\work\scripts\test-mailbox-mcp-reply.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SRC as SRCROOT, makeRoot, fakeAgentapi, isolatedEnv, stage, stageKernel, TEST_CONVERSATION_ID } from './lib/harness.mjs';

const PROD = SRCROOT.kernel;   // 内核闭包取自仓库 localpost/（不是生产目录）
const SERVER = SRCROOT.wrapper;   // wrapper 取自仓库 integrations/
const T = makeRoot('mcp-reply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

function freshRoot() {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(T, { recursive: true });
  for (const f of fs.readdirSync(PROD).filter((n) => n.endsWith('.mjs'))) fs.copyFileSync(path.join(PROD, f), path.join(T, f));
  for (const a of ['gemini', 'dsh']) for (const d of ['inbox', 'outbox', 'archive']) fs.mkdirSync(path.join(T, 'agents', a, d), { recursive: true });
  fs.writeFileSync(path.join(T, 'README.md'), '# 测试邮局\n');
}
const letter = (id, from, to) => ({ id, thread_id: 'selftest', from, to, type: 'task', subject: `自测 ${id}`, body: '正文', budget: 'standard', created_at: new Date().toISOString() });
const put = (a, env) => fs.writeFileSync(path.join(T, 'agents', a, 'inbox', `${env.id}.json`), JSON.stringify(env, null, 2));

function startServer(identity = null) {
  const env = { ...process.env, MAILBOX_ROOT: T, LOCALPOST_MAILBOX_API: path.join(T, 'mailbox.mjs') };
  if (identity) env.LOCALPOST_IDENTITY = identity; else delete env.LOCALPOST_IDENTITY;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  let nextId = 1;
  const call = async (name, args) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 60; i += 1) {
      await sleep(200);
      const text = out.join('');
      const lines = text.split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const j = JSON.parse(l);
          if (j.id === id) return j;
        } catch { /* 不完整行 */ }
      }
    }
    return null;
  };
  return { child, call, raw: () => out.join('') };
}

/* M1 终态回执 */
freshRoot();
put('gemini', letter('l1', 'dsh', 'gemini'));
let s = startServer('gemini');
let r1 = await s.call('mailbox_reply', { reply_to: 'l1', body: '完成了' });
const r1text = r1?.result?.content?.[0]?.text ?? '';
const r1json = (() => { try { return JSON.parse(r1text); } catch { return null; } })();
record('M1a 终态回执投回发件人', !!r1json && fs.existsSync(path.join(T, 'agents', 'dsh', 'inbox', 'l1.result.json')), (r1json && JSON.stringify(r1json).slice(0, 120)) || r1text.slice(0, 120));
record('M1b 终态回执后原信归档', fs.existsSync(path.join(T, 'agents', 'gemini', 'archive', 'l1.json')) && !fs.existsSync(path.join(T, 'agents', 'gemini', 'inbox', 'l1.json')), 'archive=' + fs.existsSync(path.join(T, 'agents', 'gemini', 'archive', 'l1.json')));

/* M2 非终态回执 */
put('gemini', letter('l2', 'dsh', 'gemini'));
const r2 = await s.call('mailbox_reply', { reply_to: 'l2', body: '已读，需用户授权', outcome: 'needs_authorization' });
const r2json = (() => { try { return JSON.parse(r2?.result?.content?.[0]?.text ?? ''); } catch { return null; } })();
const dshFiles = fs.readdirSync(path.join(T, 'agents', 'dsh', 'inbox'));
const waitingName = dshFiles.find((n) => n.startsWith('l2.result') && n !== 'l2.result.json');
const waitingEnv = waitingName ? JSON.parse(fs.readFileSync(path.join(T, 'agents', 'dsh', 'inbox', waitingName), 'utf8')) : null;
record('M2a 非终态回执用独立 reply_id', !!waitingEnv && /^l2\.result\..+\.json$/.test(waitingName), waitingName ?? '(无)');
record('M2b 非终态回执带 outcome 字段', waitingEnv?.outcome === 'needs_authorization', JSON.stringify(waitingEnv).slice(0, 120));
record('M2c 非终态回执不归档原信（留在 inbox）', fs.existsSync(path.join(T, 'agents', 'gemini', 'inbox', 'l2.json')), 'inbox=' + fs.existsSync(path.join(T, 'agents', 'gemini', 'inbox', 'l2.json')));

/* M3 身份绑定 */
const r3 = await s.call('mailbox_inbox', { agent: 'dsh' });
const r3text = r3?.result?.content?.[0]?.text ?? '';
record('M3 绑定身份后不能用别人身份读信', /身份绑定/.test(r3text), r3text.slice(0, 100));
const r3b = await s.call('mailbox_inbox', {});
record('M3b 绑定身份后省略 agent 也能读自己的信', (() => { try { return Array.isArray(JSON.parse(r3b?.result?.content?.[0]?.text ?? '').letters); } catch { return false; } })(), (r3b?.result?.content?.[0]?.text ?? '').slice(0, 80));

/* M4 非法 outcome */
put('gemini', letter('l4', 'dsh', 'gemini'));
const r4 = await s.call('mailbox_reply', { reply_to: 'l4', body: 'x', outcome: 'bogus' });
const r4text = r4?.result?.content?.[0]?.text ?? '';
record('M4 非法 outcome 被拒（不糊成终态）', /invalid reply outcome/.test(r4text) && fs.existsSync(path.join(T, 'agents', 'gemini', 'inbox', 'l4.json')), r4text.slice(0, 100));

/* M5 stdin 收口：写入最后一条请求后立刻关 stdin，回执仍应完成 */
put('gemini', letter('l5', 'dsh', 'gemini'));
const id5 = 999;
s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id5, method: 'tools/call', params: { name: 'mailbox_reply', arguments: { reply_to: 'l5', body: '关 stdin 前的最后一条' } } }) + '\n');
s.child.stdin.end();
await sleep(3000);
record('M5 关 stdin 前最后一条异步请求仍完成', fs.existsSync(path.join(T, 'agents', 'dsh', 'inbox', 'l5.result.json')), 'l5.result=' + fs.existsSync(path.join(T, 'agents', 'dsh', 'inbox', 'l5.result.json')));

s.child.kill();
fs.rmSync(T, { recursive: true, force: true });
const bad = results.filter(([, ok]) => !ok).length;
console.log(`\n小结：${results.length - bad}/${results.length} 通过；临时根已删 ${T}`);
process.exitCode = bad === 0 ? 0 : 1;
