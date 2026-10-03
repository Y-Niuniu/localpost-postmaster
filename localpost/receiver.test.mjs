import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReceiver } from './receiver.mjs';
import { createMailbox } from './mailbox.mjs';
import { createDshAdapter } from './dsh-adapter.mjs';
import { createSessionStore } from './session-binding.mjs';
import { createBindingProvider, bindFromChatAction } from './binding-provider.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTree, removeTreeSync } from './temp-tree.mjs';

// The receiver runs against the real binding provider, ledger acceptance and DSH adapter; only the host is faked.
const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/receiver');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CWD_A = 'C:/work/project-a';
// The host's word for which chat is calling (DSH: execution.agent of a native tool call).
const CHAT_A = { host: 'local', session: 'chat-a' };
const letter = (id, extra = {}) => ({ id, thread_id: id, from: 'codex', to: 'dsh', type: 'task', subject: 'test', body: 'Analyze only',
  budget: 'standard', created_at: new Date().toISOString(), ...extra });

async function world(t, { bound = true } = {}) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const host = createFakeDshHost({ root });
  host.openThread('chat-a', CWD_A);
  host.openThread('chat-b', 'C:/work/project-b');
  if (bound) assert.equal((await bindFromChatAction(createSessionStore({ root }), 'dsh', { host, action: host.userBindAction('chat-a'), authority: AUTHORITY })).ok, true);
  const adapter = () => createDshAdapter({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2',
    bindingProvider: createBindingProvider({ store: createSessionStore({ root }), identity: 'dsh', host }),
    acceptance: createLedgerAcceptance({ store: createSessionStore({ root }), identity: 'dsh' }) });
  const receiver = (extra = {}) => createReceiver({ root, agent: 'dsh', allowFrom: ['codex'], adapter: adapter(), ...extra });
  return { root, host, receiver, mail: createMailbox({ root }), entries: async () => (await receiver().snapshot()).entries };
}
const rebindByHand = (root, session) => {
  const file = path.join(root, 'runtime/sessions/dsh.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.binding = { ...state.binding, session };
  fs.writeFileSync(file, JSON.stringify(state));
};

test('legacy backlog stays untouched; mail that arrives unbound has no arrival route and never becomes automatic later', async t => {
  const { root, host, mail, receiver, entries } = await world(t, { bound: false });
  await mail.deliver(letter('old'));
  const plain = receiver({ adapter: undefined });
  await plain.scan();
  await mail.deliver(letter('new'));
  await plain.scan();
  let state = await entries();
  assert.equal(state.old.state, 'historical');
  assert.deepEqual([state.new.state, state.new.reason, state.new.route], ['manual', 'no_arrival_record', undefined]);
  // A binding made afterwards serves later mail only; without a verified adapter nothing is dispatched in any case.
  assert.equal((await bindFromChatAction(createSessionStore({ root }), 'dsh', { host, action: host.userBindAction('chat-a'), authority: AUTHORITY })).ok, true);
  await mail.deliver(letter('later'));
  await plain.scan();
  state = await entries();
  assert.deepEqual([state.new.state, state.new.reason], ['manual', 'no_arrival_record']);
  assert.deepEqual([state.later.state, state.later.reason, state.later.route.threadId], ['queued', 'runtime_capabilities_unverified', 'chat-a']);
});

test('routes come only from the receiver: envelopes and delivery cannot set one, a forged route file is ignored', async t => {
  const { root, host, mail, receiver, entries } = await world(t);
  const forged = { threadId: 'chat-b', cwd: 'C:/work/project-b', hostId: 'local', generation: 1 };
  await assert.rejects(mail.deliver(letter('x', { route: forged })), /route/);
  await assert.rejects(mail.deliver(letter('y'), { route: forged }), /route/);
  await receiver().scan();
  await mail.deliver(letter('task-1'));
  await fsp.mkdir(path.join(root, 'runtime/routes'), { recursive: true });
  await fsp.writeFile(path.join(root, 'runtime/routes/task-1.json'), JSON.stringify({ ...forged, messageId: 'task-1' }));
  await receiver().scan();
  const entry = (await entries())['task-1'];
  assert.deepEqual([entry.state, entry.route.threadId, entry.route.cwd, entry.route.generation], ['submitted', 'chat-a', CWD_A, 1]);
  assert.deepEqual(host.followups().map(x => x.threadId), ['chat-a']);
});

test('the arrival snapshot is immutable: a later rebinding to chat B never moves earlier mail', async t => {
  const { root, host, mail, receiver, entries } = await world(t);
  await receiver().scan();
  host.setOnline('chat-a', false);
  await mail.deliver(letter('early'));
  await receiver().scan();
  let entry = (await entries()).early;
  assert.deepEqual([entry.state, entry.reason, entry.route.threadId], ['queued', 'binding_unverified', 'chat-a'], 'routed to A, pending while A is offline');
  rebindByHand(root, { host: 'local', id: 'chat-b', cwd: 'C:/work/project-b' });
  host.setOnline('chat-a', true);
  await mail.deliver(letter('late'));
  await receiver().scan();
  const state = await entries();
  assert.deepEqual([state.early.state, state.early.reason, state.early.route.threadId], ['needs_reconcile', 'route_unresolvable', 'chat-a']);
  assert.deepEqual([state.late.state, state.late.reason], ['manual', 'binding_unattested'], 'an unattested binding routes nothing new either');
  assert.equal(host.followups().length, 0, 'nothing reached chat B, nothing reached the old chat A');
});

test('a new, properly attested binding to chat B serves new mail only; mail that arrived under A is never redirected', async t => {
  const { root, host, mail, receiver, entries } = await world(t);
  await receiver().scan();
  host.setOnline('chat-a', false);
  await mail.deliver(letter('early'));
  await receiver().scan();
  assert.equal((await entries()).early.route.threadId, 'chat-a');
  // The user binds chat B explicitly (the old binding record removed by an operator first).
  fs.rmSync(path.join(root, 'runtime/sessions/dsh.json'));
  assert.equal((await bindFromChatAction(createSessionStore({ root }), 'dsh', { host, action: host.userBindAction('chat-b'), authority: AUTHORITY })).ok, true);
  await mail.deliver(letter('late'));
  await receiver().scan();
  const state = await entries();
  assert.deepEqual([state.early.state, state.early.reason, state.early.route.threadId], ['needs_reconcile', 'route_unresolvable', 'chat-a']);
  assert.deepEqual([state.late.state, state.late.route.threadId], ['submitted', 'chat-b']);
  assert.deepEqual(host.followups().map(x => [x.threadId, /"id":"(\w+)"/.exec(x.text)[1]]), [['chat-b', 'late']]);
});

test('an offline bound chat keeps mail pending; online it is woken once; restarts never resubmit; results drive state', async t => {
  const { root, host, mail, receiver, entries } = await world(t);
  await receiver().scan();
  host.setOnline('chat-a', false);
  await mail.deliver(letter('queued'));
  await receiver().scan();
  assert.equal((await entries()).queued.state, 'queued');
  assert.equal(host.followups().length, 0);
  host.setOnline('chat-a', true);
  await receiver().scan();
  await receiver().scan();
  assert.equal((await entries()).queued.state, 'submitted');
  assert.equal(host.followups().length, 1);
  // Runtime acceptance is not business completion; the bound session's own replies are.
  const reply = createMailbox({ root, identity: 'dsh' });
  await reply.reply('dsh', { reply_to: 'queued', body: 'User authority required', outcome: 'needs_authorization' }, { caller: CHAT_A });
  await receiver().scan();
  assert.equal((await entries()).queued.state, 'awaiting_authorization');
  await reply.reply('dsh', { reply_to: 'queued', body: 'Analyzed', outcome: 'completed' }, { caller: CHAT_A });
  await receiver().scan();
  assert.equal((await entries()).queued.state, 'completed');
  assert.equal(host.followups().length, 1);
});

test('uncertain acceptance is never retried, an untrusted sender is blocked, and other mail keeps flowing', async t => {
  const { host, mail, receiver, entries } = await world(t);
  await receiver().scan();
  host.breakFollowups('lost');
  await mail.deliver(letter('uncertain'));
  await mail.deliver(letter('denied', { from: 'other' }));
  await receiver().scan();
  await receiver().scan();
  host.breakFollowups(null);
  await mail.deliver(letter('later'));
  await receiver().scan();
  const state = await entries();
  assert.deepEqual([state.uncertain.state, state.uncertain.reason], ['needs_reconcile', 'dispatch_uncertain']);
  assert.equal(state.denied.state, 'denied');
  assert.equal(state.later.state, 'submitted');
  assert.deepEqual(host.followups().map(x => x.text.includes('"uncertain"')), [true, false], 'the uncertain letter was woken once, never again');
});

test('two receivers scanning at the same time wake each letter once', async t => {
  const { host, mail, receiver } = await world(t);
  await receiver().scan();
  for (const id of ['a', 'b', 'c']) await mail.deliver(letter(id));
  await Promise.all([receiver().scan(), receiver().scan(), receiver().scan()]);
  await receiver().scan();
  assert.equal(host.followups().length, 3);
  assert.deepEqual(host.followups().map(x => /"id":"(\w)"/.exec(x.text)[1]).sort(), ['a', 'b', 'c']);
});

test('a chat that moved to another workspace or host is not verified; its mail stays pending', async t => {
  const { host, mail, receiver, entries } = await world(t);
  await receiver().scan();
  host.openThread('chat-a', 'C:/work/moved');
  await mail.deliver(letter('moved'));
  await receiver().scan();
  assert.deepEqual([(await entries()).moved.state, (await entries()).moved.reason], ['queued', 'binding_unverified']);
  assert.equal(host.followups().length, 0);
});

test('sender permission revoked before dispatch also applies to persisted queued mail', async t => {
  const { host, mail, receiver, entries } = await world(t);
  await receiver().scan();
  host.setOnline('chat-a', false);
  await mail.deliver(letter('revoke'));
  await receiver().scan();
  host.setOnline('chat-a', true);
  await receiver({ allowFrom: [] }).scan();
  assert.equal((await entries()).revoke.state, 'denied');
  assert.equal(host.followups().length, 0);
});

test('periodic scan discovers mail even if watch hints are missed and a result causes no automatic reply', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'localpost-watch-'));
  const receiver = createReceiver({ root, agent: 'codex', allowFrom: ['dsh'], scanIntervalMs: 20, debounceMs: 1000 });
  try {
    await receiver.start();
    await createMailbox({ root, identity: 'dsh' }).deliver({ ...letter('result-incoming', { type: 'result', reply_to: 'earlier' }), from: 'dsh', to: 'codex' });
    let found;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      found = (await receiver.snapshot()).entries['result-incoming'];
      if (found) break;
    }
    assert.deepEqual([found?.state, found?.reason], ['manual', 'result'], 'a result is never relayed to a chat');
    assert.equal((await fsp.readdir(path.join(root, 'agents'))).includes('dsh'), false);
  } finally { await receiver.stop(); await removeTree(root); }
});

