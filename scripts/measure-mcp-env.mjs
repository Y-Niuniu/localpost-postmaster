// 实测 mcp-server.mjs 在 Windows 上最少需要哪些系统变量（mcp-launch.mjs 允许表的依据；不属于测试套件）。
// 用法：node scripts/measure-mcp-env.mjs
//
// 做法：先清空本进程环境 —— 否则 libuv 会把本进程的 PATH、SYSTEMROOT 等补进子进程，量出来的就不是「只给这些变量」。
// 然后按每个子集：① 用假 server 核对子进程实际收到的变量名；② 用同一子集启动真实 server，跑握手 + 全部 7 个工具。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMailbox } from '../localpost/mailbox.mjs';
import { removeTreeSync } from '../localpost/temp-tree.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const probe = path.join(repo, 'localpost', 'fixtures', 'env-probe-server.mjs');
const server = path.join(repo, 'localpost', 'mcp-server.mjs');
const work = path.join(repo, '.localpost-tmp', 'measure-mcp-env');
const SYSTEM = ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP'];
const received = env => {
  const seen = spawnSync(process.execPath, [probe], { env, input: 'exit\n', encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return seen.status === 0 ? JSON.parse(seen.stdout.split('\n')[0]).names.join(', ') : `(node exit ${seen.status})`;
};
// 对照：本进程环境还在时，只传一个变量，子进程实际收到什么。
const reinjected = received({ MAILBOX_IDENTITY: 'codex' });
const saved = Object.fromEntries(SYSTEM.map(name => [name, process.env[name]]));
for (const name of Object.keys(process.env)) delete process.env[name];

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const input = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  call(3, 'mailbox_rules'), call(4, 'mailbox_roster'), call(5, 'mailbox_inbox', { agent: 'codex' }), call(6, 'mailbox_read', { agent: 'codex', id: 'task-one' }),
  call(7, 'mailbox_send', { from: 'codex', to: 'dsh', type: 'task', subject: 'Ping', body: 'Generated id' }),
  call(8, 'mailbox_reply', { agent: 'codex', reply_to: 'task-one', body: 'Done', outcome: 'completed' }),
  call(9, 'mailbox_archive', { agent: 'codex', id: 'task-one' }),
].map(value => JSON.stringify(value)).join('\n') + '\n';
const subsets = { '(none)': [], SystemRoot: ['SystemRoot'], windir: ['windir'], 'all five': SYSTEM,
  ...Object.fromEntries(SYSTEM.map(drop => ['all five - ' + drop, SYSTEM.filter(name => name !== drop)])) };

console.log(`node ${process.version} ${process.platform}\n`);
console.log(`parent environment intact, child given only MAILBOX_IDENTITY → child actually received: ${reinjected}\n`);
console.log('| system variables given | child actually received | server exit | ok responses |');
console.log('|---|---|---|---|');
fs.mkdirSync(work, { recursive: true });
try {
  for (const [label, names] of Object.entries(subsets)) {
    const root = fs.mkdtempSync(path.join(work, 'case-'));
    await createMailbox({ root }).deliver({ id: 'task-one', thread_id: 'thread-one', from: 'dsh', to: 'codex', type: 'task',
      subject: 'Analyze', body: 'Please review', budget: 'standard', created_at: '2026-10-01T10:00:00.000Z' });
    const env = { ...Object.fromEntries(names.map(name => [name, saved[name]])), MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex' };
    const run = spawnSync(process.execPath, [server], { env, input, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const lines = run.stdout.trim() ? run.stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
    const ok = lines.filter(line => !line.error && !line.result?.isError).length;
    console.log(`| ${label} | ${received(env)} | ${run.status} | ${ok}/9 |`);
    removeTreeSync(root);
  }
} finally {
  removeTreeSync(work);
}
