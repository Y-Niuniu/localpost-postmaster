import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createMailbox, envelopeDigest } from './mailbox.mjs';
import { createReceiver } from './receiver.mjs';
import { createDshAdapter } from './dsh-adapter.mjs';
import { createSessionStore, bind } from './session-binding.mjs';
import { createBindingProvider, bindFromChatAction } from './binding-provider.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { dispatchLetter, complete, transferForSwitchIn, resolveUncertain, beginCompletionIn } from './letter-claims.mjs';
import { createRotation, candidateSessionId } from './rotation.mjs';
import { switchMode } from './letter-claims.mjs';
import { createMcpServer } from './mcp-server.mjs';
import { createMailTurnGuard } from './mail-turn-guard.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { createFakeHost } from './fixtures/fake-session-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

// Regressions for codex's review of 6e50dd4 (2026-10-03, docs/t1-review-findings-20261003.md): three P0 and two P1.
// Each test states the required behaviour; on 6e50dd4 every one of them fails for the reason its finding names.
const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/t1-review');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CWD_A = 'C:/work/project-a';
const CHAT_A = { host: 'local', session: 'chat-a', cwd: CWD_A };
const CHAT_B = { host: 'local', session: 'chat-b', cwd: 'C:/work/project-b' };
const letter = (id, extra = {}) => ({ id, thread_id: id, from: 'codex', to: 'dsh', type: 'task', subject: 'Analyze', body: 'Analyze only',
  budget: 'standard', created_at: '2026-10-03T00:00:00.000Z', ...extra });
const crashFixture = path.join(import.meta.dirname, 'fixtures/claim-crash-window.mjs');

/** dsh bound (attested chat action) to chat A in automatic mode; chat B is open on the same host. */
async function world(t) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const host = createFakeDshHost({ root });
  host.openThread('chat-a', CWD_A);
  host.openThread('chat-b', 'C:/work/project-b');
  const store = createSessionStore({ root });
  const bindTo = async thread =>
    assert.equal((await bindFromChatAction(store, 'dsh', { host, action: host.userBindAction(thread), authority: AUTHORITY })).ok, true);
  await bindTo('chat-a');
  const acceptance = createLedgerAcceptance({ store, identity: 'dsh' });
  const mailTurnGuard = createMailTurnGuard({ policy: () => 'test: outside the five', agents: host.ctx.agents });
  const receiver = () => createReceiver({ root, agent: 'dsh', allowFrom: ['codex'], adapter: createDshAdapter({ ctx: host.ctx,
    runtimeVersion: '0.2.0-rc.2', bindingProvider: createBindingProvider({ store, identity: 'dsh', host }), acceptance, mailTurnGuard }) });
  const target = { identity: 'dsh', hostId: 'local', threadId: 'chat-a', cwd: CWD_A, generation: 1 };
  const acceptForA = id => acceptance.acceptOnce({ key: `dsh:${id}`, target, messageReference: { agent: 'dsh', id },
    digest: envelopeDigest(letter(id)) }, async () => {});
  return { root, host, store, bindTo, receiver, acceptForA, admin: createMailbox({ root }), mail: createMailbox({ root, identity: 'dsh' }) };
}

test('P0-1: mail that arrived while chat A was bound never goes to chat B, even when the receiver first sees it after the rebind', async t => {
  const { root, host, bindTo, receiver, admin } = await world(t);
  await receiver().scan();                                   // the receiver runs; nothing is pending
  await admin.deliver(letter('early'));                      // arrives under A ...
  fs.rmSync(path.join(root, 'runtime/sessions/dsh.json'));   // ... and before the next scan the user rebinds to chat B
  await bindTo('chat-b');
  await receiver().scan();
  assert.deepEqual(host.followups().map(x => x.threadId), [], 'nothing reached chat B, nor the no longer bound chat A');
  const early = (await receiver().snapshot()).entries.early;
  assert.deepEqual([early.state, early.route?.threadId], ['needs_reconcile', 'chat-a'], 'its arrival route is A, which no longer resolves');
  await admin.deliver(letter('late'));                       // mail that arrives after the rebind is B's
  await receiver().scan();
  assert.deepEqual(host.followups().map(x => [x.threadId, /"id":"(\w+)"/.exec(x.text)[1]]), [['chat-b', 'late']]);
});

