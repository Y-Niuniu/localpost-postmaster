import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMailbox } from './mailbox.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/mailbox');
function fixture(t, identity) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  return { root, mail: createMailbox({ root, identity }) };
}
const letter = (extra = {}) => ({
  id: 'task-one', thread_id: 'thread-one', from: 'dsh', to: 'codex', type: 'task',
  subject: 'Analyze', body: 'Please review', budget: 'standard',
  created_at: '2026-10-01T10:00:00.000Z', ...extra,
});

test('delivery retries are idempotent and conflicting content is rejected', async t => {
  const { mail } = fixture(t);
  await mail.deliver(letter());
  const retried = await mail.deliver(letter());
  assert.equal(retried.idempotent, true);
  assert.equal(mail.inbox('codex').length, 1);
  assert.equal(mail.read('codex', 'task-one').envelope.body, 'Please review');
  await assert.rejects(mail.deliver(letter({ body: 'different' })), /conflict|冲突/i);
});

test('configured identity and path boundaries constrain every mailbox operation', async t => {
  const { root, mail } = fixture(t, 'codex');
  await assert.rejects(mail.deliver(letter()), /identity|身份/i);
  await assert.rejects(mail.deliver(letter({ id: '../escape', from: 'codex', to: 'dsh' })), /id|非法/i);
  await assert.rejects(mail.deliver(letter({ from: 'codex', to: 'dsh', attachments: ['../escape.txt'] })), /path|路径|escape/i);
  assert.throws(() => mail.inbox('dsh'), /identity|身份/i);
  assert.throws(() => mail.read('dsh', 'task-one'), /identity|身份/i);
  assert.equal(fs.existsSync(path.join(root, 'escape.json')), false);
});

test('archived IDs cannot recreate pending tasks and concurrent delivery has one winner', async t => {
  const { mail } = fixture(t);
  const copies = await Promise.all(Array.from({ length: 8 }, () => mail.deliver(letter())));
  assert.equal(copies.filter(result => !result.idempotent).length, 1);
  await mail.archive('codex', 'task-one');
  assert.equal((await mail.deliver(letter())).idempotent, true);
  assert.equal(mail.inbox('codex').length, 0);
  await assert.rejects(mail.deliver(letter({ body: 'new task same ID' })), /conflict|冲突/i);
  assert.equal(mail.roster().find(row => row.agent === 'codex').archive, 1);
});

test('only a trusted publication option can bind a route, and retries retain the original target', async t => {
  const { root, mail } = fixture(t);
  const route = { threadId: 'chat-A', cwd: root, hostId: 'local', focusRevision: 1, publishedAt: '2026-10-01T10:00:00.000Z', scope: 'analysis-reply' };
  await assert.rejects(mail.deliver(letter({ route })), /route|路由/i);
  await mail.deliver(letter(), { route });
  const routePath = path.join(root, 'runtime/routes/task-one.json');
  assert.equal(JSON.parse(fs.readFileSync(routePath, 'utf8')).threadId, 'chat-A');
  await mail.deliver(letter(), { route: { ...route, threadId: 'chat-B', focusRevision: 2 } });
  assert.equal(JSON.parse(fs.readFileSync(routePath, 'utf8')).threadId, 'chat-A');
  assert.equal(mail.read('codex', 'task-one').envelope.route, undefined);
});

