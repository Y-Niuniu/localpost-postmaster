import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReceiver } from './receiver.mjs';
import { createMailbox } from './mailbox.mjs';

const letter = (id, extra = {}) => ({ id, thread_id: id, from: 'dsh', to: 'codex', type: 'task', subject: 'test', body: 'Analyze only', budget: 'standard', created_at: new Date().toISOString(), ...extra });
test('legacy backlog stays untouched; new mail queues without a client or route', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-receiver-'));
  try {
    const mailbox = createMailbox({ root, identity: 'dsh' });
    await mailbox.deliver(letter('old'));
    const receiver = createReceiver({ root, agent: 'codex', allowFrom: ['dsh'] });
    await receiver.scan();
    await mailbox.deliver(letter('new'));
    await receiver.scan();
    const state = await receiver.snapshot();
    assert.equal(state.entries.old.state, 'historical');
    assert.equal(state.entries.new.state, 'unbound');
    assert.equal(mailbox.inbox('dsh').length, 0);
    assert.ok(await fs.stat(path.join(root, 'agents/codex/inbox/old.json')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('uncertain runtime acceptance is never blindly retried and untrusted sender is blocked', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-uncertain-'));
  try {
    let clock = Date.now(), calls = 0;
    const adapter = { capabilities: { trustedFocus: true, wholeTurn: true, sourceIsRelay: true, dispatchIdempotent: true }, isRunning: async () => true, submit: async () => { calls++; throw new Error('connection lost'); } };
    const options = { root, agent: 'codex', allowFrom: ['dsh'], adapter, now: () => clock };
    const receiver = createReceiver(options);
    await receiver.scan(); clock += 1000;
    const mail = createMailbox({ root });
    const route = { threadId: 'chat-A', cwd: root, hostId: 'local', focusRevision: 1, publishedAt: new Date(clock).toISOString(), scope: 'analysis-reply' };
    await mail.deliver(letter('uncertain', { created_at: new Date(clock).toISOString() }), { route });
    await mail.deliver(letter('denied', { from: 'other', created_at: new Date(clock).toISOString() }), { route });
    await receiver.scan(); await createReceiver(options).scan();
    const state = await receiver.snapshot();
    assert.equal(state.entries.uncertain.state, 'needs_reconcile');
    assert.equal(state.entries.denied.state, 'denied');
    assert.equal(calls, 1);
    assert.equal((await fs.readFile(path.join(root, 'runtime/queues/codex.json'), 'utf8')).includes('Analyze only'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('periodic scan discovers mail even if watch hints are missed and result does not cause automatic reply', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-watch-'));
  const receiver = createReceiver({ root, agent: 'codex', allowFrom: ['dsh'], scanIntervalMs: 20, debounceMs: 1000 });
  try {
    await receiver.start();
    await createMailbox({ root, identity: 'dsh' }).deliver(letter('result-incoming', { type: 'result', reply_to: 'earlier' }));
    let found;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      found = (await receiver.snapshot()).entries['result-incoming'];
      if (found) break;
    }
    assert.equal(found?.state, 'unbound');
    assert.equal((await fs.readdir(path.join(root, 'agents'))).includes('dsh'), false);
  } finally { await receiver.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test('crash after runtime processed and archived is reconciled only by explicit result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-crash-'));
  try {
    let clock = Date.now();
    const options = { root, agent: 'codex', allowFrom: ['dsh'], now: () => clock };
    const receiver = createReceiver(options);
    await receiver.scan(); clock += 1000;
    await createMailbox({ root }).deliver(letter('crash', { created_at: new Date(clock).toISOString() }), { route: { threadId: 'chat-A', cwd: root, hostId: 'local', focusRevision: 1, publishedAt: new Date(clock).toISOString(), scope: 'analysis-reply' } });
    await receiver.scan();
    const state = await receiver.snapshot();
    state.entries.crash.state = 'dispatching';
    await fs.writeFile(path.join(root, 'runtime/queues/codex.json'), JSON.stringify(state));
    await createMailbox({ root, identity: 'codex' }).reply('codex', { reply_to: 'crash', body: 'complete', outcome: 'completed' });
    await createReceiver(options).scan();
    assert.equal((await receiver.snapshot()).entries.crash.state, 'completed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('prototype property identifiers survive persisted queue roundtrips', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-id-'));
  try {
    const options = { root, agent: 'codex', allowFrom: ['dsh'] };
    const receiver = createReceiver(options); await receiver.scan();
    for (const id of ['constructor', 'toString']) await createMailbox({ root }).deliver(letter(id, { created_at: '2020-01-01T00:00:00Z' }));
    await receiver.scan(); await createReceiver(options).scan();
    const state = await receiver.snapshot();
    for (const id of ['constructor', 'toString']) { assert.equal(Object.hasOwn(state.entries, id), true); assert.equal(state.entries[id].state, 'unbound'); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('publication binds A, closed client queues, restart never resubmits accepted mail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-route-'));
  try {
    let clock = Date.now(), open = false;
    const calls = [];
    const adapter = {
      capabilities: { trustedFocus: true, wholeTurn: true, sourceIsRelay: true, dispatchIdempotent: true },
      isRunning: async () => open,
      submit: async request => { calls.push(request); return { accepted: true, receipt: 'r1' }; },
    };
    const options = { root, agent: 'codex', allowFrom: ['dsh'], adapter, now: () => clock };
    const receiver = createReceiver(options);
    await receiver.scan(); clock += 1000;
    const env = letter('queued', { created_at: new Date(clock).toISOString() });
    await createMailbox({ root, identity: 'dsh' }).deliver(env, { route: { threadId: 'chat-A', cwd: root, hostId: 'local', focusRevision: 1, publishedAt: new Date(clock).toISOString(), scope: 'analysis-reply' } });
    await receiver.scan();
    assert.equal((await receiver.snapshot()).entries.queued.state, 'queued');
    assert.equal(calls.length, 0);
    open = true;
    await receiver.scan();
    await createReceiver(options).scan();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target.threadId, 'chat-A');
    assert.equal(calls[0].after, 'whole-turn');
    assert.equal(calls[0].source.kind, 'plugin');
    assert.equal((await receiver.snapshot()).entries.queued.state, 'submitted');
    // Runtime acceptance / idle is not business completion.
    const reply = createMailbox({ root, identity: 'codex' });
    await reply.reply('codex', { reply_to: 'queued', body: 'User authority required', outcome: 'needs_authorization' });
    await receiver.scan();
    assert.equal((await receiver.snapshot()).entries.queued.state, 'awaiting_authorization');
    await reply.reply('codex', { reply_to: 'queued', body: 'Analyzed', outcome: 'completed' });
    await receiver.scan();
    assert.equal((await receiver.snapshot()).entries.queued.state, 'completed');
    assert.equal(calls.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
