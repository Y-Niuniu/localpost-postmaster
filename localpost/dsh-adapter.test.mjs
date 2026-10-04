import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDshAdapter } from './dsh-adapter.mjs';
import { createSessionStore } from './session-binding.mjs';
import { createBindingProvider, bindFromChatAction, arrivalRoute } from './binding-provider.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { envelopeDigest } from './mailbox.mjs';
import { createMailTurnGuard } from './mail-turn-guard.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

// Contract tests only: the host is faked, every LocalPost provider is the real one. Nothing here marks a provider
// trusted by hand; trust comes only from the host capability the installed DSH rc.2 does not have.
const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/dsh-adapter');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CWD_A = 'C:/work/project-a';
const digest = envelopeDigest({ id: 'letter-a', thread_id: 't', from: 'codex', to: 'dsh', type: 'task', subject: 's', body: 'b',
  budget: 'standard', created_at: '2026-10-03T00:00:00.000Z' });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The host's pending-input rule, reproduced from dsh-agent-loop/lib/index.js:41-45 (the inbox projection) and
// :190-194 (the splice mutation): two pending messages that share an id collide, and identity-less messages
// collide as "undefined".
function hostPendingIds(messages) {
  const ids = new Set();
  for (const message of messages) {
    if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
    ids.add(message.id);
  }
}

async function setup(t, { capabilities, version = '0.2.0-rc.2', bound = true, scoped = true, guard } = {}) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const host = createFakeDshHost({ root, scoped, ...(capabilities ? { capabilities } : {}) });
  host.openThread('chat-a', CWD_A);
  host.openThread('chat-b', 'C:/work/project-b');
  const store = createSessionStore({ root });
  if (bound) assert.equal((await bindFromChatAction(store, 'dsh', { host, action: host.userBindAction('chat-a'), authority: AUTHORITY })).ok, true);
  const mailTurnGuard = guard === undefined ? createMailTurnGuard({ policy: () => 'test: outside the five', agents: host.ctx.agents }) : guard;
  const make = () => createDshAdapter({ ctx: host.ctx, runtimeVersion: version, mailTurnGuard,
    bindingProvider: createBindingProvider({ store: createSessionStore({ root }), identity: 'dsh', host }),
    acceptance: createLedgerAcceptance({ store: createSessionStore({ root }), identity: 'dsh' }) });
  return { root, host, store, make, mailTurnGuard, adapter: make(), route: bound ? arrivalRoute(await store.read('dsh')).route : null };
}
// Request vocabulary: the released V3 wrapper the receiver speaks. The adapter translates it at the host
// boundary into the producer-owned kind the host persists (see HOST_RELAY_SOURCE in dsh-adapter.mjs).
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
  await assert.rejects(adapter.submit({}), { code: 'runtime_capabilities_unverified' });
  assert.equal(host.followups().length, 0);
});

test('the arrival route A is kept and the mail goes as a plugin relay after a whole turn', async t => {
  const { adapter, host, route } = await setup(t);
  assert.equal(adapter.diagnostics().dispatchEnabled, true);
  assert.deepEqual([route.threadId, route.cwd, route.generation], ['chat-a', CWD_A, 1]);
  const receipt = await adapter.submit(request(route));
  assert.deepEqual(receipt, { accepted: true, durable: true, receipt: 'ledger:dsh:letter-a:g1' });
  const [delivered] = host.followups();
  assert.equal(host.followups().length, 1);
  assert.equal(delivered.threadId, 'chat-a');
  assert.deepEqual(delivered.source, { kind: 'plugin:localpost', form: 'relay' });
  for (const pattern of [/analysis-reply/, /letter-a/, /untrusted/]) assert.match(delivered.text, pattern);
});

