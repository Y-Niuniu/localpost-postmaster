import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPLY_OUTCOMES, SUPPORTED_VERSION, TOOL_NAMES, attestedCaller, createMailTools } from './dsh-mail-tools.mjs';
import { bind, createSessionStore } from './session-binding.mjs';
import { createMailbox } from './mailbox.mjs';
import { removeTree } from './temp-tree.mjs';

const TMP = path.resolve(import.meta.dirname, '..', '.localpost-tmp', 'dsh-mail-tools');
const created = [];
async function scratch(name) {
  const dir = path.join(TMP, name + '-' + Math.random().toString(16).slice(2, 8));
  await fs.mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}
test.after(async () => { for (const dir of created) await removeTree(dir); await removeTree(TMP); });

const SESSION = Object.freeze({ host: 'local', id: 'chat-A', cwd: 'C:/work/A' });
const chatAgent = (id, cwd = SESSION.cwd) => ({ session: { id, header: { cwd } }, status: 'running' });
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

function fakeHost({ agents = new Map(), tools = true, find = 'none' } = {}) {
  const definitions = [];
  const released = [];
  const ctx = { agents: { get: id => agents.get(id) } };
  if (tools) {
    ctx.tools = {
      register: definition => { definitions.push(definition); return () => released.push(definition.name); },
      ...find === 'none' ? {} : {
        find: find === 'throws'
          ? () => { throw new Error('lookup exploded'); }
          : (agent, name) => (name === 'localpost_inbox' ? { name, execute: () => {} } : undefined),
      },
    };
  }
  return { ctx, definitions, released, agents };
}
const call = (definitions, name, args, exec) => definitions.find(entry => entry.name === name).execute(args, exec);
const execFor = agent => ({ agent, callId: 'call-1', arguments: {}, signal: undefined });

/** A real mailbox bound to chat A in the requested mode, with one delivered letter. */
async function mailboxFor(name, { mode = 'manual', session = SESSION, letter = 'l1' } = {}) {
  const root = await scratch(name);
  const store = createSessionStore({ root, waitMs: 2000 });
  await bind(store, 'dsh', {
    session, mode, capacity: 50, authority: { scope: 'analysis-reply', source: 'policy:test' }, source: 'e2e',
    attestation: { actionId: 'a1', hostId: session.host, threadId: session.id, cwd: session.cwd },
  });
  // A mailbox instance acts as the configured identity, so the letter is delivered by codex's instance and
  // read, replied to and archived through dsh's instance over the same root.
  await createMailbox({ root, identity: 'codex' })
    .deliver({ id: letter, from: 'codex', to: 'dsh', type: 'task', subject: 'please handle', body: 'do the thing' });
  const mailbox = createMailbox({ root, identity: 'dsh' });
  return { root, store, mailbox, letter };
}
function mount(root, store, mailbox, version = SUPPORTED_VERSION) {
  const host = fakeHost();
  const tools = createMailTools({ ctx: host.ctx, mailbox, store, identity: 'dsh', runtimeVersion: version });
  return { host, tools, registered: tools.register() };
}

test('real mailbox, manual binding: the bound chat reads, replies terminally and the original is archived', async () => {
  const { root, store, mailbox, letter } = await mailboxFor('e2e');
  const { host, registered } = mount(root, store, mailbox);
  assert.equal(registered.ok, true);
  const agent = chatAgent('chat-A');
  host.agents.set('chat-A', agent);
  const exec = execFor(agent);

  assert.match(await call(host.definitions, 'localpost_inbox', {}, exec), new RegExp(letter));
  assert.match(await call(host.definitions, 'localpost_read', { id: letter }, exec), /do the thing/);
  const replied = JSON.parse(await call(host.definitions, 'localpost_reply', { id: letter, outcome: 'completed', body: 'handled' }, exec));
  assert.ok(typeof replied.replied === 'string' && replied.replied.length > 0);
  assert.equal(replied.outcome, 'completed');

  // The published result names the letter it answers; the answered letter left the inbox for the archive.
  const published = (await fs.readdir(path.join(root, 'agents', 'codex', 'inbox'))).filter(file => file.endsWith('.json'));
  assert.equal(published.length, 1, 'exactly one result letter must be published');
  const result = JSON.parse(await fs.readFile(path.join(root, 'agents', 'codex', 'inbox', published[0]), 'utf8'));
  assert.equal(result.reply_to, letter);
  assert.equal(result.outcome, 'completed');
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'inbox', letter + '.json')), false);
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'archive', letter + '.json')), true);

  const archived = JSON.parse(await call(host.definitions, 'localpost_archive', { id: letter }, exec));
  assert.equal(archived.archived, letter);
});

