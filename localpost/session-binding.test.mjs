import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSessionStore, bind, STATE_SCHEMA } from './session-binding.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/session-binding');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const request = (extra = {}) => ({ session: { host: 'fake', id: 'session-1' }, mode: 'auto', capacity: 50, authority: AUTHORITY, source: 'user:explicit-bind', ...extra });
function fixture(t) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  return { root, store: createSessionStore({ root }) };
}

test('a binding is explicit, repeatable only verbatim, and never silently replaced', async t => {
  const { store } = fixture(t);
  assert.equal(await store.read('codex'), null);
  assert.deepEqual(await store.update('codex', () => assert.fail('an unbound identity has nothing to update')), { ok: false, reason: 'unbound' });
  const first = await bind(store, 'codex', request());
  assert.equal(first.ok, true);
  assert.deepEqual([first.binding.generation, first.binding.version, first.binding.state], [1, 1, 'active']);
  assert.equal((await bind(store, 'codex', request())).existing, true);
  for (const change of [{ session: { host: 'fake', id: 'session-2' } }, { mode: 'manual' }, { capacity: 40 }])
    assert.equal((await bind(store, 'codex', request(change))).reason, 'already_bound');
  assert.equal((await store.read('codex')).binding.session.id, 'session-1');
});

test('a binding cannot carry implementation authority or an unnamed session', async t => {
  const { store } = fixture(t);
  await assert.rejects(bind(store, 'codex', request({ authority: { scope: 'implementation', source: 'handoff' } })), /authority/);
  await assert.rejects(bind(store, 'codex', request({ session: { host: 'fake' } })), /session/);
  await assert.rejects(bind(store, 'codex', request({ source: ' ' })), /who made it/);
  await assert.rejects(bind(store, '../codex', request()), /Invalid LocalPost identifier/);
  assert.equal(await store.read('codex'), null);
});

test('read-modify-write is serialized across independent store instances', async t => {
  const { root, store } = fixture(t);
  await bind(store, 'codex', request());
  const other = createSessionStore({ root });
  await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? store : other).update('codex', state => { state.binding.capacity += 1; })));
  const state = await store.read('codex');
  assert.equal(state.binding.capacity, 66, 'no update was lost');
  assert.equal(state.revision, 17);
});

test('a corrupt or foreign state document fails closed and is never overwritten', async t => {
  const { root, store } = fixture(t);
  await bind(store, 'codex', request());
  const file = path.join(root, 'runtime/sessions/codex.json');
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  const broken = [
    '{"schema":',
    JSON.stringify({ ...good, identity: 'dsh' }),
    JSON.stringify({ ...good, schema: `${STATE_SCHEMA}-next` }),
    JSON.stringify({ ...good, binding: { ...good.binding, authority: { scope: 'implementation', source: 'notes' } } }),
    JSON.stringify({ ...good, claims: { x: { letter: 'x', status: 'stolen' } } }),
  ];
  for (const text of broken) {
    fs.writeFileSync(file, text);
    await assert.rejects(store.update('codex', state => { state.binding.capacity = 1; }), { code: 'STATE_NEEDS_RECONCILE' });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('a state lock caught mid-release is retried within a bound; an unknown owner is reported, never stolen', async t => {
  const { root, store } = fixture(t);
  await bind(store, 'codex', request());
  const lock = path.join(root, '.session-codex.lock');
  // A transient realpath refusal (Windows refuses to resolve an entry while a holder is
    // releasing it) must not escape as a hard error: the store retries within a bound instead.
    // Injected on the root path, which is always resolved, so the contract stays covered.
  fs.writeFileSync(lock, JSON.stringify({ token: 'releasing', pid: process.pid, started_at: Date.now() }));
  const realpath = fs.realpathSync.native;
  let refusals = 3;
  t.mock.method(fs.realpathSync, 'native', (target, ...rest) => {
    if (refusals > 0 && path.resolve(String(target)) === path.resolve(root)) { refusals--; throw Object.assign(new Error('EPERM: operation not permitted, realpath'), { code: 'EPERM' }); }
    return realpath(target, ...rest);
  });
  setTimeout(() => fs.unlinkSync(lock), 80);
  await store.update('codex', state => { state.binding.capacity = 7; });
  assert.equal(refusals, 0);
  assert.equal((await store.read('codex')).binding.capacity, 7);
  fs.writeFileSync(lock, '{bad');
  await assert.rejects(createSessionStore({ root, waitMs: 100 }).update('codex', state => { state.binding.capacity = 1; }),
    error => error.code === 'LOCK_UNAVAILABLE' && /invalid_owner_needs_reconcile/.test(error.message));
  assert.equal(fs.readFileSync(lock, 'utf8'), '{bad');
  assert.equal((await store.read('codex')).binding.capacity, 7);
});

test('the actor lease admits one host-facing actor; a dead actor is reclaimed only once stale', async t => {
  const { root, store } = fixture(t);
  await bind(store, 'codex', request());
  let inside = 0, peak = 0;
  const actor = () => store.withActor('codex', async () => {
    inside++; peak = Math.max(peak, inside);
    await new Promise(resolve => setTimeout(resolve, 25));
    inside--;
    return { ok: true };
  });
  const results = await Promise.all([actor(), actor(), actor()]);
  assert.equal(peak, 1);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.ok(results.filter(x => !x.ok).every(x => x.skipped && x.reason === 'actor_busy'));
  const lease = path.join(root, '.session-actor-codex.lock');
  fs.writeFileSync(lease, JSON.stringify({ token: 'dead', pid: 2147483647, started_at: Date.now() - 1000 }));
  assert.equal((await store.withActor('codex', async () => ({ ok: true }))).reason, 'actor_busy', 'not stale yet under the default window');
  assert.equal((await createSessionStore({ root, staleMs: 500 }).withActor('codex', async () => ({ ok: true }))).ok, true);
  assert.equal(fs.existsSync(lease), false);
});