test('authorization replies stay pending; terminal reply retries repair archive without new results', async t => {
  const { root, mail } = fixture(t);
  await mail.deliver(letter());
  const pending = await mail.reply('codex', { reply_to: 'task-one', body: 'Approval required', outcome: 'needs_authorization' });
  assert.match(pending.id, /^task-one\.result\./);
  assert.equal(mail.inbox('codex').length, 1);
  assert.equal(mail.inbox('dsh')[0].outcome, 'needs_authorization');
  const reply = { reply_to: 'task-one', body: 'Reviewed', commit: 'abc', base_rev: 'def', test: 'checks pass' };
  const completed = await mail.reply('codex', reply);
  assert.equal(completed.id, 'task-one.result');
  assert.equal(mail.inbox('codex').length, 0);
  assert.equal(mail.read('dsh', completed.id).envelope.base_rev, 'def');
  // Simulate the crash window: result published, original not yet archived.
  fs.renameSync(path.join(root, 'agents/codex/archive/task-one.json'), path.join(root, 'agents/codex/inbox/task-one.json'));
  assert.equal((await mail.reply('codex', reply)).idempotent, true);
  assert.equal(mail.inbox('codex').length, 0);
  assert.equal((await mail.reply('codex', reply)).idempotent, true);
  assert.equal(mail.inbox('dsh').length, 2);
  await assert.rejects(mail.reply('codex', { ...reply, body: 'changed result' }), /conflict|冲突/i);
});

test('generated IDs are UUIDs and send retries preserve generated timestamps', async t => {
  const { mail } = fixture(t);
  const minimal = { from: 'dsh', to: 'codex', type: 'task', subject: 'Inspect', body: 'Read only' };
  const sent = await mail.deliver(minimal);
  assert.match(sent.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  const original = mail.read('codex', sent.id).envelope;
  assert.equal(original.thread_id, sent.id);
  assert.equal(original.budget, 'standard');
  assert.equal((await mail.deliver({ ...minimal, id: sent.id })).idempotent, true);
  await assert.rejects(mail.deliver({ ...minimal, type: 'unexpected' }), /type/i);
});

test('the real MCP stdio process exposes seven tools and preserves reply outcome and base_rev', { timeout: 10000 }, async t => {
  const { root, mail } = fixture(t);
  await mail.deliver(letter());
  const dataListeners = process.stdin.listenerCount('data');
  const { createMcpServer } = await import('./mcp-server.mjs');
  assert.equal(process.stdin.listenerCount('data'), dataListeners, 'import must not register stdio listeners');
  assert.equal((await createMcpServer({ root }).handle({ id: 9, method: 'tools/list' })).result.tools.length, 7);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'mcp-server.mjs')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex', TEMP: tempRoot, TMP: tempRoot },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mailbox_reply', arguments: { agent: 'codex', reply_to: 'task-one', body: 'Needs approval', outcome: 'needs_authorization', reply_id: 'task-one.result.waiting', base_rev: 'base-123' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mailbox_reply', arguments: { agent: 'codex', reply_to: 'task-one', body: 'Analysis completed', outcome: 'completed', base_rev: 'base-456' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mailbox_send', arguments: { ...letter({ from: 'codex', to: 'dsh' }), route: { threadId: 'injected' } } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'mailbox_inbox', arguments: { agent: 'dsh' } } },
  ];
  child.stdin.end(calls.map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal(await exited, 0, stderr);
  const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 5, stdout);
  const tools = responses[0].result.tools;
  assert.equal(tools.length, 7);
  assert.ok(tools.find(tool => tool.name === 'mailbox_reply').inputSchema.properties.base_rev);
  assert.equal(responses[1].result.isError, undefined, JSON.stringify(responses[1]));
  assert.equal(responses[2].result.isError, undefined, JSON.stringify(responses[2]));
  assert.equal(responses[3].result.isError, true);
  assert.equal(responses[4].result.isError, true);
  assert.equal(mail.read('dsh', 'task-one.result.waiting').envelope.outcome, 'needs_authorization');
  assert.equal(mail.read('dsh', 'task-one.result').envelope.base_rev, 'base-456');
  assert.equal(mail.inbox('codex').length, 0);
});

test('a sender outbox copy is not proof of delivery to the recipient', async t => {
  const { root, mail } = fixture(t);
  fs.mkdirSync(path.join(root, 'agents/dsh/outbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents/dsh/outbox/task-one.json'), JSON.stringify(letter()));
  const sent = await mail.deliver(letter());
  assert.equal(sent.idempotent, false);
  assert.equal(mail.inbox('codex').length, 1);
});