test('a letter under an automatic binding is not taken by hand: the ledger keeps one consumer', async () => {
  const { root, store, mailbox, letter } = await mailboxFor('auto', { mode: 'auto' });
  const { host } = mount(root, store, mailbox);
  const agent = chatAgent('chat-A');
  host.agents.set('chat-A', agent);
  // Bound and caller proven, yet the automatic consumer owns this letter until it is delivered to the session.
  await assert.rejects(call(host.definitions, 'localpost_read', { id: letter }, execFor(agent)), { code: 'CLAIMED_BY_AUTO' });
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'inbox', letter + '.json')), true);
  assert.match(await call(host.definitions, 'localpost_inbox', {}, execFor(agent)), new RegExp(letter), 'listing stays available to the bound chat');
});

/** A mailbox that enforces the real owner contract, for the paths a real un-owned letter cannot reach. */
function ownedMailbox(owner) {
  const calls = [];
  const prove = (op, caller) => {
    if (!caller?.host || !caller?.session) throw Object.assign(new Error('CALLER_UNVERIFIED'), { code: 'CALLER_UNVERIFIED' });
    if (caller.session !== owner.session || caller.host !== owner.host) throw Object.assign(new Error('NOT_LETTER_OWNER'), { code: 'NOT_LETTER_OWNER' });
    calls.push(op);
  };
  return {
    calls,
    inbox: () => [{ id: 'l1', from: 'codex' }],
    async take(agent, id, { caller } = {}) { prove('take', caller); return { envelope: { id, from: 'codex', body: 'x' }, attachments_resolved: [] }; },
    async reply(agent, input, { caller } = {}) { prove('reply', caller); return { id: 'r1', outcome: input.outcome, archived: input.reply_to }; },
    async archive(agent, id, { caller } = {}) { prove('archive', caller); return { archived: id, idempotent: false }; },
  };
}

test('the owner check gates read, reply and archive: another chat cannot work an owned letter', async () => {
  const root = await scratch('owned');
  const store = createSessionStore({ root, waitMs: 2000 });
  await bind(store, 'dsh', {
    session: SESSION, mode: 'auto', capacity: 50, authority: { scope: 'analysis-reply', source: 'policy:test' },
    source: 'e2e', attestation: { actionId: 'a1', hostId: SESSION.host, threadId: SESSION.id, cwd: SESSION.cwd },
  });
  const mailbox = ownedMailbox({ host: 'local', session: 'chat-A' });
  const { host } = mount(root, store, mailbox);
  const other = chatAgent('chat-B', 'C:/work/B');
  host.agents.set('chat-B', other);
  const exec = execFor(other);
  await assert.rejects(call(host.definitions, 'localpost_read', { id: 'l1' }, exec), { code: 'NOT_LETTER_OWNER' });
  await assert.rejects(call(host.definitions, 'localpost_reply', { id: 'l1', outcome: 'completed', body: 'x' }, exec), { code: 'NOT_LETTER_OWNER' });
  await assert.rejects(call(host.definitions, 'localpost_archive', { id: 'l1' }, exec), { code: 'NOT_LETTER_OWNER' });
  assert.deepEqual(mailbox.calls, [], 'a chat that is not the owner must not reach a single mailbox operation');
  const owner = chatAgent('chat-A');
  host.agents.set('chat-A', owner);
  assert.match(await call(host.definitions, 'localpost_read', { id: 'l1' }, execFor(owner)), /"id":"l1"/);
  assert.deepEqual(mailbox.calls, ['take']);
});

test('another chat cannot list this identity\'s binding state', async () => {
  const { root, store, mailbox } = await mailboxFor('other');
  const { host } = mount(root, store, mailbox);
  const other = chatAgent('chat-B', 'C:/work/B');
  host.agents.set('chat-B', other);
  await assert.rejects(call(host.definitions, 'localpost_inbox', {}, execFor(other)), { code: 'NOT_BOUND_CHAT' });
  await assert.rejects(call(host.definitions, 'localpost_status', {}, execFor(other)), { code: 'NOT_BOUND_CHAT' });
});

test('workspace drift fails closed until a new explicit bind', async () => {
  const { root, store, mailbox } = await mailboxFor('drift');
  const { host } = mount(root, store, mailbox);
  const drifted = chatAgent('chat-A', 'C:/work/ELSEWHERE');
  host.agents.set('chat-A', drifted);
  await assert.rejects(call(host.definitions, 'localpost_inbox', {}, execFor(drifted)), { code: 'NOT_BOUND_CHAT' });
  await assert.rejects(call(host.definitions, 'localpost_status', {}, execFor(drifted)), { code: 'NOT_BOUND_CHAT' });
});