test('crash after runtime processed and archived is reconciled only by explicit result', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'localpost-crash-'));
  try {
    let clock = Date.now();
    const options = { root, agent: 'codex', allowFrom: ['dsh'], now: () => clock };
    const receiver = createReceiver(options);
    await receiver.scan(); clock += 1000;
    await createMailbox({ root }).deliver({ ...letter('crash', { created_at: new Date(clock).toISOString() }), from: 'dsh', to: 'codex' });
    await receiver.scan();
    const state = await receiver.snapshot();
    state.entries.crash.state = 'dispatching';
    await fsp.writeFile(path.join(root, 'runtime/queues/codex.json'), JSON.stringify(state));
    await createMailbox({ root, identity: 'codex' }).reply('codex', { reply_to: 'crash', body: 'complete', outcome: 'completed' });
    await createReceiver(options).scan();
    assert.equal((await receiver.snapshot()).entries.crash.state, 'completed');
  } finally { await removeTree(root); }
});

test('prototype property identifiers survive persisted queue roundtrips', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'localpost-id-'));
  try {
    const options = { root, agent: 'codex', allowFrom: ['dsh'] };
    const receiver = createReceiver(options); await receiver.scan();
    for (const id of ['constructor', 'toString']) await createMailbox({ root }).deliver({ ...letter(id, { created_at: '2020-01-01T00:00:00Z' }), from: 'dsh', to: 'codex' });
    await receiver.scan(); await createReceiver(options).scan();
    const state = await receiver.snapshot();
    for (const id of ['constructor', 'toString']) { assert.equal(Object.hasOwn(state.entries, id), true); assert.equal(state.entries[id].state, 'manual'); }
  } finally { await removeTree(root); }
});
