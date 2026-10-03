import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TOOL_NAMES, attestedCaller, createMailTools } from './dsh-mail-tools.mjs';
import { createSessionStore } from './session-binding.mjs';
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

const chatAgent = (id, cwd = 'C:/work/A') => ({ session: { id, header: { cwd } }, status: 'running' });

function fakeHost({ agents = new Map(), tools = true, failOn = 0, taken = null } = {}) {
  const definitions = [];
  const released = [];
  const ctx = { agents: { get: id => agents.get(id) } };
  if (tools) {
    ctx.tools = {
      register: definition => {
        if (failOn && definitions.length + 1 === failOn) throw new Error('registry refused');
        definitions.push(definition);
        return () => released.push(definition.name);
      },
      find: () => (taken === null ? undefined : { name: taken }),
    };
  }
  return { ctx, definitions, released, agents };
}

/** A mailbox that enforces the real contract: a caller is mandatory, and it must be the letter owner. */
function fakeMailbox(owner = {}) {
  const calls = [];
  const requireCaller = (op, caller) => {
    if (!caller?.host || !caller?.session) throw Object.assign(new Error('CALLER_UNVERIFIED: nothing proves which chat is calling'), { code: 'CALLER_UNVERIFIED' });
    if (owner.session !== undefined && (caller.session !== owner.session || caller.host !== owner.host)) {
      throw Object.assign(new Error('letter belongs to another chat'), { code: 'CALLER_MISMATCH' });
    }
    calls.push({ op, caller });
  };
  return {
    calls,
    inbox: () => [{ id: 'letter-1', from: 'codex', subject: 'hi', type: 'task' }],
    async take(agent, id, { caller } = {}) { requireCaller('take', caller); return { envelope: { id, from: 'codex', subject: 'hi', body: 'do it' }, attachments_resolved: [] }; },
    async reply(agent, input, { caller } = {}) { requireCaller('reply', caller); return { id: 'reply-1', outcome: input.outcome, archived: input.id, idempotent: false }; },
    async archive(agent, id, { caller } = {}) { requireCaller('archive', caller); return { archived: id, idempotent: false }; },
  };
}

async function toolsFor(name, options = {}) {
  const root = await scratch(name);
  const store = createSessionStore({ root, waitMs: 500 });
  const host = fakeHost(options);
  const mailbox = options.mailbox ?? fakeMailbox();
  const tools = createMailTools({ ctx: host.ctx, mailbox, store, identity: 'dsh' });
  return { root, store, host, mailbox, tools };
}
const call = (definitions, name, args, exec) => definitions.find(entry => entry.name === name).execute(args, exec);
const execFor = (agent) => ({ agent, callId: 'call-1', arguments: {}, signal: undefined });

test('a plain MCP call carries no agent, so every tool refuses it', async () => {
  const { tools, host } = await toolsFor('nomcp');
  tools.register();
  for (const name of TOOL_NAMES) {
    await assert.rejects(call(host.definitions, name, {}, {}), { code: 'CALLER_UNVERIFIED' });
    await assert.rejects(call(host.definitions, name, { id: 'letter-1', outcome: 'completed', body: 'x' }, { arguments: {} }), { code: 'CALLER_UNVERIFIED' });
  }
});

test('a caller that the live registry does not hand back, or has no absolute workspace, is refused', async () => {
  const { tools, host, mailbox } = await toolsFor('identity');
  tools.register();
  const replaced = chatAgent('chat-A');
  host.agents.set('chat-A', chatAgent('chat-A'));                 // a different object for the same id
  await assert.rejects(call(host.definitions, 'localpost_inbox', {}, execFor(replaced)), { code: 'CALLER_UNVERIFIED' });
  const noWorkspace = { session: { id: 'chat-A' } };
  host.agents.set('chat-A', noWorkspace);
  await assert.rejects(call(host.definitions, 'localpost_inbox', {}, execFor(noWorkspace)), { code: 'CALLER_UNVERIFIED' });
  const relative = { session: { id: 'chat-A', header: { cwd: 'relative/dir' } } };
  host.agents.set('chat-A', relative);
  await assert.rejects(call(host.definitions, 'localpost_inbox', {}, execFor(relative)), { code: 'CALLER_UNVERIFIED' });
  assert.deepEqual(mailbox.calls, [], 'a refused caller must never reach the mailbox');
});

test('no tool exposes the caller as a parameter, and there is no send tool', async () => {
  const { tools, host } = await toolsFor('schema');
  tools.register();
  assert.equal(host.definitions.length, TOOL_NAMES.length);
  for (const definition of host.definitions) {
    const text = JSON.stringify(definition.parameters);
    assert.doesNotMatch(text, /caller|agent|session/i, definition.name + ' must not accept a caller, agent or session argument');
  }
  assert.equal(host.definitions.some(entry => /send|deliver/.test(entry.name)), false, 'this bridge must not be able to create mail');
  assert.deepEqual(host.definitions.map(entry => entry.name).sort(), [...TOOL_NAMES].sort());
});

