import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReceiver } from './receiver.mjs';
import { createMailbox } from './mailbox.mjs';
import { acquireLease } from './fs-safe.mjs';
import { createSessionStore } from './session-binding.mjs';
import { bindFromChatAction } from './binding-provider.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

/*
 * A receiver reports running only once its baseline exists (2026-10-12). Its first scan records the baseline - the
 * letters already in the inbox, which stay historical - under the publication lease. Two identities starting at the
 * same moment (the host's retryAutoStart poll starts every lane at once) contend for that lease. The first scan that
 * lost it used to be skipped while start() returned anyway, so a later scan took the baseline and counted every letter
 * delivered in between into it: historical, never dispatched.
 */
const TMP = path.resolve(import.meta.dirname, '../.localpost-tmp/receiver-baseline');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CHATS = { dsh: 'chat-a', engineer: 'chat-e' };
const letter = (id, to) => ({ id, thread_id: id, from: 'codex', to, type: 'task', subject: 'test', body: 'Analyze only',
  budget: 'standard', created_at: new Date().toISOString() });
// Bound at delivery, so a verified runtime would be handed this letter; without one it waits in the queue.
const NEW_MAIL = ['queued', 'runtime_capabilities_unverified'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// No watcher, and the interval is an hour: a scan runs only when a test asks for one, so the test decides the order.
const quiet = () => ({ on() { return this; }, close() {} });

/** One root on which dsh and engineer are each bound to a chat of their own, with an unstarted receiver per identity. */
async function twoIdentities(t, extra = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP, 'case-'));
  t.after(() => removeTreeSync(root));
  const host = createFakeDshHost({ root });
  const receivers = {};
  for (const [identity, chat] of Object.entries(CHATS)) {
    host.openThread(chat, 'C:/work/' + chat);
    assert.equal((await bindFromChatAction(createSessionStore({ root }), identity, { host, action: host.userBindAction(chat), authority: AUTHORITY })).ok, true);
    const receiver = createReceiver({ root, agent: identity, allowFrom: ['codex'], scanIntervalMs: 3600000, watch: quiet, ...extra });
    // Safety net only: a receiver whose timers survived must not keep the test process alive.
    t.after(() => receiver.stop().catch(() => {}));
    receivers[identity] = receiver;
  }
  return { root, receivers, mail: createMailbox({ root }) };
}

/** Delivers one letter to each identity, then has each receiver scan once; returns each letter's [state, reason]. */
async function deliverAndScan({ receivers, mail }) {
  for (const identity of Object.keys(receivers)) await mail.deliver(letter('task-' + identity, identity));
  const states = {};
  for (const [identity, receiver] of Object.entries(receivers)) {
    const entry = (await receiver.scan()).entries['task-' + identity];
    states[identity] = [entry.state, entry.reason];
  }
  return states;
}

test('two identities starting at the same moment on one root: mail delivered once both report running is new, not historical', async t => {
  const world = await twoIdentities(t);
  await Promise.all(Object.values(world.receivers).map(receiver => receiver.start()));
  assert.deepEqual(await deliverAndScan(world), { dsh: NEW_MAIL, engineer: NEW_MAIL });
});

test('a first scan that finds the publication lease taken waits for it: start() returns only once the baseline exists', async t => {
  const world = await twoIdentities(t);
  // Taken as it is while a letter is being delivered or another identity records its baseline.
  const held = await acquireLease(world.root, { name: '.mailbox-write.lock' });
  assert.equal(held.acquired, true);
  let returned = false;
  const starting = Promise.all(Object.values(world.receivers).map(receiver => receiver.start())).then(() => { returned = true; });
  await wait(100);
  assert.equal(returned, false, 'no start() returned while its baseline could not be recorded');
  await held.release();
  await starting;
  for (const receiver of Object.values(world.receivers)) assert.deepEqual((await receiver.snapshot()).historicalIds, [], 'baseline recorded on the empty inbox');
  assert.deepEqual(await deliverAndScan(world), { dsh: NEW_MAIL, engineer: NEW_MAIL });
});

test('a publication lease still taken past the bound fails start() instead of running without a baseline', async t => {
  const world = await twoIdentities(t, { baselineWaitMs: 50 });
  const held = await acquireLease(world.root, { name: '.mailbox-write.lock' });
  const { dsh } = world.receivers;
  await assert.rejects(dsh.start(), { message: 'Receiver baseline not recorded: busy' });
  assert.equal(await dsh.snapshot(), null, 'no baseline was written');
  // Its owner stops a failed start (dsh-wiring does); once the lease is free, the next start records the baseline.
  await dsh.stop();
  await held.release();
  await dsh.start();
  assert.deepEqual((await dsh.snapshot()).historicalIds, []);
});
