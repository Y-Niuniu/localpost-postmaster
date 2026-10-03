import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSessionStore } from './session-binding.mjs';
import { switchMode } from './letter-claims.mjs';
import { auditState } from './rotation.mjs';
import { bindFromChatAction } from './binding-provider.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { envelopeDigest } from './mailbox.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/ledger-acceptance');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CWD = 'C:/work/project-a';
const TARGET = { identity: 'dsh', hostId: 'local', threadId: 'chat-a', cwd: CWD, generation: 1 };
const digestOf = id => envelopeDigest({ id, thread_id: id, from: 'codex', to: 'dsh', type: 'task', subject: 'Analyze', body: 'Please analyze',
  budget: 'standard', created_at: '2026-10-03T00:00:00.000Z' });
const request = (id, target = TARGET) => ({ key: `dsh:${id}`, target, messageReference: { agent: 'dsh', id }, digest: digestOf(id) });

async function setup(t) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const host = createFakeDshHost({ root });
  host.openThread('chat-a', CWD);
  const store = createSessionStore({ root });
  assert.equal((await bindFromChatAction(store, 'dsh', { host, action: host.userBindAction('chat-a'), capacity: 50, authority: AUTHORITY })).ok, true);
  return { root, store, acceptance: createLedgerAcceptance({ store, identity: 'dsh' }) };
}
const counter = () => { const wake = async () => { wake.calls += 1; }; wake.calls = 0; return wake; };

test('the normal path wakes the bound session exactly once and returns a durable receipt', async t => {
  const { store, acceptance } = await setup(t);
  const wake = counter();
  const receipt = await acceptance.acceptOnce(request('task-1'), wake);
  assert.deepEqual(receipt, { accepted: true, durable: true, receipt: 'ledger:dsh:task-1:g1' });
  assert.equal(wake.calls, 1);
  const claim = (await store.read('dsh')).claims['task-1'];
  assert.deepEqual([claim.status, claim.owner.generation, claim.owner.session, claim.attempts], ['accepted', 1, 'chat-a', 1]);
  assert.deepEqual(claim.history.map(x => x.status), ['reserved', 'dispatching', 'accepted'], 'written ahead before the host was touched');
});

test('a repeated key is deduplicated, also by a fresh process with a fresh store', async t => {
  const { root, acceptance } = await setup(t);
  const wake = counter();
  await acceptance.acceptOnce(request('task-1'), wake);
  const again = await acceptance.acceptOnce(request('task-1'), wake);
  const restarted = await createLedgerAcceptance({ store: createSessionStore({ root }), identity: 'dsh' }).acceptOnce(request('task-1'), wake);
  assert.equal(wake.calls, 1, 'one wake-up in total');
  for (const result of [again, restarted]) assert.deepEqual(result, { accepted: true, durable: true, receipt: 'ledger:dsh:task-1:g1', deduplicated: true });
});

test('a lost confirmation is uncertain: never retried, never claimed as delivered', async t => {
  const { store, acceptance } = await setup(t);
  let calls = 0;
  await assert.rejects(acceptance.acceptOnce(request('task-1'), async () => { calls += 1; throw new Error('the reply was lost'); }), { code: 'acceptance_uncertain' });
  await assert.rejects(acceptance.acceptOnce(request('task-1'), async () => { calls += 1; }), { code: 'acceptance_uncertain' });
  assert.equal(calls, 1, 'at most one wake-up');
  const claim = (await store.read('dsh')).claims['task-1'];
  assert.deepEqual([claim.status, claim.reason], ['needs_reconcile', 'dispatch_uncertain']);
  // Other mail keeps flowing.
  assert.equal((await acceptance.acceptOnce(request('task-2'), counter())).accepted, true);
});

test('a client that is not live is a definitive failure: nothing was sent and the letter can be offered again', async t => {
  const { store, acceptance } = await setup(t);
  const unavailable = Object.assign(new Error('not live'), { code: 'client_unavailable' });
  await assert.rejects(acceptance.acceptOnce(request('task-1'), async () => { throw unavailable; }), { code: 'client_unavailable' });
  assert.equal((await store.read('dsh')).claims['task-1'].status, 'released');
  const wake = counter();
  assert.equal((await acceptance.acceptOnce(request('task-1'), wake)).accepted, true);
  assert.equal(wake.calls, 1);
});