test('the bound chat can read, reply and archive, and the mailbox sees the proven caller every time', async () => {
  const { tools, host, mailbox } = await toolsFor('happy', { mailbox: fakeMailbox({ host: 'local', session: 'chat-A' }) });
  tools.register();
  const agent = chatAgent('chat-A');
  host.agents.set('chat-A', agent);
  const exec = execFor(agent);

  const read = await call(host.definitions, 'localpost_read', { id: 'letter-1' }, exec);
  assert.match(read, /letter-1/);
  const replied = await call(host.definitions, 'localpost_reply', { id: 'letter-1', outcome: 'completed', body: 'done' }, exec);
  assert.match(replied, /"replied":"reply-1"/);
  const archived = await call(host.definitions, 'localpost_archive', { id: 'letter-1' }, exec);
  assert.match(archived, /"archived":"letter-1"/);
  assert.deepEqual(mailbox.calls.map(entry => entry.op), ['take', 'reply', 'archive']);
  for (const entry of mailbox.calls) assert.deepEqual(entry.caller, { host: 'local', session: 'chat-A', cwd: 'C:/work/A' });
});

test('another chat under the same identity cannot finish the letter', async () => {
  const { tools, host } = await toolsFor('other-chat', { mailbox: fakeMailbox({ host: 'local', session: 'chat-A' }) });
  tools.register();
  const other = chatAgent('chat-B', 'C:/work/B');
  host.agents.set('chat-B', other);
  await assert.rejects(call(host.definitions, 'localpost_read', { id: 'letter-1' }, execFor(other)), { code: 'CALLER_MISMATCH' });
  await assert.rejects(call(host.definitions, 'localpost_archive', { id: 'letter-1' }, execFor(other)), { code: 'CALLER_MISMATCH' });
  // The claim owner check is (host, session) - exactly what the mailbox enforces; the workspace is verified
  // separately by the binding provider before any dispatch, so it is not re-checked here.
  const moved = chatAgent('chat-A', 'C:/work/ELSEWHERE');
  host.agents.set('chat-A', moved);
  assert.match(await call(host.definitions, 'localpost_inbox', {}, execFor(moved)), /letter-1/);

  });
test('registration is gated, all-or-nothing and idempotent', async () => {
  const noRegistry = await toolsFor('noreg', { tools: false });
  const refused = noRegistry.tools.register();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'tool_registry_unavailable');
  assert.equal(noRegistry.host.definitions.length, 0);

  const taken = await toolsFor('taken', { taken: 'localpost_inbox' });
  const conflict = taken.tools.register();
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'tool_name_taken');
  assert.equal(taken.host.definitions.length, 0);

  const partial = await toolsFor('partial', { failOn: 3 });
  const failed = partial.tools.register();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'registration_failed');
  assert.deepEqual(partial.host.released.slice().reverse(), TOOL_NAMES.slice(0, 2), 'the first two tools must be released in reverse order');

  const good = await toolsFor('good');
  assert.equal(good.tools.register().ok, true);
  assert.equal(good.tools.register().existing, true);
  assert.equal(good.host.definitions.length, TOOL_NAMES.length);
});

test('status reports the stored binding for the calling chat', async () => {
  const { tools, host, store } = await toolsFor('status');
  tools.register();
  const agent = chatAgent('chat-A');
  host.agents.set('chat-A', agent);
  assert.match(await call(host.definitions, 'localpost_status', {}, execFor(agent)), /no binding state/);
  await store.create('dsh', () => ({
    schema: 'localpost-session-state-v1', identity: 'dsh', revision: 0,
    binding: { version: 1, generation: 1, session: { host: 'local', id: 'chat-A', cwd: 'C:/work/A' }, mode: 'auto', state: 'active', frozen: null, capacity: 50, authority: { scope: 'analysis-reply', source: 'policy:test' }, source: 'test', since: 1 },
    claims: {}, context: null, rotations: {},
  }));
  const shown = await call(host.definitions, 'localpost_status', {}, execFor(agent));
  assert.match(shown, /mode=auto/);
  assert.match(shown, /chat=chat-A/);
});

test('attestedCaller is the single place that decides who is calling', () => {
  const agent = chatAgent('chat-A');
  const ctx = { agents: { get: id => (id === 'chat-A' ? agent : undefined) } };
  assert.deepEqual(attestedCaller(ctx, execFor(agent), 'local'), { host: 'local', session: 'chat-A', cwd: 'C:/work/A' });
  assert.throws(() => attestedCaller(ctx, {}, 'local'), { code: 'CALLER_UNVERIFIED' });
  assert.throws(() => attestedCaller({ agents: { get: () => chatAgent('chat-A') } }, execFor(agent), 'local'), { code: 'CALLER_UNVERIFIED' });
});
