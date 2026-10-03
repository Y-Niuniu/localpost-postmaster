import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMailbox, envelopeDigest } from './mailbox.mjs';
import { createSessionStore, bind } from './session-binding.mjs';
import { switchMode } from './letter-claims.mjs';
import { auditState } from './rotation.mjs';
import { bindFromChatAction } from './binding-provider.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { createMcpServer } from './mcp-server.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

// The manual entry (mailbox read / reply / archive, i.e. the MCP tools) and the automatic receiver share one claim
// ledger: a letter has one owner at a time, and the loser of any race is told so instead of silently processing it.
const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/single-consumer');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CWD = 'C:/work/project-a';
const TARGET = { identity: 'dsh', hostId: 'local', threadId: 'chat-a', cwd: CWD, generation: 1 };
const letter = id => ({ id, thread_id: id, from: 'codex', to: 'dsh', type: 'task', subject: 'Analyze', body: 'Please analyze',
  budget: 'standard', created_at: '2026-10-03T00:00:00.000Z' });
const accept = (acceptance, id, wake = async () => {}) =>
  acceptance.acceptOnce({ key: `dsh:${id}`, target: TARGET, messageReference: { agent: 'dsh', id }, digest: envelopeDigest(letter(id)) }, wake);

async function setup(t, mode) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const store = createSessionStore({ root });
  if (mode === 'auto') {
    const host = createFakeDshHost({ root });
    host.openThread('chat-a', CWD);
    assert.equal((await bindFromChatAction(store, 'dsh', { host, action: host.userBindAction('chat-a'), authority: AUTHORITY })).ok, true);
  } else {
    assert.equal((await bind(store, 'dsh', { session: { host: 'local', id: 'chat-a', cwd: CWD }, mode: 'manual', authority: AUTHORITY, source: 'user:explicit-bind' })).ok, true);
  }
  const admin = createMailbox({ root });
  for (const id of ['one', 'two', 'three']) await admin.deliver(letter(id));
  return { root, store, mail: createMailbox({ root, identity: 'dsh' }), acceptance: createLedgerAcceptance({ store, identity: 'dsh' }) };
}

test('in manual mode the manual entry takes letters in the shared ledger and the automatic consumer is refused', async t => {
  const { store, mail, acceptance } = await setup(t, 'manual');
  assert.equal((await mail.take('dsh', 'one')).envelope.id, 'one');
  let claim = (await store.read('dsh')).claims.one;
  assert.deepEqual([claim.status, claim.owner.session], ['accepted', 'chat-a']);
  await assert.rejects(accept(acceptance, 'one'), { code: 'acceptance_refused', reason: 'mode_manual' });
  await assert.rejects(accept(acceptance, 'two'), { code: 'acceptance_refused', reason: 'mode_manual' });
  const replied = await mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' });
  assert.equal(replied.ledger, 'done');
  claim = (await store.read('dsh')).claims.one;
  assert.equal(claim.status, 'done');
  // Taking a letter again or replying again is idempotent for its owner.
  assert.equal((await mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' })).idempotent, true);
  // Archiving without a reply also closes the letter in the ledger.
  assert.equal((await mail.archive('dsh', 'two')).ledger, 'done');
  assert.deepEqual(auditState(await store.read('dsh')), []);
});

test('in automatic mode only a letter delivered to the bound session can be handled; anything else is refused explicitly', async t => {
  const { store, mail, acceptance } = await setup(t, 'auto');
  assert.equal((await accept(acceptance, 'one')).accepted, true);
  assert.equal((await mail.take('dsh', 'one')).envelope.id, 'one', 'the delivered letter is readable by its session');
  for (const action of [() => mail.take('dsh', 'two'), () => mail.reply('dsh', { reply_to: 'two', body: 'x' }), () => mail.archive('dsh', 'two')])
    await assert.rejects(action(), { code: 'CLAIMED_BY_AUTO' });
  assert.equal((await store.read('dsh')).claims.two, undefined, 'a refused manual attempt claims nothing');
  // The MCP tool goes through the same ledger.
  const server = createMcpServer({ root: store.root, identity: 'dsh' });
  const read = await server.handle({ id: 1, method: 'tools/call', params: { name: 'mailbox_read', arguments: { agent: 'dsh', id: 'two' } } });
  assert.equal(read.result.isError, true);
  assert.match(read.result.content[0].text, /automatic consumer/);
  assert.equal((await mail.reply('dsh', { reply_to: 'one', body: 'Done', outcome: 'completed' })).ledger, 'done');
  assert.equal((await accept(acceptance, 'two')).accepted, true, 'the automatic consumer still gets the letters that were refused manually');
});

test('a manual and an automatic consumer racing for the same letters leave exactly one owner each time', async t => {
  for (const mode of ['manual', 'auto']) await t.test(mode, async t => {
    const { store, mail, acceptance } = await setup(t, mode);
    const wakes = [];
    const outcomes = await Promise.allSettled(['one', 'two', 'three'].flatMap(id =>
      [mail.take('dsh', id), accept(acceptance, id, async () => { wakes.push(id); })]));
    const state = await store.read('dsh');
    for (const id of ['one', 'two', 'three']) {
      // A letter nobody won stays unclaimed and is picked up by the next scan; none is ever taken twice.
      const claim = state.claims[id];
      if (claim) assert.equal(claim.history.filter(entry => entry.status === 'accepted').length, 1, `${id} was taken once`);
      if (claim) assert.equal(claim.owner.session, 'chat-a');
    }
    assert.equal(new Set(wakes).size, wakes.length, 'no letter woke the session twice');
    // Every loser is told explicitly: refused by the ledger, owned by the automatic consumer, or another actor was busy.
    const refused = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason.code);
    assert.ok(refused.every(code => ['acceptance_refused', 'CLAIMED_BY_AUTO', 'acceptance_busy'].includes(code)), refused.join(','));
    if (mode === 'manual') {
      assert.deepEqual(wakes, [], 'the automatic consumer never wins in manual mode');
      for (const id of ['one', 'two', 'three']) assert.equal(state.claims[id].status, 'accepted', 'the manual entry took every letter');
    }
    assert.deepEqual(auditState(state), []);
  });
});

test('switching modes goes through freeze, drain and CAS: afterwards the old mode is refused', async t => {
  const { store, mail, acceptance } = await setup(t, 'manual');
  await mail.take('dsh', 'one');
  assert.equal((await switchMode(store, 'dsh', 'auto')).ok, true);
  await assert.rejects(mail.take('dsh', 'two'), { code: 'CLAIMED_BY_AUTO' });
  assert.equal((await mail.take('dsh', 'one')).envelope.id, 'one', 'a letter the manual session already holds stays its own');
  assert.equal((await accept(acceptance, 'two')).accepted, true);
  // 'one' is already in this very session's hands (taken manually): the automatic path recognises it and does not wake it.
  let woke = false;
  const again = await accept(acceptance, 'one', async () => { woke = true; });
  assert.deepEqual([again.deduplicated, woke], [true, false]);
});