test('a target that is not the ledger owner is refused before anything is sent', async t => {
  const { store, acceptance } = await setup(t);
  for (const target of [{ ...TARGET, threadId: 'chat-b' }, { ...TARGET, generation: 2 }, { ...TARGET, cwd: 'C:/work/other' }, { ...TARGET, hostId: 'other' }]) {
    const wake = counter();
    await assert.rejects(acceptance.acceptOnce(request('task-1', target), wake), { code: 'binding_changed' });
    assert.equal(wake.calls, 0);
  }
  assert.equal((await store.read('dsh')).claims['task-1'].status, 'released', 'not left reserved for a wrong target');
});

test('the contract is exact: key, recipient and digest must name this letter; manual mode refuses', async t => {
  const { store, acceptance } = await setup(t);
  const wake = counter();
  await assert.rejects(acceptance.acceptOnce({ ...request('task-1'), key: 'dsh:task-2' }, wake), { code: 'acceptance_contract_invalid' });
  await assert.rejects(acceptance.acceptOnce({ ...request('task-1'), messageReference: { agent: 'codex', id: 'task-1' } }, wake), { code: 'acceptance_contract_invalid' });
  await acceptance.acceptOnce(request('task-1'), wake);
  await assert.rejects(acceptance.acceptOnce({ ...request('task-1'), digest: digestOf('other') }, wake), { code: 'acceptance_refused', reason: 'digest_conflict' });
  assert.equal((await switchMode(store, 'dsh', 'manual')).ok, true);
  await assert.rejects(acceptance.acceptOnce(request('task-3'), wake), { code: 'acceptance_refused', reason: 'mode_manual' });
  assert.equal(wake.calls, 1);
});

async function crashChild(t, root, point, id) {
  const barrier = path.join(root, `crash-${randomUUID()}.barrier`);
  // 以落盘 fixture 启动，不用 node -e（本机规则禁止内联脚本）。
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'acceptance-crash.mjs')], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LP_ROOT: root, LP_IDENTITY: 'dsh', LP_CRASH: point,
      LP_BARRIER: barrier, LP_LETTER: JSON.stringify({ id, digest: digestOf(id) }), LP_TARGET: JSON.stringify(TARGET) } });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const closed = new Promise(resolve => child.on('close', resolve));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(barrier)) {
    assert.ok(Date.now() < deadline && child.exitCode === null, `child never reached ${point} (exit ${child.exitCode}): ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill();
  await closed;
}

test('a process killed at either persisted stage is isolated after restart and never wakes the session twice', { timeout: 60000 }, async t => {
  for (const point of ['claim:dispatching', 'host:enqueued']) await t.test(point, async t => {
    const { root } = await setup(t);
    await crashChild(t, root, point, 'crashy');
    const enqueued = () => (fs.existsSync(path.join(root, 'enqueued.log')) ? fs.readFileSync(path.join(root, 'enqueued.log'), 'utf8').split('\n').filter(Boolean) : []);
    const before = enqueued().length;
    assert.equal(before, point === 'host:enqueued' ? 1 : 0);
    // The dead child's leases are reclaimed by the restarted actor; the actor skips (never waits) while one still looks busy.
    const store = createSessionStore({ root, staleMs: 1 });
    const acceptance = createLedgerAcceptance({ store, identity: 'dsh' });
    let outcome;
    for (let i = 0; i < 40; i++) {
      try { await acceptance.acceptOnce(request('crashy'), async () => { fs.appendFileSync(path.join(root, 'enqueued.log'), 'crashy\n'); }); outcome = 'accepted'; }
      catch (error) { outcome = error.code; }
      if (outcome !== 'acceptance_busy') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(outcome, 'acceptance_uncertain');
    assert.equal(enqueued().length, before, 'no second wake-up after the restart');
    const state = await store.read('dsh');
    assert.deepEqual([state.claims.crashy.status, state.claims.crashy.reason], ['needs_reconcile', 'dispatch_interrupted']);
    assert.equal((await acceptance.acceptOnce(request('next'), async () => {})).accepted, true, 'other mail keeps flowing');
    assert.deepEqual(auditState(await store.read('dsh')), []);
  });
});
