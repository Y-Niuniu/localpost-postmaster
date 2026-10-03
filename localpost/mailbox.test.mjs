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

test('nobody routes a letter at delivery: neither the envelope nor a delivery option can set a route', async t => {
  const { root, mail } = fixture(t);
  const route = { threadId: 'chat-A', cwd: root, hostId: 'local', generation: 1, bindingRevision: 1 };
  await assert.rejects(mail.deliver(letter({ route })), /route|路由/i);
  await assert.rejects(mail.deliver(letter({ bindingRevision: 1 })), /route|路由/i);
  // Routes are captured by the receiver from the explicit binding (receiver.test.mjs); delivery cannot set one.
  await assert.rejects(mail.deliver(letter(), { route }), /route/);
  await mail.deliver(letter());
  assert.equal(fs.existsSync(path.join(root, 'runtime/routes')), false, 'no route file is ever written by delivery');
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

test('reply outcome comes only from the explicit field; body wording never makes it nonterminal', async t => {
  const { mail } = fixture(t);
  await mail.deliver(letter());
  const reply = await mail.reply('codex', { reply_to: 'task-one', body: '需要用户授权才能继续' });
  assert.equal(reply.outcome, 'completed');
  assert.equal(mail.read('dsh', 'task-one.result').envelope.outcome, 'completed');
  assert.equal(mail.inbox('codex').length, 0);
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
  assert.equal((await createMcpServer({ root, identity: 'codex' }).handle({ id: 9, method: 'tools/list' })).result.tools.length, 7);
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

// Controlled write service checks from the 2026-10-02 architecture review:
// own inbox -> archive, idempotent retry, failure repair, cross-identity and path-escape rejection.
test('identity-bound archive moves only its own letters, retries idempotently, and rejects other identities and escaping names', async t => {
  const { root, mail } = fixture(t, 'codex');
  const admin = createMailbox({ root });
  await admin.deliver(letter());
  await admin.deliver(letter({ id: 'task-two', from: 'codex', to: 'dsh' }));
  assert.deepEqual(await mail.archive('codex', 'task-one'), { archived: 'task-one', idempotent: false });
  assert.ok(fs.existsSync(path.join(root, 'agents/codex/archive/task-one.json')));
  assert.equal(mail.inbox('codex').length, 0);
  assert.deepEqual(await mail.archive('codex', 'task-one'), { archived: 'task-one', idempotent: true });
  await assert.rejects(mail.archive('dsh', 'task-two'), /does not own mailbox/);
  await assert.rejects(mail.reply('dsh', { reply_to: 'task-two', body: 'Reviewed' }), /does not own mailbox/);
  for (const id of ['../task-two', '..\task-two', 'dsh/task-two', '']) await assert.rejects(mail.archive('codex', id), /Invalid LocalPost identifier/);
  await assert.rejects(mail.reply('codex', { reply_to: '../dsh/inbox/task-two', body: 'Reviewed' }), /Invalid LocalPost identifier/);
  assert.throws(() => mail.inbox('../dsh'), /invalid agent identity/);
  assert.ok(fs.existsSync(path.join(root, 'agents/dsh/inbox/task-two.json')));
});

test('an archive failure after a published terminal reply is a visible pending fault that a retry repairs', async t => {
  const { root, mail } = fixture(t, 'codex');
  const admin = createMailbox({ root });
  await admin.deliver(letter());
  const rename = fs.renameSync;
  let failNextArchive = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (failNextArchive && String(to).includes(`${path.sep}archive${path.sep}`)) {
      failNextArchive = false;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  const reply = { reply_to: 'task-one', body: 'Reviewed', outcome: 'completed' };
  await assert.rejects(mail.reply('codex', reply), error => error.code === 'REPLIED_ARCHIVE_PENDING'
    && error.pending === 'task-one' && error.reply.id === 'task-one.result' && /已回执但待归档/.test(error.message));
  assert.equal(admin.read('dsh', 'task-one.result').envelope.outcome, 'completed');
  assert.equal(mail.inbox('codex').length, 1);
  const repaired = await mail.reply('codex', reply);
  assert.equal(repaired.idempotent, true);
  assert.equal(mail.inbox('codex').length, 0);
  assert.equal(admin.inbox('dsh').length, 1);
});

async function runMcp(t, env, calls) {
  const base = { ...process.env, TEMP: tempRoot, TMP: tempRoot };
  for (const key of ['MAILBOX_ROOT', 'MAILBOX_IDENTITY', 'MAILBOX_ADMIN']) delete base[key];
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'mcp-server.mjs')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...base, ...env },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  child.stdin.end(calls.map(value => JSON.stringify(value)).join('\n') + (calls.length ? '\n' : ''));
  const code = await exited;
  return { code, stderr, responses: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [] };
}

test('the MCP server will not start unbound unless administrator mode is explicit', { timeout: 10000 }, async t => {
  const { root } = fixture(t);
  const { createMcpServer } = await import('./mcp-server.mjs');
  assert.throws(() => createMcpServer({ root, admin: false }), /MAILBOX_IDENTITY/);
  const admin = await createMcpServer({ root, admin: true }).handle({ id: 1, method: 'initialize', params: {} });
  assert.match(admin.result.instructions, /administrator mode; not for automated flows/);
  const unbound = await runMcp(t, { MAILBOX_ROOT: root }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.equal(unbound.code, 2);
  assert.equal(unbound.responses.length, 0);
  assert.match(unbound.stderr, /requires MAILBOX_IDENTITY/);
});

test('the identity-bound MCP process enforces own-archive, idempotence, identity and path boundaries', { timeout: 10000 }, async t => {
  const { root } = fixture(t);
  const admin = createMailbox({ root });
  await admin.deliver(letter());
  await admin.deliver(letter({ id: 'task-two', from: 'codex', to: 'dsh' }));
  const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const { code, stderr, responses } = await runMcp(t, { MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex' }, [
    call(1, 'mailbox_archive', { agent: 'codex', id: 'task-one' }),
    call(2, 'mailbox_archive', { agent: 'codex', id: 'task-one' }),
    call(3, 'mailbox_archive', { agent: 'dsh', id: 'task-two' }),
    call(4, 'mailbox_archive', { agent: 'codex', id: '../dsh/inbox/task-two' }),
    call(5, 'mailbox_inbox', { agent: 'codex' }),
  ]);
  assert.equal(code, 0, stderr);
  const text = index => responses[index].result.content[0].text;
  assert.equal(responses[0].result.isError, undefined, text(0));
  assert.equal(JSON.parse(text(0)).idempotent, false);
  assert.equal(JSON.parse(text(1)).idempotent, true);
  assert.equal(responses[2].result.isError, true);
  assert.match(text(2), /does not own mailbox/);
  assert.equal(responses[3].result.isError, true);
  assert.match(text(3), /Invalid LocalPost identifier/);
  assert.equal(JSON.parse(text(4)).letters.length, 0);
  assert.ok(fs.existsSync(path.join(root, 'agents/dsh/inbox/task-two.json')));
});

test('MCP reports a published but unarchived reply as a structured partial failure that archive finishes', async t => {
  const { root } = fixture(t);
  const admin = createMailbox({ root });
  await admin.deliver(letter());
  const { createMcpServer } = await import('./mcp-server.mjs');
  const server = createMcpServer({ root, identity: 'codex' });
  const rename = fs.renameSync;
  let failNextArchive = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (failNextArchive && String(to).includes(`${path.sep}archive${path.sep}`)) {
      failNextArchive = false;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  const call = (id, name, args) => server.handle({ id, method: 'tools/call', params: { name, arguments: args } });
  const reply = { agent: 'codex', reply_to: 'task-one', body: 'Reviewed', outcome: 'completed' };
  const partial = await call(1, 'mailbox_reply', reply);
  assert.equal(partial.result.isError, true);
  const state = JSON.parse(partial.result.content[0].text);
  assert.deepEqual({ ...state, message: undefined }, { status: 'partial_failure', code: 'REPLIED_ARCHIVE_PENDING', reply_delivered: true,
    reply_id: 'task-one.result', outcome: 'completed', archive_pending: 'task-one', retry_action: 'mailbox_reply', message: undefined });
  assert.match(state.message, /identical mailbox_reply/);
  assert.equal(admin.read('dsh', 'task-one.result').envelope.outcome, 'completed');
  assert.equal(admin.inbox('codex').length, 1);
  // The identical reply finishes it: the published result is reused and the original archived.
  const repaired = JSON.parse((await call(2, 'mailbox_reply', reply)).result.content[0].text);
  assert.deepEqual([repaired.idempotent, repaired.archived], [true, 'task-one']);
  assert.equal(admin.inbox('codex').length, 0);
  assert.equal(admin.inbox('dsh').length, 1);
  const plain = await call(4, 'mailbox_archive', { agent: 'codex', id: 'missing' });
  assert.match(plain.result.content[0].text, /^Error: letter not found/);
});

test('MCP identity and administrator combinations fail closed', { timeout: 10000 }, async t => {
  const { root } = fixture(t);
  await createMailbox({ root }).deliver(letter({ id: 'task-two', from: 'codex', to: 'dsh' }));
  const { createMcpServer } = await import('./mcp-server.mjs');
  assert.throws(() => createMcpServer({ root, identity: '../dsh' }), /invalid agent identity/);
  assert.throws(() => createMcpServer({ root, identity: '', admin: false }), /MAILBOX_IDENTITY/);
  const bound = createMcpServer({ root, identity: 'codex', admin: true });
  const crossed = await bound.handle({ id: 1, method: 'tools/call', params: { name: 'mailbox_inbox', arguments: { agent: 'dsh' } } });
  assert.equal(crossed.result.isError, true);
  assert.match(crossed.result.content[0].text, /does not own mailbox/);
  const { code, stderr, responses } = await runMcp(t, { MAILBOX_ROOT: root, MAILBOX_ADMIN: '1', MAILBOX_TOOLS: 'mailbox_rules, mailbox_roster' }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.equal(code, 0, stderr);
  assert.match(responses[0].result.instructions, /administrator mode/);
  assert.deepEqual(responses[1].result.tools.map(tool => tool.name), ['mailbox_rules', 'mailbox_roster']);
});

test('an MCP tool allowlist is enforced on call, not only hidden from the list', async t => {
  const { root } = fixture(t);
  const { createMcpServer } = await import('./mcp-server.mjs');
  assert.throws(() => createMcpServer({ root, identity: 'dsh', tools: 'mailbox_reply,mailbox_sned' }), /Invalid MAILBOX_TOOLS: mailbox_sned/);
  assert.throws(() => createMcpServer({ root, identity: 'dsh', tools: ' , ' }), /Invalid MAILBOX_TOOLS/);
  const server = createMcpServer({ root, identity: 'dsh', tools: 'mailbox_inbox,mailbox_read,mailbox_reply,mailbox_archive' });
  const names = (await server.handle({ id: 1, method: 'tools/list' })).result.tools.map(tool => tool.name);
  assert.deepEqual(names, ['mailbox_inbox', 'mailbox_read', 'mailbox_reply', 'mailbox_archive']);
  const send = await server.handle({ id: 2, method: 'tools/call', params: { name: 'mailbox_send', arguments: letter({ from: 'dsh', to: 'codex' }) } });
  assert.equal(send.result.isError, true);
  assert.match(send.result.content[0].text, /not allowed in this deployment: mailbox_send/);
  assert.equal(fs.existsSync(path.join(root, 'agents/codex/inbox/task-one.json')), false);
  const inbox = await server.handle({ id: 3, method: 'tools/call', params: { name: 'mailbox_inbox', arguments: { agent: 'dsh' } } });
  assert.equal(inbox.result.isError, undefined);
});

test('空 / 非法 MAILBOX_TOOLS 拒绝启动（真实 stdio 子进程），未设置才保留人工默认', { timeout: 30000 }, async t => {
  const { root } = fixture(t);
  const serverFile = path.join(import.meta.dirname, 'mcp-server.mjs');
  const base = { ...process.env, MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex', TEMP: tempRoot, TMP: tempRoot };
  delete base.MAILBOX_TOOLS;
  const run = (extra, calls) => new Promise((resolve, reject) => {
    const env = { ...base, ...extra };
    // 证明空值确实被传入子进程，而不是被测试框架悄悄删掉。
    assert.equal(Object.hasOwn(env, 'MAILBOX_TOOLS'), Object.hasOwn(extra, 'MAILBOX_TOOLS'), 'explicit setting must reach the child');
    const child = spawn(process.execPath, [serverFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end((calls || [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]).map(value => JSON.stringify(value)).join('\n') + '\n');
  });
  // 显式为空 / 纯空白 / 仅逗号 / 未知名称 → 必须 fail closed：退出码 2，且一个工具都不暴露
  for (const bad of ['', '   ', ' , ', 'mailbox_nope']) {
    const result = await run({ MAILBOX_TOOLS: bad });
    assert.equal(result.code, 2, JSON.stringify(bad) + ' must fail closed; stderr=' + result.stderr);
    assert.equal(result.stdout.trim(), '', JSON.stringify(bad) + ' must expose no tools');
    assert.match(result.stderr, /Invalid MAILBOX_TOOLS/);
  }
  // 未设置 → 人工模式默认全部 7 个
  const unset = await run({});
  assert.equal(unset.code, 0, unset.stderr);
  assert.equal(JSON.parse(unset.stdout.trim()).result.tools.length, 7);
  // 有效限制名单 → 列表隐藏 + 直接调用都受限
  const limited = await run({ MAILBOX_TOOLS: 'mailbox_inbox,mailbox_archive' }, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mailbox_send', arguments: letter({ from: 'codex', to: 'dsh' }) } },
  ]);
  assert.equal(limited.code, 0, limited.stderr);
  const lines = limited.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines[0].result.tools.map(tool => tool.name), ['mailbox_inbox', 'mailbox_archive']);
  assert.equal(lines[1].result.isError, true);
  assert.match(lines[1].result.content[0].text, /not allowed in this deployment: mailbox_send/);
});

test('a process killed between publishing a reply and archiving recovers by rule: one result, original archived, dead lease reclaimed', { timeout: 15000 }, async t => {
  const { root, mail } = fixture(t, 'codex');
  await createMailbox({ root }).deliver(letter());
  const barrier = path.join(root, 'published.barrier');
  const reply = { reply_to: 'task-one', body: 'Reviewed', outcome: 'completed' };
  // The child blocks synchronously inside the archive rename, i.e. after the result is public.
  // 以落盘 fixture 启动，不用 node -e（本机规则禁止内联脚本：PDM 会拦文件操作类内联脚本）。
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'reply-then-hang.mjs')], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, LP_ROOT: root, LP_BARRIER: barrier, LP_REPLY: JSON.stringify(reply), LP_MAILBOX_URL: new URL('./mailbox.mjs', import.meta.url).href } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise(resolve => child.on('close', resolve));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(barrier)) {
    assert.ok(Date.now() < deadline && child.exitCode === null, 'child never reached the archive step');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill();
  await exited;
  const lease = path.join(root, '.mailbox-write.lock');
  assert.ok(fs.existsSync(path.join(root, 'agents/dsh/inbox/task-one.result.json')), 'result is public');
  assert.equal(mail.inbox('codex').length, 1, 'original still pending');
  assert.ok(fs.existsSync(lease), 'dead owner left its lease');
  const { acquireLease } = await import('./fs-safe.mjs');
  assert.equal((await acquireLease(root, { name: '.mailbox-write.lock', staleMs: 60000 })).acquired, false, 'a fresh lease is not stolen');
  const owner = JSON.parse(fs.readFileSync(lease, 'utf8'));
  fs.writeFileSync(lease, JSON.stringify({ ...owner, started_at: Date.now() - 61000 }));
  const repaired = await mail.reply('codex', reply);
  assert.equal(repaired.idempotent, true);
  assert.equal(mail.inbox('codex').length, 0);
  assert.equal(createMailbox({ root }).inbox('dsh').length, 1);
  assert.equal(fs.existsSync(lease), false);
});