test('an incapable host registers nothing', async () => {
  const { root, store, mailbox } = await mailboxFor('incapable');
  for (const [label, options] of [
    ['the host has no live agent lookup', { agents: { get: undefined } }],
    ['unsupported runtime', { version: '0.1.5-rc.1' }],
    ['lookup failure at registration', { find: 'throws' }],
    ['a taken tool name', { find: 'taken' }],
    ['the host has no tool registry', { tools: false }],
  ]) {
    const host = fakeHost({ agents: new Map([['chat-A', chatAgent('chat-A')]]), ...options });
    const ctx = options.agents ?? host.ctx;
    const tools = createMailTools({ ctx, mailbox, store, identity: 'dsh', runtimeVersion: options.version ?? SUPPORTED_VERSION });
    const registered = tools.register();
    assert.equal(registered.ok, false, label + ' must not register');
    assert.equal(host.definitions.length, 0, label + ' must register nothing');
    if (label === 'lookup failure at registration') assert.equal(registered.reason, 'lookup_failed');
    if (label === 'a taken tool name') assert.equal(registered.reason, 'tool_name_taken');
  }
});

test('an unproven caller registers but is never served, and never touches mailbox state', async () => {
  const { root, store, mailbox, letter } = await mailboxFor('unproven');
  const agent = chatAgent('chat-A');
  for (const [label, ctxFor] of [
    ['plain MCP: no agent at all', host => host.ctx],
    ['registry substitutes another agent object', host => ({ tools: host.ctx.tools, agents: { get: () => chatAgent('chat-A') } })],
  ]) {
    const host = fakeHost({ agents: new Map([['chat-A', agent]]) });
    const tools = createMailTools({ ctx: ctxFor(host), mailbox, store, identity: 'dsh', runtimeVersion: SUPPORTED_VERSION });
    assert.equal(tools.register().ok, true, label + ' must register: the host is capable, only the caller is unproven');
    for (const name of TOOL_NAMES) {
      const exec = label.startsWith('plain MCP') ? {} : execFor(agent);
      await assert.rejects(call(host.definitions, name, { id: letter }, exec), { code: 'CALLER_UNVERIFIED' }, label + ' / ' + name);
    }
  }
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'inbox', letter + '.json')), true);
  assert.equal(await exists(path.join(root, 'agents', 'dsh', 'archive', letter + '.json')), false);
});

test('a scoped definition that shadows ours stops the call', async () => {
  const { root, store, mailbox } = await mailboxFor('shadow');
  const { host } = mount(root, store, mailbox);
  const agent = chatAgent('chat-A');
  host.agents.set('chat-A', agent);
  const mine = host.definitions;
  host.ctx.tools.find = (which, name) => (name === 'localpost_inbox' ? { name, execute: async () => 'shadow' } : mine.find(entry => entry.name === name));
  await assert.rejects(call(host.definitions, 'localpost_inbox', {}, execFor(agent)), { code: 'TOOL_SHADOWED' });
  assert.match(await call(host.definitions, 'localpost_status', {}, execFor(agent)), /mode=manual/, 'an unshadowed tool still runs');
});

test('the reply schema and the tool set are exactly what the protocol allows', async () => {
  const { root, store, mailbox } = await mailboxFor('schema');
  const { host } = mount(root, store, mailbox);
  assert.deepEqual(host.definitions.map(entry => entry.name).sort(), [...TOOL_NAMES].sort());
  const reply = host.definitions.find(entry => entry.name === 'localpost_reply');
  assert.deepEqual(reply.parameters.properties.outcome.enum, [...REPLY_OUTCOMES]);
  assert.equal(host.definitions.some(entry => /send|deliver/.test(entry.name)), false);
  for (const definition of host.definitions) {
    assert.doesNotMatch(JSON.stringify(definition.parameters), /caller|agent|session/i, definition.name + ' must not accept a caller');
  }
});

test('attestedCaller is the single place that decides who is calling', () => {
  const agent = chatAgent('chat-A');
  const ctx = { agents: { get: id => (id === 'chat-A' ? agent : undefined) } };
  assert.deepEqual(attestedCaller(ctx, execFor(agent), 'local'), { host: 'local', session: 'chat-A', cwd: 'C:/work/A' });
  assert.throws(() => attestedCaller(ctx, {}, 'local'), { code: 'CALLER_UNVERIFIED' });
  assert.throws(() => attestedCaller({ agents: { get: () => chatAgent('chat-A') } }, execFor(agent), 'local'), { code: 'CALLER_UNVERIFIED' });
  assert.throws(() => attestedCaller(ctx, execFor({ session: { id: 'chat-A', header: { cwd: 'rel' } } }), 'local'), { code: 'CALLER_UNVERIFIED' });
});