test('the delivered source satisfies the host v4 producer-owned kind contract', async t => {
  const { adapter, host, route } = await setup(t);
  await adapter.submit(request(route));
  const [delivered] = host.followups();
  // Host admission, copied verbatim from work/e2-contract/host-producer-kind-contract.md §3 item 3: the host
  // accepts a source whose kind is a nonempty string other than 'plugin'; any other kind is kept verbatim.
  const { kind } = delivered.source;
  assert.equal(typeof kind, 'string');
  assert.notEqual(kind.length, 0);
  assert.notEqual(kind, 'plugin');
  // 'plugin:localpost' is what the host's own V3->V4 migration derives from plugin='localpost' (contract §2),
  // so a record written now and a migrated record name the same producer.
  assert.equal(kind, 'plugin:localpost');
  // form stays 'relay': the client renders form from a closed union and throws on unknown values (contract §6).
  assert.equal(delivered.source.form, 'relay');
  assert.equal(Object.hasOwn(delivered.source, 'plugin'), false, 'the V3 wrapper must not reach the host');
  // Identity: the host reads a user/message back only when it carries a nonempty string id and role 'user'
  // (dsh-session/lib/index.js:1191-1216, reached through adoptSessionEvent on the persistence read path).
  assert.match(delivered.id, UUID_PATTERN);
  assert.equal(delivered.role, 'user');
});

test('two pending deliveries carry distinct identities instead of colliding as undefined', async t => {
  const { adapter, host, route } = await setup(t);
  await adapter.submit(request(route));
  await adapter.submit(request(route, { messageReference: { agent: 'dsh', id: 'letter-b' }, idempotencyKey: 'dsh:letter-b' }));
  const delivered = host.followups();
  assert.equal(delivered.length, 2, 'two distinct letters each wake the chat once');
  assert.deepEqual(delivered.map(message => message.role), ['user', 'user']);
  for (const message of delivered) assert.match(message.id, UUID_PATTERN);
  assert.notEqual(delivered[0].id, delivered[1].id);
  assert.doesNotThrow(() => hostPendingIds(delivered), 'distinct identities never collide while both are pending');
  // Negative control: the pre-fix shape had no id, so the host rule collapses both messages onto "undefined".
  assert.throws(() => hostPendingIds([{ source: {} }, { source: {} }]), { message: 'message "undefined" is already pending' });
});

test('the same mail key wakes the chat once, also through a restarted adapter', async t => {
  const { adapter, make, host, route } = await setup(t);
  await adapter.submit(request(route));
  const again = await make().submit(request(route));
  assert.equal(again.deduplicated, true);
  assert.equal(host.followups().length, 1);
});

test('an offline bound chat stays unavailable and is never resumed, created or replaced', async t => {
  const { adapter, host, route } = await setup(t);
  host.setOnline('chat-a', false);
  await assert.rejects(adapter.submit(request(route)), { code: 'binding_unverified' });
  assert.equal(host.followups().length, 0);
  assert.deepEqual(Object.keys(host.state().threads), ['chat-a', 'chat-b']);
  host.setOnline('chat-a', true);
  assert.equal((await adapter.submit(request(route))).accepted, true);
  assert.deepEqual(host.followups().map(x => x.threadId), ['chat-a']);
});

test('a route whose binding was replaced is refused before acceptance and never reaches chat B', async t => {
  const { adapter, host, root, route } = await setup(t);
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
  const { adapter, host, route } = await setup(t);
  for (const extra of [{ after: 'next-step' }, { scope: 'implementation' }, { source: { kind: 'user' } }, { source: { kind: 'plugin', plugin: 'localpost', form: 'steer' } }])
    await assert.rejects(adapter.submit(request(route, extra)), { code: 'delivery_policy_invalid' });
  assert.equal(host.followups().length, 0);
});

test('mail references and keys must stay in the configured recipient mailbox', async t => {
  const { adapter, host, route } = await setup(t);
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
  const { host, root, mailTurnGuard } = await setup(t);
  const bindingProvider = createBindingProvider({ store: createSessionStore({ root }), identity: 'dsh', host });
  const route = arrivalRoute(await createSessionStore({ root }).read('dsh')).route;
  const twice = createDshAdapter({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', bindingProvider, mailTurnGuard,
    acceptance: { durable: true, idempotent: true, acceptOnce: async (_, enqueue) => { await enqueue(); await enqueue(); } } });
  await assert.rejects(twice.submit(request(route)), { code: 'acceptance_contract_invalid' });
  const undurable = createDshAdapter({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2', bindingProvider, mailTurnGuard,
    acceptance: { durable: true, idempotent: true, acceptOnce: async (_, enqueue) => { await enqueue(); return { accepted: true }; } } });
  await assert.rejects(undurable.submit(request(route)), { code: 'acceptance_unconfirmed' });
  assert.equal(host.followups().length, 2, 'one enqueue each; the second enqueue of the first provider was refused');
});

