import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDshAdapter } from './dsh-adapter.mjs';
import { createSessionStore } from './session-binding.mjs';
import { createBindingProvider, bindFromChatAction } from './binding-provider.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { envelopeDigest } from './mailbox.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

// Contract tests only: the host is faked, every LocalPost provider is the real one. Nothing here marks a provider
// trusted by hand; trust comes only from the host capability the installed DSH rc.2 does not have.
const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/dsh-adapter');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CWD_A = 'C:/work/project-a';
const digest = envelopeDigest({ id: 'letter-a', thread_id: 't', from: 'codex', to: 'dsh', type: 'task', subject: 's', body: 'b',
  budget: 'standard', created_at: '2026-10-03T00:00:00.000Z' });

async function setup(t, { capabilities, version = '0.2.0-rc.2', bound = true } = {}) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const host = createFakeDshHost({ root, ...(capabilities ? { capabilities } : {}) });
  host.openThread('chat-a', CWD_A);
  host.openThread('chat-b', 'C:/work/project-b');
  const store = createSessionStore({ root });
  if (bound) assert.equal((await bindFromChatAction(store, 'dsh', { host, action: host.userBindAction('chat-a'), authority: AUTHORITY })).ok, true);
  const make = () => createDshAdapter({ ctx: host.ctx, runtimeVersion: version,
    bindingProvider: createBindingProvider({ store: createSessionStore({ root }), identity: 'dsh', host }),
    acceptance: createLedgerAcceptance({ store: createSessionStore({ root }), identity: 'dsh' }) });
  return { root, host, store, make, adapter: make() };
}
const request = (route, extra = {}) => ({
  route, digest, idempotencyKey: 'dsh:letter-a', source: { kind: 'plugin', plugin: 'localpost', form: 'relay' },
  scope: 'analysis-reply', after: 'whole-turn', messageReference: { agent: 'dsh', id: 'letter-a' }, ...extra,
});

test('without the host binding capability a live agent enables nothing', async t => {
  const { adapter, host } = await setup(t, { capabilities: {}, bound: false });
  assert.equal(adapter.capabilities.wholeTurn, true);
  assert.equal(adapter.capabilities.trustedBinding, false);
  assert.ok(adapter.diagnostics().reasons.includes('trustedBinding'));
  assert.equal(adapter.diagnostics().dispatchEnabled, false);
  await assert.rejects(adapter.captureBinding(), { code: 'binding_unverified' });
  await assert.rejects(adapter.submit({}), { code: 'runtime_capabilities_unverified' });
  assert.equal(host.followups().length, 0);
});

test('the arrival route A is kept and the mail goes as a plugin relay after a whole turn', async t => {
  const { adapter, host } = await setup(t);
  assert.equal(adapter.diagnostics().dispatchEnabled, true);
  const route = await adapter.captureBinding();
  assert.deepEqual([route.threadId, route.cwd, route.generation], ['chat-a', CWD_A, 1]);
  const receipt = await adapter.submit(request(route));
  assert.deepEqual(receipt, { accepted: true, durable: true, receipt: 'ledger:dsh:letter-a:g1' });
  const [delivered] = host.followups();
  assert.equal(host.followups().length, 1);
  assert.equal(delivered.threadId, 'chat-a');
  assert.deepEqual(delivered.source, { kind: 'plugin', plugin: 'localpost', form: 'relay' });
  for (const pattern of [/analysis-reply/, /letter-a/, /untrusted/]) assert.match(delivered.text, pattern);
});

test('the same mail key wakes the chat once, also through a restarted adapter', async t => {
  const { adapter, make, host } = await setup(t);
  const route = await adapter.captureBinding();
  await adapter.submit(request(route));
  const again = await make().submit(request(route));
  assert.equal(again.deduplicated, true);
  assert.equal(host.followups().length, 1);
});

test('an offline bound chat stays unavailable and is never resumed, created or replaced', async t => {
  const { adapter, host } = await setup(t);
  const route = await adapter.captureBinding();
  host.setOnline('chat-a', false);
  await assert.rejects(adapter.submit(request(route)), { code: 'binding_unverified' });
  assert.equal(host.followups().length, 0);
  assert.deepEqual(Object.keys(host.state().threads), ['chat-a', 'chat-b']);
  host.setOnline('chat-a', true);
  assert.equal((await adapter.submit(request(route))).accepted, true);
  assert.deepEqual(host.followups().map(x => x.threadId), ['chat-a']);
});

test('a route whose binding was replaced is refused before acceptance and never reaches chat B', async t => {
  const { adapter, host, root } = await setup(t);
  const route = await adapter.captureBinding();
  const file = path.join(root, 'runtime/sessions/dsh.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.binding = { ...state.binding, session: { host: 'local', id: 'chat-b', cwd: 'C:/work/project-b' } };
  fs.writeFileSync(file, JSON.stringify(state));
  await assert.rejects(adapter.submit(request(route)), { code: 'binding_changed', reason: 'binding_changed' });
  for (const forged of [{ ...route, threadId: 'chat-b' }, { ...route, hostId: 'other-host' }, { ...route, generation: undefined }])
    await assert.rejects(adapter.submit(request(forged)), error => ['binding_changed', 'delivery_binding_invalid'].includes(error.code));
  assert.equal(host.followups().length, 0);
});

test('changed policy cannot turn agent mail into user input or next-step steering', async t => {
  const { adapter, host } = await setup(t);
  const route = await adapter.captureBinding();
  for (const extra of [{ after: 'next-step' }, { scope: 'implementation' }, { source: { kind: 'user' } }, { source: { kind: 'plugin', plugin: 'localpost', form: 'steer' } }])
    await assert.rejects(adapter.submit(request(route, extra)), { code: 'delivery_policy_invalid' });
  assert.equal(host.followups().length, 0);
});

test('mail references and keys must stay in the configured recipient mailbox', async t => {
  const { adapter, host } = await setup(t);
  const route = await adapter.captureBinding();
  await assert.rejects(adapter.submit(request(route, { messageReference: { agent: 'codex', id: 'letter-a' } })), { code: 'delivery_reference_invalid' });
  await assert.rejects(adapter.submit(request(route, { idempotencyKey: 'dsh:other' })), { code: 'delivery_reference_invalid' });
  assert.equal(host.followups().length, 0);
});

test('an unsupported DSH version cannot enable automatic dispatch', async t => {
  const { adapter } = await setup(t, { version: '0.2.0-rc.3' });
  assert.equal(adapter.capabilities.wholeTurn, false);
  assert.equal(adapter.diagnostics().dispatchEnabled, false);
  await assert.rejects(adapter.submit({}), { code: 'runtime_capabilities_unverified' });
});

test('an acceptance provider may not enqueue twice, and an undurable answer is not a receipt', async t => {
  const { host, root } = await setup(t);
  const bindingProvider = createBindingProvider({ store: createSessionStore({ root }), identity: 'dsh', host });
  const route = await bindingProvider.capture();
  const twice = createDshAdapter({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', bindingProvider,
    acceptance: { durable: true, idempotent: true, acceptOnce: async (_, enqueue) => { await enqueue(); await enqueue(); } } });
  await assert.rejects(twice.submit(request(route)), { code: 'acceptance_contract_invalid' });
  const undurable = createDshAdapter({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', bindingProvider,
    acceptance: { durable: true, idempotent: true, acceptOnce: async (_, enqueue) => { await enqueue(); return { accepted: true }; } } });
  await assert.rejects(undurable.submit(request(route)), { code: 'acceptance_unconfirmed' });
  assert.equal(host.followups().length, 2, 'one enqueue each; the second enqueue of the first provider was refused');
});
