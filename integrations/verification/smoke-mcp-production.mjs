/**
 * 生产只读冒烟：用**生产信箱根** + 身份绑定启动改造后的 MCP server，只调只读工具。
 *   node C:\AI_ASSIST\work\scripts\smoke-mcp-production.mjs
 * 不写任何信箱内容（只 mailbox_roster / mailbox_rules / mailbox_inbox 自己的）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

// 生产只读冒烟：**必须显式开启**才跑（避免克隆仓库的人无意触碰生产信箱）
if (process.env.LOCALPOST_SMOKE_PRODUCTION !== '1') {
  console.log('跳过：生产只读冒烟需显式开启 —— $env:LOCALPOST_SMOKE_PRODUCTION=1 ; node integrations/verification/smoke-mcp-production.mjs');
  process.exit(0);
}
const ROOT = 'C:/AI_ASSIST/.mailbox';
const SERVER = 'C:/AI_ASSIST/tools/dsh-mailbox-mcp/server.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, MAILBOX_ROOT: ROOT, LOCALPOST_IDENTITY: 'gemini' };
const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
const out = [];
let err = '';
child.stdout.on('data', (d) => out.push(String(d)));
child.stderr.on('data', (d) => { err += String(d); });
let nextId = 1;
const call = async (name, args = {}) => {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  for (let i = 0; i < 50; i += 1) {
    await sleep(200);
    for (const l of out.join('').split('\n').filter(Boolean)) {
      try { const j = JSON.parse(l); if (j.id === id) return j?.result?.content?.[0]?.text ?? ''; } catch { /* 半行 */ }
    }
  }
  return null;
};

const roster = await call('mailbox_roster');
const rules = await call('mailbox_rules');
const mine = await call('mailbox_inbox', {});
const foreign = await call('mailbox_inbox', { agent: 'dsh' });

const checks = [];
const rec = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

let rosterJson = null; try { rosterJson = JSON.parse(roster); } catch { /* ignore */ }
rec('生产 roster 可读', Array.isArray(rosterJson?.agents) && rosterJson.agents.length > 0, rosterJson ? rosterJson.agents.map((a) => a.agent).join(',') : 'null');
rec('生产 README 可读（规矩唯一源）', /README|邮局|规矩/.test(String(rules).slice(0, 200)), String(rules).slice(0, 60).replace(/\n/g, ' '));
let mineJson = null; try { mineJson = JSON.parse(mine); } catch { /* ignore */ }
rec('身份绑定下可读自己的收件箱', Array.isArray(mineJson?.letters), `letters=${mineJson?.letters?.length ?? 'n/a'}`);
rec('身份绑定下不能读别人的收件箱', /身份绑定/.test(String(foreign)), String(foreign).slice(0, 70));
rec('server 启动无 stderr 错误', err.trim() === '' || !/Error|error:/i.test(err), err.trim().slice(0, 80) || '(clean)');

child.kill();
const bad = checks.filter((x) => !x).length;
console.log(`\n小结：${checks.length - bad}/${checks.length} 通过（生产只读，未写信箱）`);
process.exitCode = bad === 0 ? 0 : 1;
