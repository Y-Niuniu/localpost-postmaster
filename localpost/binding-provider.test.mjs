import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSessionStore } from './session-binding.mjs';
import { createBindingProvider, bindFromChatAction } from './binding-provider.mjs';
import { createFakeDshHost } from './fixtures/fake-dsh-host.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/binding-provider');
const AUTHORITY = { scope: 'analysis-reply', source: 'policy:test' };
const CWD_A = 'C:/work/project-a';

function setup(t, options) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(root));
  const host = createFakeDshHost({ root, ...options });
  host.openThread('chat-a', CWD_A);
  host.openThread('chat-b', 'C:/work/project-b');
  const store = createSessionStore({ root });
  return { root, host, store, provider: createBindingProvider({ store, identity: 'dsh', host }) };
}
const bindA = ({ store, host }, action = host.userBindAction('chat-a')) =>
  bindFromChatAction(store, 'dsh', { host, action, capacity: 50, authority: AUTHORITY });

test('a binding exists only through the user\'s explicit action in that chat, confirmed by the host', async t => {
  const ctx = setup(t);
  const forged = { actionId: 'action-99', hostId: 'local', threadId: 'chat-a', cwd: CWD_A };
  assert.deepEqual(await bindFromChatAction(ctx.store, 'dsh', { host: ctx.host, action: forged, capacity: 50, authority: AUTHORITY }),
    { ok: false, reason: 'attestation_mismatch' }, 'an action the host never saw binds nothing');
  const action = ctx.host.userBindAction('chat-a');
  const claimedElsewhere = await bindFromChatAction(ctx.store, 'dsh', { host: ctx.host, action: { ...action, threadId: 'chat-b' }, capacity: 50, authority: AUTHORITY });
  assert.deepEqual(claimedElsewhere, { ok: false, reason: 'attestation_mismatch' }, 'the action cannot be redirected to another chat');
  assert.equal(await ctx.store.read('dsh'), null);
  const bound = await bindA(ctx, action);
  assert.equal(bound.ok, true);
  assert.deepEqual(bound.binding.session, { host: 'local', id: 'chat-a', cwd: CWD_A });
  assert.deepEqual([bound.binding.mode, bound.binding.source], ['auto', `chat-action:${action.actionId}`]);
  assert.deepEqual(bound.binding.attestation, { kind: 'chat-action', actionId: action.actionId, hostId: 'local', threadId: 'chat-a', cwd: CWD_A, at: bound.binding.since });
});

test('without the host capability nothing is trusted and no binding can be made', async t => {
  const ctx = setup(t, { capabilities: {} });
  assert.equal(ctx.provider.trusted, false);
  assert.deepEqual(await bindA(ctx), { ok: false, reason: 'host_cannot_attest' });
  await assert.rejects(ctx.provider.capture(), { code: 'binding_unverified' });
});

test('the captured snapshot records host, chat, workspace, generation, revision and time', async t => {
  const ctx = setup(t);
  await bindA(ctx);
  const snapshot = await ctx.provider.capture();
  const { binding } = await ctx.store.read('dsh');
  assert.deepEqual(snapshot, { identity: 'dsh', hostId: 'local', threadId: 'chat-a', cwd: CWD_A, generation: 1,
    bindingRevision: binding.version, boundAt: binding.since, attestation: binding.attestation.actionId });
  assert.ok(Object.isFrozen(snapshot));
});

test('verification fails closed when the chat is offline, moved, on another host, or the binding changed', async t => {
  const ctx = setup(t);
  await bindA(ctx);
  const snapshot = await ctx.provider.capture();
  const target = { hostId: snapshot.hostId, threadId: snapshot.threadId, cwd: snapshot.cwd, generation: snapshot.generation };
  assert.equal(await ctx.provider.verifyBinding(target), true);
  ctx.host.setOnline('chat-a', false);
  assert.equal(await ctx.provider.verifyBinding(target), false, 'offline');
  ctx.host.setOnline('chat-a', true);
  assert.equal(await ctx.provider.verifyBinding({ ...target, cwd: 'C:/work/project-b' }), false, 'another workspace');
  assert.equal(await ctx.provider.verifyBinding({ ...target, hostId: 'other-host' }), false, 'another host');
  assert.equal(await ctx.provider.verifyBinding({ ...target, threadId: 'chat-b' }), false, 'another chat');
  assert.equal(await ctx.provider.verifyBinding({ ...target, generation: 2 }), false, 'a generation that does not exist');
  ctx.host.openThread('chat-a', 'C:/work/moved');
  assert.equal(await ctx.provider.verifyBinding(target), false, 'the chat now runs in another workspace');
});