test('P0-1: only the arrival record routes mail; results, manual-mode arrivals and hand-written letters never reach a chat', async t => {
  const { root, host, store, receiver, admin, mail } = await world(t);
  await receiver().scan();
  await admin.deliver(letter('answer', { type: 'result', reply_to: 'question', outcome: 'completed' }));
  assert.equal((await switchMode(store, 'dsh', 'manual')).ok, true);
  await admin.deliver(letter('in-manual'));
  assert.equal((await switchMode(store, 'dsh', 'auto')).ok, true);
  fs.writeFileSync(path.join(root, 'agents/dsh/inbox/by-hand.json'), JSON.stringify(letter('by-hand')));
  await admin.deliver(letter('swapped'));
  fs.writeFileSync(path.join(root, 'agents/dsh/inbox/swapped.json'), JSON.stringify(letter('swapped', { body: 'Something else' })));
  await admin.deliver(letter('normal'));
  await receiver().scan();
  const entries = (await receiver().snapshot()).entries;
  const view = id => [entries[id].state, entries[id].reason];
  assert.deepEqual(view('answer'), ['manual', 'result']);
  assert.deepEqual(view('in-manual'), ['manual', 'binding_manual']);
  assert.deepEqual(view('by-hand'), ['manual', 'no_arrival_record']);
  assert.deepEqual(view('swapped'), ['needs_reconcile', 'arrival_record_conflict']);
  assert.deepEqual(host.followups().map(x => /"id":"([\w-]+)"/.exec(x.text)[1]), ['normal'], 'only the routed letter woke the chat');
  await assert.rejects(mail.take('dsh', 'swapped', { caller: CHAT_A }), { code: 'ARRIVAL_CONFLICT' });
  assert.equal((await mail.take('dsh', 'in-manual')).envelope.id, 'in-manual', 'manual-mode mail stays with the manual consumer');
});

