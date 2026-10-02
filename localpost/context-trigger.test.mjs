import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSessionStore, bind } from './session-binding.mjs';
import { createContextTrigger, sampleIn, compactionIn } from './context-trigger.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/context-trigger');
const FULL = { turnIds: true, usage: true, compaction: true };
async function setup(t, capabilities = FULL) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const store = createSessionStore({ root });
  await bind(store, 'codex', { session: { host: 'fake', id: 'session-1' }, mode: 'auto', capacity: 50,
    authority: { scope: 'analysis-reply', source: 'policy:test' }, source: 'user:explicit-bind' });
  return { store, trigger: createContextTrigger({ store, capabilities }) };
}
const turn = (number, ratio, session = 'session-1') => ({ session, turn: number, used: Math.round(ratio * 200000), window: 200000 });
const decision = result => [result.action, result.reason];

test('without a stable turn id or a trusted usage figure the 60% trigger stays off', async t => {
  for (const capabilities of [{ usage: true, compaction: true }, { turnIds: true, compaction: true }, { turnIds: 1, usage: 'yes' }, null]) {
    const { store, trigger } = await setup(t, capabilities);
    assert.equal(trigger.enabled, false);
    const { revision } = await store.read('codex');
    for (let number = 1; number <= 5; number++)
      assert.deepEqual(await trigger.sample('codex', turn(number, 0.99)), { action: 'none', reason: 'telemetry_unavailable' });
    assert.equal((await store.read('codex')).revision, revision, 'nothing is recorded while the trigger is off');
  }
});

test('the first independent turn over 60% compacts once; repeated samples of one turn count once', async t => {
  const { store, trigger } = await setup(t);
  assert.deepEqual(decision(await trigger.sample('codex', turn(1, 0.6))), ['none', 'below_threshold'], 'exactly 60% is not over');
  assert.deepEqual(decision(await trigger.sample('codex', turn(2, 0.61))), ['compact', 'first_turn_over_threshold']);
  const { revision } = await store.read('codex');
  for (let i = 0; i < 10; i++) assert.deepEqual(decision(await trigger.sample('codex', turn(2, 0.95))), ['none', 'duplicate_turn']);
  assert.deepEqual(decision(await trigger.sample('codex', turn(1, 0.95))), ['none', 'duplicate_turn'], 'an older turn is not independent');
  assert.equal((await store.read('codex')).revision, revision, 'duplicates change nothing');
  assert.deepEqual(decision(await trigger.sample('codex', turn(3, 0.95))), ['none', 'compaction_pending']);
});

test('after a successful compaction the next turn still over rotates, and so does a later return over the line', async t => {
  const still = await setup(t);
  await still.trigger.sample('codex', turn(1, 0.7));
  assert.deepEqual(decision(await still.trigger.compaction('codex', { session: 'session-1', ok: true })), ['none', 'compacted']);
  assert.deepEqual(decision(await still.trigger.sample('codex', turn(2, 0.65))), ['rotate', 'over_threshold_after_compaction']);

  const later = await setup(t);
  await later.trigger.sample('codex', turn(1, 0.7));
  await later.trigger.compaction('codex', { session: 'session-1', ok: true });
  assert.equal((await later.trigger.sample('codex', turn(2, 0.3))).action, 'none');
  assert.equal((await later.trigger.sample('codex', turn(3, 0.55))).action, 'none');
  assert.deepEqual(decision(await later.trigger.sample('codex', turn(4, 0.62))), ['rotate', 'over_threshold_after_compaction'], 'never a second compaction');
});

test('a failed compaction rotates directly, and without compaction support the first turn over rotates', async t => {
  const { trigger } = await setup(t);
  await trigger.sample('codex', turn(1, 0.8));
  assert.deepEqual(decision(await trigger.compaction('codex', { session: 'session-1', ok: false })), ['rotate', 'compaction_failed']);
  assert.equal((await trigger.sample('codex', turn(2, 0.9))).action, 'rotate');
  const unsupported = await setup(t, { turnIds: true, usage: true, compaction: false });
  assert.deepEqual(decision(await unsupported.trigger.sample('codex', turn(1, 0.61))), ['rotate', 'compaction_unsupported']);
});

test('samples from another session, malformed figures and stray compaction reports are ignored', async t => {
  const { store, trigger } = await setup(t);
  const { revision } = await store.read('codex');
  assert.deepEqual(decision(await trigger.sample('codex', turn(1, 0.9, 'other-session'))), ['none', 'stale_session']);
  for (const bad of [{ turn: 0 }, { turn: 1.5 }, { turn: '2' }, { used: -1 }, { used: NaN }, { window: 0 }])
    assert.deepEqual(decision(await trigger.sample('codex', { ...turn(1, 0.9), ...bad })), ['none', 'invalid_sample']);
  assert.deepEqual(decision(await trigger.compaction('codex', { session: 'session-1', ok: true })), ['none', 'no_compaction_pending']);
  assert.equal((await store.read('codex')).revision, revision);
});

test('a new generation starts with a fresh context record', () => {
  const state = { binding: { generation: 1, state: 'active', session: { host: 'fake', id: 's1' } }, context: null };
  assert.equal(sampleIn(state, turn(5, 0.9, 's1'), { capabilities: FULL }).action, 'compact');
  compactionIn(state, { session: 's1', ok: true });
  assert.equal(sampleIn(state, turn(6, 0.9, 's1'), { capabilities: FULL }).action, 'rotate');
  state.binding = { generation: 2, state: 'active', session: { host: 'fake', id: 's2' } };
  assert.deepEqual(decision(sampleIn(state, turn(1, 0.9, 's2'), { capabilities: FULL })), ['compact', 'first_turn_over_threshold']);
  assert.deepEqual(decision(sampleIn(state, turn(7, 0.9, 's1'), { capabilities: FULL })), ['none', 'stale_session']);
});
