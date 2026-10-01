import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAdapter } from './dsh-adapter.mjs';

test('a live agent is not evidence of trusted focus or durable acceptance', async () => {
  let deliveries = 0;
  const adapter = createDshAdapter({
    runtimeVersion: '0.2.0-rc.2',
    ctx: { agents: { get: () => ({ followup: () => deliveries++ }) } },
  });
  assert.equal(adapter.capabilities.wholeTurn, true);
  assert.equal(adapter.capabilities.trustedFocus, false);
  assert.equal(adapter.capabilities.dispatchIdempotent, false);
  await assert.rejects(adapter.submit({}), { code: 'runtime_capabilities_unverified' });
  assert.equal(deliveries, 0);
});

const targetA = { threadId: 'chat-a', hostId: 'local', cwd: 'C:/AI_ASSIST/work/localpost-codex', focusRevision: 1 };
const request = (extra = {}) => ({
  target: targetA, idempotencyKey: 'dsh:letter-a',
  source: { kind: 'plugin', plugin: 'localpost', form: 'relay' },
  scope: 'analysis-reply', after: 'whole-turn',
  messageReference: { agent: 'dsh', id: 'letter-a' }, ...extra,
});

function fakeHost({ version = '0.2.0-rc.2' } = {}) {
  const delivered = [];
  const agents = new Map([['chat-a', { followup: message => delivered.push(message) }]]);
  const records = new Map();
  const focusProvider = {
    trusted: true,
    capture: () => ({ ...targetA, threadId: 'chat-b', focusRevision: 2 }),
    verifyBinding: target => target.threadId === 'chat-a' && target.focusRevision === 1,
  };
  const acceptance = {
    durable: true, idempotent: true,
    async acceptOnce({ key }, enqueue) {
      if (records.has(key)) return records.get(key);
      await enqueue();
      const record = { accepted: true, durable: true, receipt: 'fake-receipt-a' };
      records.set(key, record);
      return record;
    },
  };
  const adapter = createDshAdapter({ ctx: { agents: { get: id => agents.get(id) } }, runtimeVersion: version, focusProvider, acceptance });
  return { adapter, agents, delivered, acceptance, focusProvider };
}

test('fake host contracts keep arrival binding A and submit plugin relay after a whole turn', async () => {
  const { adapter, delivered } = fakeHost();
  assert.equal((await adapter.captureFocus()).threadId, 'chat-b');
  const receipt = await adapter.submit(request());
  assert.deepEqual(receipt, { accepted: true, durable: true, receipt: 'fake-receipt-a' });
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].source, { kind: 'plugin', plugin: 'localpost', form: 'relay' });
  assert.match(delivered[0].content[0].text, /analysis-reply/);
  assert.match(delivered[0].content[0].text, /letter-a/);
  assert.match(delivered[0].content[0].text, /untrusted/);
});

test('the host acceptance contract deduplicates a repeated mail key', async () => {
  const { adapter, delivered } = fakeHost();
  const first = await adapter.submit(request());
  const second = await adapter.submit(request());
  assert.deepEqual(second, first);
  assert.equal(delivered.length, 1);
});

test('a cold target stays unavailable and is never resumed or replaced', async () => {
  const { adapter, agents, delivered } = fakeHost();
  agents.delete('chat-a');
  assert.equal(await adapter.isRunning(targetA), false);
  await assert.rejects(adapter.submit(request()), { code: 'client_unavailable' });
  assert.equal(delivered.length, 0);
});

test('an unverified arrival binding rejects before host acceptance', async () => {
  const { adapter, delivered, focusProvider, acceptance } = fakeHost();
  focusProvider.verifyBinding = () => false;
  acceptance.acceptOnce = () => { throw new Error('acceptance must not run'); };
  await assert.rejects(adapter.submit(request()), { code: 'focus_binding_unverified' });
  assert.equal(delivered.length, 0);
});

test('changed policy cannot turn agent mail into user input or next-step steering', async () => {
  const { adapter, delivered } = fakeHost();
  await assert.rejects(adapter.submit(request({ source: { kind: 'user' } })), { code: 'delivery_policy_invalid' });
  await assert.rejects(adapter.submit(request({ scope: 'implementation' })), { code: 'delivery_policy_invalid' });
  await assert.rejects(adapter.submit(request({ after: 'next-step' })), { code: 'delivery_policy_invalid' });
  assert.equal(delivered.length, 0);
});

test('native undefined followup does not prove durable acceptance', async () => {
  const { adapter, acceptance, delivered } = fakeHost();
  acceptance.acceptOnce = async (_, enqueue) => { await enqueue(); return { accepted: true }; };
  await assert.rejects(adapter.submit(request()), { code: 'acceptance_unconfirmed' });
  assert.equal(delivered.length, 1);
});

test('an unsupported DSH version cannot enable automatic dispatch', async () => {
  const { adapter, delivered } = fakeHost({ version: '0.2.0-rc.5' });
  assert.equal(adapter.capabilities.wholeTurn, false);
  await assert.rejects(adapter.submit(request()), { code: 'runtime_capabilities_unverified' });
  assert.equal(delivered.length, 0);
});

test('a host acceptance provider cannot dispatch the same callback twice', async () => {
  const { adapter, acceptance, delivered } = fakeHost();
  acceptance.acceptOnce = async (_, enqueue) => { await enqueue(); await enqueue(); };
  await assert.rejects(adapter.submit(request()), { code: 'acceptance_contract_invalid' });
  assert.equal(delivered.length, 1);
});

test('mail references must stay in the configured recipient mailbox', async () => {
  const { adapter, delivered } = fakeHost();
  await assert.rejects(adapter.submit(request({ messageReference: { agent: 'codex', id: 'letter-a' } })), { code: 'delivery_reference_invalid' });
  assert.equal(delivered.length, 0);
});