test('P0-2: a letter delivered to chat A can be handled only by a caller the host proves to be chat A', async t => {
  const { root, acceptForA, admin, mail } = await world(t);
  await admin.deliver(letter('one'));
  assert.equal((await acceptForA('one')).accepted, true);
  // Same MAILBOX_IDENTITY, nothing proves which chat is calling: refused, whatever the operation.
  for (const action of [() => mail.take('dsh', 'one'), () => mail.reply('dsh', { reply_to: 'one', body: 'x' }), () => mail.archive('dsh', 'one')])
    await assert.rejects(action(), { code: 'CALLER_UNVERIFIED' });
  // Another chat of the same identity, proven by the host: refused as not the owner.
  for (const action of [() => mail.take('dsh', 'one', { caller: CHAT_B }), () => mail.reply('dsh', { reply_to: 'one', body: 'x' }, { caller: CHAT_B }),
    () => mail.archive('dsh', 'one', { caller: CHAT_B })]) await assert.rejects(action(), { code: 'NOT_LETTER_OWNER' });
  await assert.rejects(mail.take('dsh', 'one', { caller: { ...CHAT_A, host: 'other-host' } }), { code: 'NOT_LETTER_OWNER' }, 'same chat id on another host');
  // DSH's MCP client forwards only the tool name and arguments, so the MCP server cannot tell chats apart either.
  const server = createMcpServer({ root, identity: 'dsh' });
  const answer = await server.handle({ id: 1, method: 'tools/call', params: { name: 'mailbox_reply', arguments: { agent: 'dsh', reply_to: 'one', body: 'x' } } });
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /CALLER_UNVERIFIED/);
  assert.equal(fs.existsSync(path.join(root, 'agents/codex/inbox/one.result.json')), false, 'nobody but the owner published a result');
  assert.equal((await mail.take('dsh', 'one', { caller: CHAT_A })).envelope.id, 'one');
  assert.equal((await mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' }, { caller: CHAT_A })).ledger, 'done');
});

/**
 * Runs archive/reply in a child that dies at `point` (fixtures/claim-crash-window.mjs): right after the letter is archived,
 * before its claim is completed (after-archive), or right after the completion intent is written, before anything is
 * published (before-publish).
 */
async function crashInWindow(t, op, point = 'after-archive') {
  const w = await world(t);
  await w.admin.deliver(letter('one'));
  assert.equal((await w.acceptForA('one')).accepted, true);
  const child = spawn(process.execPath, [crashFixture, w.root, op, 'one', 'chat-a', point, CWD_A], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await once(child, 'exit');
  assert.doesNotMatch(output, /finished/, 'the child died inside the window: ' + output);
  assert.equal(fs.existsSync(path.join(w.root, 'agents/dsh/archive/one.json')), point === 'after-archive',
    point === 'after-archive' ? 'the letter was archived before the crash' : 'nothing was archived before the crash');
  return w;
}
for (const op of ['archive', 'reply']) {
  test(`P0-3 (${op}): whatever a crash between archiving and completing leaves behind can never move to a new session`, async t => {
    const { store } = await crashInWindow(t, op);
    const draft = structuredClone(await store.read('dsh'));
    const moved = transferForSwitchIn(draft, 1, { generation: 2, session: 'chat-next' }, { revoked: true }, new Date().toISOString());
    assert.deepEqual(moved.transferred, [], 'an archived letter is not transferred, even with a proven barrier');
    assert.deepEqual([moved.pinned, draft.claims.one.reason, draft.claims.one.completion.op], [['one'], 'completion_interrupted', op]);
  });
  test(`P0-3 (${op}): the owner's retry after such a crash completes the claim`, async t => {
    const { store, mail } = await crashInWindow(t, op);
    await (op === 'archive' ? mail.archive('dsh', 'one', { caller: CHAT_A })
      : mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' }, { caller: CHAT_A }));
    assert.equal((await store.read('dsh')).claims.one.status, 'done');
  });
}

// Third review round (codex 2026-10-03): a completion intent, once written, is immutable. Only the very same operation
// with the very same content (result id + digest of what the reply publishes) may finish or repeat it.
const CONFLICT = { code: 'COMPLETION_INTENT_CONFLICT' };
const listed = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const published = root => listed(path.join(root, 'agents/codex/inbox'));

test('R3: after a reply crashed before publishing, only the identical reply may finish the letter, also once it is done', async t => {
  const { root, store, mail } = await crashInWindow(t, 'reply', 'before-publish');
  let claim = (await store.read('dsh')).claims.one;
  assert.deepEqual([claim.status, claim.completion.op, claim.completion.result], ['completing', 'reply', 'one.result']);
  assert.deepEqual(published(root), [], 'nothing was published before the crash');
  const same = { reply_to: 'one', body: 'Done', outcome: 'completed' };
  for (const attempt of [
    () => mail.archive('dsh', 'one', { caller: CHAT_A }),                                                   // reply A → archive
    () => mail.reply('dsh', { ...same, reply_id: 'one.result.b' }, { caller: CHAT_A }),                      // reply A → reply B
    () => mail.reply('dsh', { ...same, body: 'Something else' }, { caller: CHAT_A }),                        // same id, other body
    () => mail.reply('dsh', { ...same, outcome: 'failed' }, { caller: CHAT_A }),                             // same id, other outcome
  ]) await assert.rejects(attempt(), CONFLICT);
  assert.equal(fs.existsSync(path.join(root, 'agents/dsh/inbox/one.json')), true, 'every refused attempt left the letter in place');
  assert.deepEqual(published(root), [], 'and published nothing');
  assert.equal((await store.read('dsh')).claims.one.status, 'completing');
  // The identical retry finishes the letter and stays idempotent afterwards.
  assert.equal((await mail.reply('dsh', same, { caller: CHAT_A })).ledger, 'done');
  assert.equal((await mail.reply('dsh', same, { caller: CHAT_A })).idempotent, true);
  // A done letter is checked the same way.
  await assert.rejects(mail.archive('dsh', 'one', { caller: CHAT_A }), CONFLICT);
  await assert.rejects(mail.reply('dsh', { ...same, body: 'Done, but differently' }, { caller: CHAT_A }), CONFLICT);
  await assert.rejects(mail.reply('dsh', { ...same, reply_id: 'one.result.b' }, { caller: CHAT_A }), CONFLICT);
  assert.deepEqual(published(root), ['one.result.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'agents/codex/inbox/one.result.json'), 'utf8')).body, 'Done');
});

test('R3: after an archive crashed before publishing, a reply cannot take over; the identical archive finishes it', async t => {
  const { root, store, mail } = await crashInWindow(t, 'archive', 'before-publish');
  const claim = (await store.read('dsh')).claims.one;
  assert.deepEqual([claim.status, claim.completion.op], ['completing', 'archive']);
  await assert.rejects(mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' }, { caller: CHAT_A }), CONFLICT);
  assert.deepEqual(published(root), []);
  assert.equal((await mail.archive('dsh', 'one', { caller: CHAT_A })).ledger, 'done');
  assert.equal((await mail.archive('dsh', 'one', { caller: CHAT_A })).idempotent, true);
});

test('R3: a completion interrupted and pinned by a rotation keeps its intent; only that operation finishes it', async t => {
  const { root, store, mail } = await crashInWindow(t, 'reply', 'before-publish');
  await store.update('dsh', state => { transferForSwitchIn(state, 1, { generation: 2, session: 'chat-next' }, { revoked: true }, store.at()); });
  const claim = (await store.read('dsh')).claims.one;
  assert.deepEqual([claim.status, claim.reason, claim.completion.op], ['needs_reconcile', 'completion_interrupted', 'reply']);
  await assert.rejects(mail.archive('dsh', 'one', { caller: CHAT_A }), CONFLICT);
  await assert.rejects(mail.reply('dsh', { reply_to: 'one', body: 'Other', outcome: 'completed' }, { caller: CHAT_A }), CONFLICT);
  assert.equal((await mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' }, { caller: CHAT_A })).ledger, 'done');
  assert.deepEqual(published(root), ['one.result.json']);
});

test('R3: a letter an operator closed without any recorded intent refuses every later reply or archive', async t => {
  const w = await world(t);
  await w.admin.deliver(letter('one'));
  // The wake-up may have happened but its confirmation was lost: uncertain, pinned for reconciliation.
  const lost = { submit: async () => { throw new Error('connection lost after the wake-up was queued'); } };
  assert.equal((await dispatchLetter(w.store, 'dsh', { id: 'one', digest: envelopeDigest(letter('one')) }, lost)).claim.status, 'needs_reconcile');
  const claim = (await w.store.read('dsh')).claims.one;
  assert.equal((await resolveUncertain(w.store, 'dsh', 'one', { outcome: 'done', expectedVersion: claim.version })).ok, true);
  for (const attempt of [() => w.mail.archive('dsh', 'one', { caller: CHAT_A }),
    () => w.mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' }, { caller: CHAT_A })]) await assert.rejects(attempt(), CONFLICT);
  assert.deepEqual(published(w.root), []);
});

test('R3: the ledger compares the operation and the result id themselves, not only the content digest that usually covers them', () => {
  const at = '2026-10-03T00:00:00.000Z', owner = { generation: 1, session: 'chat-a' };
  const state = { claims: { one: { letter: 'one', digest: 'd'.repeat(64), owner, status: 'accepted', version: 1, history: [] } } };
  const reply = { op: 'reply', result: 'one.result', digest: 'c'.repeat(64) };
  assert.equal(beginCompletionIn(state, 'one', owner, reply, at).ok, true);
  assert.equal(beginCompletionIn(state, 'one', owner, { ...reply, op: 'archive' }, at).reason, 'completion_intent_conflict');
  assert.equal(beginCompletionIn(state, 'one', owner, { ...reply, result: 'one.result.b' }, at).reason, 'completion_intent_conflict');
  assert.equal(beginCompletionIn(state, 'one', owner, reply, at).reused, true);
});

// Fourth review round (codex 2026-10-03): the complete result envelope is built and validated before the immutable intent is
// written, its publishable content is the intent digest, and only the identical reply finishes an archive-pending one.
test('R4: an invalid reply fails before any intent is written; the corrected reply then completes the letter', async t => {
  const { root, store, acceptForA, admin, mail } = await world(t);
  await admin.deliver(letter('one'));
  assert.equal((await acceptForA('one')).accepted, true);
  const base = { reply_to: 'one', body: 'Done', outcome: 'completed' };
  for (const invalid of [{ subject: 1 }, { subject: '  ' }, { commit: 1 }, { test: { passed: true } },
    { attachments: '../bad' }, { attachments: ['../escape.md'] }, { attachments: [1] }]) {
    await assert.rejects(mail.reply('dsh', { ...base, ...invalid }, { caller: CHAT_A }), Error, JSON.stringify(invalid));
    const claim = (await store.read('dsh')).claims.one;
    assert.deepEqual([claim.status, claim.completion], ['accepted', undefined], 'nothing was written for ' + JSON.stringify(invalid));
  }
  assert.deepEqual(published(root), [], 'nothing was published');
  const done = await mail.reply('dsh', { ...base, subject: 'Reviewed', commit: 'abc1234' }, { caller: CHAT_A });
  assert.equal(done.ledger, 'done');
  assert.equal(fs.existsSync(path.join(root, 'agents/dsh/archive/one.json')), true);
  assert.deepEqual(published(root), ['one.result.json']);
});

test('R4: once the reply is published but archiving failed, only the identical reply finishes it; archive cannot replace it', async t => {
  const { root, store, acceptForA, admin, mail } = await world(t);
  await admin.deliver(letter('one'));
  assert.equal((await acceptForA('one')).accepted, true);
  const rename = fs.renameSync;
  let failNextArchive = true;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (failNextArchive && String(to).includes(`${path.sep}archive${path.sep}`)) {
      failNextArchive = false;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  const reply = { reply_to: 'one', body: 'Done', outcome: 'completed' };
  await assert.rejects(mail.reply('dsh', reply, { caller: CHAT_A }), error => error.code === 'REPLIED_ARCHIVE_PENDING'
    && /identical mailbox_reply/.test(error.message) && /mailbox_archive cannot replace it/.test(error.message));
  assert.equal((await store.read('dsh')).claims.one.status, 'completing');
  await assert.rejects(mail.archive('dsh', 'one', { caller: CHAT_A }), CONFLICT);
  assert.deepEqual(published(root), ['one.result.json'], 'the result was published once');
  const repaired = await mail.reply('dsh', reply, { caller: CHAT_A });
  assert.deepEqual([repaired.idempotent, repaired.ledger], [true, 'done']);
  assert.deepEqual(published(root), ['one.result.json'], 'and never duplicated');
  assert.equal(fs.existsSync(path.join(root, 'agents/dsh/inbox/one.json')), false, 'the original is archived');
});

/** codex bound to session-1 on host 'fake' (capacity 3): three letters delivered and accepted, one done; then a rotation. */
async function rotatedCodex(t, behavior, wrap = host => host) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const store = createSessionStore({ root });
  const host = createFakeHost({ root, behavior });
  const cwd = 'C:/work/project-a';
  host.seed('session-1', { identity: 'codex', generation: 1, cwd, authority: AUTHORITY });
  await bind(store, 'codex', { session: { host: 'fake', id: 'session-1', cwd }, mode: 'auto', capacity: 3, authority: AUTHORITY, source: 'user:explicit-bind' });
  for (const id of ['done-1', 'open-1', 'open-2']) {
    const envelope = letter(id, { from: 'dsh', to: 'codex' });
    await createMailbox({ root }).deliver(envelope);
    assert.equal((await dispatchLetter(store, 'codex', { id, digest: envelopeDigest(envelope) }, host)).claim.status, 'accepted');
  }
  await complete(store, 'codex', 'done-1', { generation: 1, session: 'session-1' });
  const rotation = createRotation({ store, host: wrap(host, store) });
  assert.equal((await rotation.beginIfDue('codex')).ok, true);
  assert.equal((await rotation.run('codex')).done, true);
  return { root, store, state: await store.read('codex') };
}

test('P1-1: a revocation barrier counts only for the exact letter set it was asked for', async t => {
  const { state } = await rotatedCodex(t, { revoke: 'stale' });
  assert.equal(state.rotations[1].revocation.proven, false, 'a cached barrier for another letter set proves nothing');
  for (const id of ['open-1', 'open-2']) assert.deepEqual([state.claims[id].status, state.claims[id].owner.session], ['needs_reconcile', 'session-1']);
});

test('P1-1: a barrier for a letter set that changed before the switch covers none of the letters accepted now', async t => {
  const { state } = await rotatedCodex(t, {}, (host, store) => ({ ...host, async revokeSession(id, expected) {
    const answer = await host.revokeSession(id, expected);
    await complete(store, 'codex', 'open-1', { generation: 1, session: 'session-1' }); // the old session finished one meanwhile
    return answer;
  } }));
  assert.deepEqual([state.rotations[1].revocation.proven, state.rotations[1].revocation.reason], [false, 'revocation_stale']);
  assert.deepEqual([state.claims['open-1'].status, state.claims['open-2'].status, state.claims['open-2'].owner.session], ['done', 'needs_reconcile', 'session-1']);
});

test('P0-2: after a rotation, a letter pinned to the old generation is closed only by that session, on the host it ran on', async t => {
  const { root, store } = await rotatedCodex(t, { revoke: 'refuse' });
  // Let the old generation have run on another host than the current binding, so the two cannot be confused.
  const file = path.join(root, 'runtime/sessions/codex.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.rotations['1'].from.host = 'old-host';
  fs.writeFileSync(file, JSON.stringify(saved));
  const mail = createMailbox({ root, identity: 'codex' });
  for (const caller of [{ host: 'fake', session: candidateSessionId('codex', 2, 1), cwd: 'C:/work/project-a' }, { host: 'fake', session: 'session-1', cwd: 'C:/work/project-a' }])
    await assert.rejects(mail.reply('codex', { reply_to: 'open-1', body: 'x' }, { caller }), { code: 'NOT_LETTER_OWNER' });
  const done = await mail.reply('codex', { reply_to: 'open-1', body: 'Done', outcome: 'completed' }, { caller: { host: 'old-host', session: 'session-1', cwd: 'C:/work/project-a' } });
  assert.equal(done.ledger, 'done');
  assert.equal((await store.read('codex')).claims['open-1'].status, 'done');
});

// Fifth round (codex R4 P1 on the host bridge): an owner is a chat IN A WORKSPACE. The same session id in another workspace
// is not the owner - for the current generation and for an earlier one - while the attested old owner still finishes its mail.
test('R5: the same session id in another workspace is not the owner of the current generation\'s letter', async t => {
  const { acceptForA, admin, mail } = await world(t);
  await admin.deliver(letter('one'));
  assert.equal((await acceptForA('one')).accepted, true);
  for (const action of [() => mail.take('dsh', 'one', { caller: { ...CHAT_A, cwd: 'C:/work/elsewhere' } }),
    () => mail.reply('dsh', { reply_to: 'one', body: 'x' }, { caller: { ...CHAT_A, cwd: 'C:/work/elsewhere' } }),
    () => mail.archive('dsh', 'one', { caller: { ...CHAT_A, cwd: 'C:/work/elsewhere' } })]) await assert.rejects(action(), { code: 'NOT_LETTER_OWNER' });
  await assert.rejects(mail.take('dsh', 'one', { caller: { host: 'local', session: 'chat-a' } }), { code: 'CALLER_UNVERIFIED' }, 'a proof without a workspace is incomplete');
  assert.equal((await mail.take('dsh', 'one', { caller: CHAT_A })).envelope.id, 'one');
});

test('R5: after a rotation the old owner finishes its letter only from its own workspace', async t => {
  const { root, store } = await rotatedCodex(t, { revoke: 'refuse' });
  const mail = createMailbox({ root, identity: 'codex' });
  const oldA = { host: 'fake', session: 'session-1', cwd: 'C:/work/project-a' };
  await assert.rejects(mail.reply('codex', { reply_to: 'open-1', body: 'x' }, { caller: { ...oldA, cwd: 'C:/work/elsewhere' } }), { code: 'NOT_LETTER_OWNER' });
  assert.equal((await mail.reply('codex', { reply_to: 'open-1', body: 'Done', outcome: 'completed' }, { caller: oldA })).ledger, 'done');
  assert.equal((await store.read('codex')).claims['open-1'].status, 'done');
});

test('P1-2: in automatic mode a result letter, which is never dispatched automatically, can still be read and archived by hand', async t => {
  const { admin, mail } = await world(t);
  await admin.deliver(letter('answer', { type: 'result', reply_to: 'question', outcome: 'completed' }));
  assert.equal((await mail.take('dsh', 'answer')).envelope.id, 'answer');
  assert.equal((await mail.archive('dsh', 'answer')).archived, 'answer');
});