// --- the mail-turn guard at the adapter boundary (C2) ---------------------------------------------------------------

test('without a mail-turn guard automatic dispatch stays off', async t => {
  const { host, root } = await setup(t);
  const adapter = createDshAdapter({ ctx: host.ctx, runtimeVersion: '0.2.0-rc.2',
    bindingProvider: createBindingProvider({ store: createSessionStore({ root }), identity: 'dsh', host }),
    acceptance: createLedgerAcceptance({ store: createSessionStore({ root }), identity: 'dsh' }) });
  assert.equal(adapter.capabilities.mailTurnGuard, false);
  assert.ok(adapter.diagnostics().reasons.includes('mailTurnGuard'));
  assert.equal(adapter.diagnostics().dispatchEnabled, false);
  await assert.rejects(adapter.submit({}), { code: 'runtime_capabilities_unverified' });
  assert.equal(host.followups().length, 0);
});

test('every relay is armed on its target chat before it is enqueued, keyed by the relay message id', async t => {
  const { adapter, host, route, mailTurnGuard } = await setup(t);
  // Witness the order: the moment followup runs, the guard for that very message must already stand on chat A.
  const original = host.ctx.agents.get;
  let armedAtFollowup = null;
  host.ctx.agents.get = threadId => {
    const agent = original(threadId);
    if (agent) {
      const followup = agent.followup;
      agent.followup = async message => {
        armedAtFollowup = mailTurnGuard.status().armaments.filter(item => item.messageId === message.id && item.state === 'pending').length;
        return followup(message);
      };
    }
    return agent;
  };
  await adapter.submit(request(route));
  const [delivered] = host.followups();
  assert.equal(armedAtFollowup, 1, 'armed before the enqueue');
  assert.deepEqual(mailTurnGuard.status().armaments.map(item => [item.messageId, item.state]), [[delivered.id, 'pending']]);
  // One guard and three lifecycle listeners, all on chat A's own scope - none on the plugin context.
  assert.deepEqual(host.armed('chat-a').map(entry => entry.kind === 'on' ? entry.name : 'guard').sort(),
    ['agent/inbox/claimed', 'agent/inbox/discarded', 'guard', 'session/event']);
  assert.deepEqual(host.armed('chat-b'), []);
});

test('a chat that cannot be guarded receives nothing: guard_unavailable is definitive and the letter waits', async t => {
  const { adapter, host, route, store } = await setup(t, { scoped: false });
  await assert.rejects(adapter.submit(request(route)), { code: 'guard_unavailable' });
  assert.equal(host.followups().length, 0, 'nothing was enqueued');
  // The ledger released the attempt (definitive, nothing sent): the receiver may try again on a later scan.
  assert.equal((await store.read('dsh')).claims['letter-a'].status, 'released');
});

test('a guard that is draining arms nothing and sends nothing', async t => {
  const { adapter, host, route, mailTurnGuard } = await setup(t);
  await mailTurnGuard.drain({ timeoutMs: 50 });
  await assert.rejects(adapter.submit(request(route)), { code: 'guard_unavailable' });
  assert.equal(host.followups().length, 0);
});

test('a lost followup confirmation keeps the relay armed; a followup that provably enqueued nothing releases it', async t => {
  const { adapter, host, route, mailTurnGuard } = await setup(t);
  host.breakFollowups('lost');                       // queued on the host, the answer lost: it may still be claimed
  await assert.rejects(adapter.submit(request(route)), { code: 'acceptance_uncertain' });
  const [queued] = host.followups();
  assert.deepEqual(mailTurnGuard.status().armaments.map(item => [item.messageId, item.state]), [[queued.id, 'pending']]);

  const other = await setup(t);
  const original = other.host.ctx.agents.get;
  other.host.ctx.agents.get = threadId => {
    const agent = original(threadId);
    if (agent) agent.followup = async () => { throw new Error('rejected before queueing'); };
    return agent;
  };
  await assert.rejects(other.adapter.submit(request(other.route)), { code: 'acceptance_uncertain' });
  assert.deepEqual(other.mailTurnGuard.status().armaments, [], 'not in the inbox: released as never enqueued');
  assert.deepEqual(other.host.armed('chat-a'), [], 'and every registration it made is gone');
});