test('after a completed, verified rotation, earlier mail follows the lineage and the successor counts as attested', async t => {
  const ctx = setup(t);
  await bindA(ctx);
  const route = await ctx.provider.capture();
  const file = path.join(ctx.root, 'runtime/sessions/dsh.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const successor = { host: 'local', id: 'chat-a2', cwd: CWD_A };
  // Exactly what rotation.mjs leaves behind after the switch: the journal names the verified successor.
  state.rotations['1'] = { generation: 1, next: 2, reason: 'capacity', from: { ...state.binding.session }, binding_version: 2, state: 'retired',
    history: [], handoff: null, candidate: { id: 'chat-a2', attempt: 1, status: 'verified', session: successor }, abandoned: [], failure: null };
  state.binding = { ...state.binding, generation: 2, version: 3, session: successor };
  fs.writeFileSync(file, JSON.stringify(state));
  ctx.host.openThread('chat-a2', CWD_A);
  assert.deepEqual(await ctx.provider.resolve(route), { ok: true, target: { identity: 'dsh', hostId: 'local', threadId: 'chat-a2', cwd: CWD_A, generation: 2 } });
  assert.equal((await ctx.provider.capture()).threadId, 'chat-a2');
  assert.equal(await ctx.provider.verifyBinding({ hostId: 'local', threadId: 'chat-a2', cwd: CWD_A, generation: 2 }), true);
  // A rotation that never verified its candidate gives no lineage.
  state.rotations['1'].candidate.status = 'rejected';
  fs.writeFileSync(file, JSON.stringify(state));
  assert.deepEqual(await ctx.provider.resolve(route), { ok: false, reason: 'route_lineage_broken' });
  await assert.rejects(ctx.provider.capture(), { code: 'binding_unattested' });
});

test('a route resolves only to its own binding or a successor reached by a completed rotation', async t => {
  const ctx = setup(t);
  await bindA(ctx);
  const route = await ctx.provider.capture();
  assert.deepEqual(await ctx.provider.resolve(route), { ok: true, target: { identity: 'dsh', hostId: 'local', threadId: 'chat-a', cwd: CWD_A, generation: 1 } });
  for (const [field, value, reason] of [['threadId', 'chat-b', 'binding_changed'], ['generation', 2, 'route_from_future'],
    ['cwd', 'C:/work/project-b', 'binding_changed'], ['hostId', 'other-host', 'binding_changed'], ['identity', 'codex', 'route_invalid']]) {
    assert.deepEqual(await ctx.provider.resolve({ ...route, [field]: value }), { ok: false, reason }, `forged ${field}`);
  }
  assert.deepEqual(await ctx.provider.resolve({ ...route, bindingRevision: undefined, generation: undefined }), { ok: false, reason: 'route_invalid' });
  // An unattested rebinding (the binding record replaced by hand) breaks the lineage: old mail never follows it.
  const file = path.join(ctx.root, 'runtime/sessions/dsh.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.binding = { ...state.binding, generation: 2, session: { host: 'local', id: 'chat-b', cwd: 'C:/work/project-b' } };
  fs.writeFileSync(file, JSON.stringify(state));
  assert.deepEqual(await ctx.provider.resolve(route), { ok: false, reason: 'route_lineage_broken' });
  await assert.rejects(ctx.provider.capture(), { code: 'binding_unattested' }, 'a binding nobody attested is not used for new mail either');
});
