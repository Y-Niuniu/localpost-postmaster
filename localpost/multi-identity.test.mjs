import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { watch, writesUnder } from './fixtures/production-write-witness.mjs';
import { PRODUCTION_ROOT, createProductionWiring, identitiesConfig, identityCommands } from './dsh-wiring.mjs';
import { COMMANDS, SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { TOOL_NAMES } from './dsh-mail-tools.mjs';
import { bind } from './session-binding.mjs';
import { createMailbox } from './mailbox.mjs';
import { createReceiver } from './receiver.mjs';
import { removeTreeSync } from './temp-tree.mjs';

/**
 * 多身份接线（T1，2026-10-05）：一个 DSH 宿主同时服务 dsh 与其他身份（例：engineer）。
 * 夹具与 production-wiring.test.mjs 同形（假宿主命令/工具注册表 + 计数 receiver）；最后一组用例换成真实
 * receiver / 绑定 / 记账 / 适配器，只把宿主换成内存夹具。每个用例都在自己的临时根上跑，生产根只读核对。
 *
 * 2026-10-09：命令改成全宿主共用三条（作用于调用聊天所代表的身份，没代表任何身份时是 dsh），生产不再有
 * receiver 启停命令（随自动绑定自启）；让一个聊天成为某身份的收信聊天，用模型工具 localpost_bind_here
 * （唯一可以点名身份的地方，仍受"一个聊天只代表一个身份"约束）。
 */
const EVIDENCE = 'precheck:app.asar package.json 0.2.0-rc.2';

// 生产根只许读：本进程对它的任何写类调用都会被见证记下，最后一个用例断言为空（生产 receiver 自己的定时重写不算）。
watch(PRODUCTION_ROOT);

const TMP = path.resolve(import.meta.dirname, '../.localpost-tmp/multi-identity');
function rootFor(t) {
  fs.mkdirSync(TMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP, 'case-'));
  t.after(() => removeTreeSync(root));
  return root;
}

/** 假宿主：命令/工具注册表（同名二次注册抛错）、guard 链、在线聊天表；聊天的 followup 记账，用来数唤醒次数。 */
function fakeCtx() {
  const host = { commands: [], tools: [], guards: [], agents: new Map(), failRegister: null, followups: [] };
  const register = (list, kind) => definition => {
    if (list.some(entry => entry.name === definition.name)) throw new Error(`${kind} "${definition.name}" is already registered`);
    if (host.failRegister === definition.name) throw new Error('registry refused ' + definition.name);
    list.push(definition);
    return () => { const at = list.indexOf(definition); if (at >= 0) list.splice(at, 1); };
  };
  host.ctx = {
    agents: { get: id => host.agents.get(id) },
    commands: { register: register(host.commands, 'command'), find: (_agent, name) => host.commands.find(entry => entry.name === name) },
    tools: {
      register: register(host.tools, 'tool'),
      get: name => host.tools.find(entry => entry.name === name),
      guard: check => { host.guards.push(check); return () => { const at = host.guards.indexOf(check); if (at >= 0) host.guards.splice(at, 1); }; },
    },
  };
  return host;
}
const counts = host => [host.commands.length, host.tools.length, host.guards.length];
const chat = (host, id, cwd = 'C:/work/' + id) => {
  const agent = { session: { id, header: { cwd } }, async followup(message) { host.followups.push({ chat: id, message }); } };
  host.agents.set(id, agent);
  return agent;
};
const run = (host, name, agent) => host.commands.find(entry => entry.name === name).handler({ agent });
/** 像宿主那样调用工具：先过 guard 链，再执行对这个聊天生效的定义。 */
async function tool(host, name, args, agent) {
  const exec = { agent, name, callId: 'call-1' };
  const denial = host.guards.map(check => check(exec)).find(reason => reason !== undefined);
  if (denial !== undefined) throw Object.assign(new Error(denial), { code: 'GUARD_DENIED' });
  return host.ctx.tools.get(name).execute(args, exec);
}
/** 用户在这个聊天里说「把 <身份> 的收信切到这里」：模型调 localpost_bind_here。 */
const bindAs = (host, agent, identity) => tool(host, 'localpost_bind_here', identity === undefined ? {} : { identity }, agent);
/** 等一个异步结果（切换后立即自启的 receiver），最多一秒。 */
async function until(check, label) {
  for (let round = 0; round < 100; round += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for ' + label);
}

/** 计数 receiver：按身份分别记，什么都不碰。 */
function fakeReceivers({ stopFailsFor = null } = {}) {
  const seen = new Map();
  const factory = options => {
    const mine = { options, construct: 1, start: 0, stop: 0, watching: false };
    seen.set(options.agent, mine);
    return {
      async start() { mine.start += 1; mine.watching = true; },
      async stop() { mine.stop += 1; mine.watching = false; if (stopFailsFor === options.agent) throw new Error('stop failed'); },
      diagnostics: () => ({ running: mine.watching, dispatchEnabled: false, lastError: undefined }),
    };
  };
  return { factory, seen };
}

function wire(t, host, { identities = [{ identity: 'engineer', allowFrom: ['dsh'] }], receivers = fakeReceivers(), root = rootFor(t), extra = {} } = {}) {
  const wiring = createProductionWiring({
    ctx: host.ctx, runtimeVersion: SUPPORTED_VERSION, versionEvidence: EVIDENCE, productionRoot: root, receiverFactory: receivers.factory,
    config: { enabled: true, root, allowFrom: ['codex'], scanIntervalMs: 3600000, debounceMs: 60, identities, ...extra },
  });
  // 断言中途失败也要停掉真实 receiver 的定时器，否则测试进程退不出（dispose 幂等，用例里显式调用过也无妨）。
  t.after(() => wiring.dispose());
  return { wiring, receivers, root };
}
const AUTHORITY = Object.freeze({ scope: 'analysis-reply', source: 'policy:test' });
const deliver = (root, from, envelope) => createMailbox({ root, identity: from })
  .deliver({ from, type: 'task', subject: 'please handle', body: 'do the thing', ...envelope });
const inboxIds = text => (text === 'LocalPost: the inbox is empty.' ? [] : text.split('\n').map(line => JSON.parse(line).id));

/* ------------------------------------------------------------------ 写入见证自检 */

test('写入见证自检：被测代码的写盘确实经过见证（拿一个临时根代替生产根演示）', async t => {
  const probe = rootFor(t);
  const stop = watch(probe);
  try { await deliver(probe, 'codex', { id: 'witness-probe', to: 'dsh' }); }
  finally { stop(); }
  const seen = writesUnder(probe);
  assert.equal(seen.some(line => line.includes('witness-probe')), true, '投信写盘没有被见证到：见证失效，生产零接触断言不可信 -> ' + JSON.stringify(seen));
});

/* ------------------------------------------------------------------ 配置：先校验，什么都不建不注册 */

test('配置解析只改形不校验：映射 → 列表，非映射原样交给装配去拒绝', () => {
  assert.deepEqual(identitiesConfig(undefined), []);
  assert.deepEqual(identitiesConfig(null), []);
  assert.deepEqual(identitiesConfig(''), []);
  assert.deepEqual(identitiesConfig({ engineer: { allowFrom: 'dsh,codex' } }), [{ identity: 'engineer', allowFrom: ['dsh', 'codex'] }]);
  assert.deepEqual(identitiesConfig({ engineer: { allowFrom: 'dsh, codex' } }), [{ identity: 'engineer', allowFrom: ['dsh', ' codex'] }], '不 trim：带空格的条目要走到严格校验');
  assert.deepEqual(identitiesConfig({ engineer: true }), [{ identity: 'engineer', allowFrom: undefined }]);
  assert.equal(identitiesConfig('engineer'), 'engineer');
  assert.deepEqual(identitiesConfig(['engineer']), ['engineer']);
});

test('身份命令名：生产没有按身份的命令；隔离入口的 E 命令里，其他身份的名字插在前缀后面', () => {
  assert.deepEqual(identityCommands('production', 'dsh'), { actions: {} });
  assert.deepEqual(identityCommands('production', 'engineer'), { actions: {} });
  assert.deepEqual(identityCommands('isolated', 'dsh').actions, { start: 'localpost-e-start', stop: 'localpost-e-stop', status: 'localpost-e-status' });
  assert.deepEqual(identityCommands('isolated', 'engineer').actions,
    { start: 'localpost-engineer-e-start', stop: 'localpost-engineer-e-stop', status: 'localpost-engineer-e-status' });
});

test('身份配置非法一律拒绝装配，且在构建 receiver、注册任何东西之前', t => {
  for (const [identities, reason, detail] of [
    ['engineer', 'identities_invalid'], [{ engineer: { allowFrom: ['dsh'] } }, 'identities_invalid'],
    [['engineer'], 'identity_invalid', 'undefined'],
    [[{ identity: 'Engineer', allowFrom: ['dsh'] }], 'identity_invalid', 'Engineer'],
    [[{ identity: 'eng.ineer', allowFrom: ['dsh'] }], 'identity_invalid', 'eng.ineer'],
    [[{ identity: '1engineer', allowFrom: ['dsh'] }], 'identity_invalid', '1engineer'],
    [[{ identity: 'e'.repeat(33), allowFrom: ['dsh'] }], 'identity_invalid', 'e'.repeat(33)],
    [[{ identity: '', allowFrom: ['dsh'] }], 'identity_invalid', ''],
    [[{ identity: 'dsh', allowFrom: ['codex'] }], 'identity_duplicate', 'dsh'],
    [[{ identity: 'engineer', allowFrom: ['dsh'] }, { identity: 'engineer', allowFrom: ['codex'] }], 'identity_duplicate', 'engineer'],
    [[{ identity: 'engineer' }], 'identity_allow_from_required', 'engineer'],
    [[{ identity: 'engineer', allowFrom: [] }], 'identity_allow_from_required', 'engineer'],
    [[{ identity: 'engineer', allowFrom: [' dsh'] }], 'identity_allow_from_invalid', 'engineer'],
    [[{ identity: 'engineer', allowFrom: ['dsh', ''] }], 'identity_allow_from_invalid', 'engineer'],
    [[{ identity: 'engineer', allowFrom: ['../dsh'] }], 'identity_allow_from_invalid', 'engineer'],
    [[{ identity: 'engineer', allowFrom: 'dsh' }], 'identity_allow_from_invalid', 'engineer'],
  ]) {
    const host = fakeCtx();
    const { wiring, receivers } = wire(t, host, { identities });
    assert.deepEqual([wiring.enabled, wiring.reason, wiring.detail], [false, reason, detail], JSON.stringify(identities));
    assert.deepEqual(counts(host), [0, 0, 0]);
    assert.equal(receivers.seen.size, 0, '被拒绝的配置不构建任何 receiver');
  }
});

/* ------------------------------------------------------------------ 装配形状 */

test('没有其他身份时与单身份接线完全一致：只有 dsh 一条通道、三条命令', t => {
  const host = fakeCtx();
  const { wiring, receivers } = wire(t, host, { identities: [] });
  assert.equal(wiring.enabled, true);
  assert.deepEqual(Object.keys(wiring.parts.identities), ['dsh']);
  assert.deepEqual(host.commands.map(entry => entry.name).sort(), Object.values(COMMANDS).sort());
  assert.equal(wiring.decisions.includes('identities_validated'), false);
  assert.deepEqual([...receivers.seen.keys()], ['dsh']);
  return wiring.dispose();
});

test('多一个身份：命令仍是共用的三条、工具仍是同一套（只有切换工具能点名身份），各 receiver 用各自白名单且都未启动', async t => {
  const host = fakeCtx();
  const { wiring, receivers } = wire(t, host);
  assert.equal(wiring.enabled, true);
  assert.equal(wiring.decisions.includes('identities_validated'), true);
  assert.deepEqual(Object.keys(wiring.parts.identities), ['dsh', 'engineer']);
  assert.deepEqual(host.commands.map(entry => entry.name).sort(), Object.values(COMMANDS).sort(), '不再按身份生成命令（以前 14 条）');
  for (const definition of host.commands) assert.deepEqual([definition.input, definition.recordInput], [undefined, false], definition.name);
  assert.deepEqual(host.tools.map(entry => entry.name).sort(), [...TOOL_NAMES].sort());
  for (const definition of host.tools) {
    const names = Object.hasOwn(definition.parameters.properties ?? {}, 'identity');
    assert.equal(names, ['localpost_bind_here', 'localpost_unbind'].includes(definition.name), definition.name + '：只有切换工具能点名身份');
    if (names) assert.deepEqual(definition.parameters.properties.identity.enum, ['dsh', 'engineer'], '只能点名本宿主服务的身份');
  }
  assert.equal(host.tools.some(entry => /start|stop|dispatch|enable/.test(entry.name)), false, '模型侧没有 receiver 启停工具');
  assert.equal(host.guards.length, 1);
  assert.deepEqual([...receivers.seen.keys()], ['dsh', 'engineer']);
  assert.deepEqual(receivers.seen.get('dsh').options.allowFrom, ['codex']);
  assert.deepEqual(receivers.seen.get('engineer').options.allowFrom, ['dsh'], '白名单按身份各写各的，不继承');
  assert.deepEqual([receivers.seen.get('dsh').start, receivers.seen.get('engineer').start], [0, 0]);
  await wiring.dispose();
  assert.deepEqual(counts(host), [0, 0, 0]);
});

/* ------------------------------------------------------------------ 绑定授权：一个聊天只代表一个身份 */

test('一个聊天只能代表一个身份：已代表别的身份的聊天绑定被拒，绑定记录不被写', async t => {
  const host = fakeCtx();
  const { wiring } = wire(t, host, { identities: [{ identity: 'engineer', allowFrom: ['dsh'] }, { identity: 'reviewer', allowFrom: ['dsh'] }] });
  const { store } = wiring.parts;
  const a = chat(host, 'chat-A');
  const e = chat(host, 'chat-E');
  assert.equal((await run(host, COMMANDS.bind, a)).kind, 'success', '没代表任何身份的聊天敲 /localpost-bind = 宿主身份 dsh');
  assert.match(await bindAs(host, a, 'engineer'), /已经是 dsh 的收信聊天/);
  assert.equal(await store.read('engineer'), null, '被拒绝的绑定什么都没写');
  assert.match(await bindAs(host, e, 'engineer'), /这个聊天现在是 engineer 的收信聊天/);
  assert.match(await bindAs(host, e, 'engineer'), /本来就是 engineer 的收信聊天/, '同一聊天重复绑定同一身份 = 无操作');
  assert.match(await bindAs(host, e, 'reviewer'), /已经是 engineer 的收信聊天/);
  assert.equal(await store.read('reviewer'), null);
  assert.match(await bindAs(host, e, 'dsh'), /已经是 engineer 的收信聊天/, '把宿主身份的收信搬进来同样受这条约束');
  // 共用命令作用于这个聊天所代表的身份：在 E 里敲 /localpost-bind 是 engineer 的（本来就是），不会去抢 dsh。
  assert.match((await run(host, COMMANDS.bind, e)).text, /本来就是 engineer 的收信聊天/);
  assert.equal((await store.read('dsh')).binding.session.id, 'chat-A');
  assert.equal((await store.read('engineer')).binding.session.id, 'chat-E');
  // 状态任何聊天都能看，列出每个身份。
  const shown = (await run(host, COMMANDS.status, e)).text;
  assert.match(shown, /dsh：收信聊天 = 另一个聊天（chat-A/);
  assert.match(shown, /engineer：收信聊天 = 这个聊天（chat-E）/);
  assert.match(shown, /reviewer：还没有收信聊天/);
  await wiring.dispose();
});

test('把一个身份的收信从 A 切到 B：只动这个身份，另一个身份的绑定原样不动', async t => {
  const host = fakeCtx();
  const { wiring } = wire(t, host);
  const { store } = wiring.parts;
  const a = chat(host, 'chat-A');
  const e = chat(host, 'chat-E');
  const b = chat(host, 'chat-B');
  assert.equal((await run(host, COMMANDS.bind, a)).kind, 'success');
  assert.match(await bindAs(host, e, 'engineer'), /现在是 engineer/);
  const engineerBefore = (await store.read('engineer')).binding;
  assert.match((await run(host, COMMANDS.bind, b)).text, /已把 dsh 的收信从聊天 chat-A 切到这个聊天/);
  assert.equal((await store.read('dsh')).binding.session.id, 'chat-B');
  assert.deepEqual((await store.read('engineer')).binding, engineerBefore);
  // 停 engineer 的自动收信可以在任何聊天里说（点名身份），也只停它自己的。
  assert.match(await tool(host, 'localpost_unbind', { identity: 'engineer' }, b), /已停止 engineer 的自动收信/);
  assert.deepEqual([(await store.read('engineer')).binding.mode, (await store.read('dsh')).binding.mode], ['manual', 'auto']);
  await wiring.dispose();
});

test('同一聊天同时发起两个身份的绑定：串行判定，恰好一个成功', async t => {
  const host = fakeCtx();
  const { wiring } = wire(t, host, { identities: [{ identity: 'engineer', allowFrom: ['dsh'] }, { identity: 'reviewer', allowFrom: ['dsh'] }] });
  const x = chat(host, 'chat-X');
  const answers = await Promise.all([bindAs(host, x, 'engineer'), bindAs(host, x, 'reviewer')]);
  assert.deepEqual(answers.map(answer => /现在是/.test(answer)).sort(), [false, true], answers.join(' | '));
  const named = [await wiring.parts.store.read('engineer'), await wiring.parts.store.read('reviewer')].filter(state => state?.binding.session.id === 'chat-X');
  assert.equal(named.length, 1, '绑定记录里只有一个身份指向这个聊天');
  await wiring.dispose();
});

/* ------------------------------------------------------------------ 工具：身份由调用者推出，永不跨信箱 */

/** dsh 与 engineer 各有一封"绑定前到达"的信（手动消费者的信），A 绑 dsh、E 绑 engineer，U 未绑定。 */
async function twoMailboxes(t) {
  const host = fakeCtx();
  const { wiring, root } = wire(t, host);
  await deliver(root, 'codex', { id: 'to-dsh-1', to: 'dsh' });
  await deliver(root, 'dsh', { id: 'to-eng-1', to: 'engineer' });
  const a = chat(host, 'chat-A');
  const e = chat(host, 'chat-E');
  const u = chat(host, 'chat-U');
  assert.equal((await run(host, COMMANDS.bind, a)).kind, 'success');
  assert.match(await bindAs(host, e, 'engineer'), /现在是 engineer/);
  return { host, wiring, root, a, e, u };
}

test('工具只服务调用聊天所代表身份的信箱：E 看 engineer，A 看 dsh，互相读不到', async t => {
  const { host, wiring, root, a, e, u } = await twoMailboxes(t);
  assert.match(await tool(host, 'localpost_status', {}, e), /engineer：收信聊天 = 这个聊天（chat-E）；自动收信：开/);
  assert.match(await tool(host, 'localpost_status', {}, a), /dsh：收信聊天 = 这个聊天（chat-A）；自动收信：开/);
  assert.deepEqual(inboxIds(await tool(host, 'localpost_inbox', {}, e)), ['to-eng-1']);
  assert.deepEqual(inboxIds(await tool(host, 'localpost_inbox', {}, a)), ['to-dsh-1']);
  // 按 id 硬读别的身份的信：在自己身份的信箱里找不到，什么都读不到。
  await assert.rejects(tool(host, 'localpost_read', { id: 'to-dsh-1' }, e), /letter not found/);
  await assert.rejects(tool(host, 'localpost_read', { id: 'to-eng-1' }, a), /letter not found/);
  await assert.rejects(tool(host, 'localpost_archive', { id: 'to-dsh-1' }, e), /letter not found/);
  await assert.rejects(tool(host, 'localpost_reply', { id: 'to-dsh-1', outcome: 'completed', body: 'x' }, e), /original letter not found/);
  // 未绑定的聊天仍是宿主身份（与多身份之前一致）：能读 dsh 的手动信，读不到 engineer 的。
  await assert.rejects(tool(host, 'localpost_read', { id: 'to-eng-1' }, u), /letter not found/);
  assert.match(await tool(host, 'localpost_read', { id: 'to-dsh-1' }, u), /do the thing/);
  await assert.rejects(tool(host, 'localpost_inbox', {}, u), { code: 'NOT_BOUND_CHAT' });
  // E 处理自己的信：回执以 engineer 身份发给 dsh，原信进 engineer 的 archive。
  assert.match(await tool(host, 'localpost_read', { id: 'to-eng-1' }, e), /do the thing/);
  const replied = JSON.parse(await tool(host, 'localpost_reply', { id: 'to-eng-1', outcome: 'completed', body: 'handled' }, e));
  assert.equal(replied.outcome, 'completed');
  const result = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'dsh', 'inbox', 'to-eng-1.result.json'), 'utf8'));
  assert.deepEqual([result.from, result.to, result.reply_to], ['engineer', 'dsh', 'to-eng-1']);
  assert.equal(fs.existsSync(path.join(root, 'agents', 'engineer', 'archive', 'to-eng-1.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'agents', 'dsh', 'inbox', 'to-dsh-1.json')), true, 'dsh 的信原地未动');
  await wiring.dispose();
});

test('一个聊天被两个身份的绑定同时点名（绕过命令写入）：工具拒绝而不是猜', async t => {
  const { wiring, a, u } = await twoMailboxes(t);
  // 绕过绑定命令直接写一条 reviewer 绑定、点名 dsh 的聊天 A（模拟手改或竞态），再用配了 reviewer 的装配读同一个根。
  const { root } = wiring.parts;
  await bind(wiring.parts.store, 'reviewer', { session: { host: 'local', id: 'chat-A', cwd: 'C:/work/chat-A' }, mode: 'auto', capacity: 50,
    authority: AUTHORITY, source: 'test:direct-write' });
  await wiring.dispose();
  const again = fakeCtx();
  for (const agent of [a, u]) again.agents.set(agent.session.id, agent);
  const { wiring: both } = wire(t, again, { root, identities: [{ identity: 'engineer', allowFrom: ['dsh'] }, { identity: 'reviewer', allowFrom: ['dsh'] }] });
  for (const name of TOOL_NAMES.filter(name => name !== 'localpost_status')) {
    await assert.rejects(tool(again, name, { id: 'to-dsh-1', outcome: 'completed', body: 'x' }, a), { code: 'IDENTITY_AMBIGUOUS' }, name);
  }
  // 状态只陈述事实、不代表任何身份：它正好让人看出 A 被两个身份同时点名。
  const shown = await tool(again, 'localpost_status', {}, a);
  assert.match(shown, /dsh：收信聊天 = 这个聊天（chat-A）/);
  assert.match(shown, /reviewer：收信聊天 = 这个聊天（chat-A）/);
  assert.match(await tool(again, 'localpost_read', { id: 'to-dsh-1' }, u), /do the thing/, '与此无关的聊天不受影响');
  await both.dispose();
});

test('任一身份的绑定状态读不出：所有聊天的信件工具一律拒绝（无法排除它点名的正是调用者），状态照实说出来', async t => {
  const { host, wiring, root, a, e, u } = await twoMailboxes(t);
  fs.writeFileSync(path.join(root, 'runtime', 'sessions', 'engineer.json'), '{ not json');
  for (const agent of [a, e, u]) {
    await assert.rejects(tool(host, 'localpost_read', { id: 'to-dsh-1' }, agent), { code: 'IDENTITY_UNRESOLVED' });
    await assert.rejects(tool(host, 'localpost_bind_here', {}, agent), { code: 'IDENTITY_UNRESOLVED' });
    const shown = await tool(host, 'localpost_status', {}, agent);
    assert.match(shown, /engineer：绑定记录读不出/);
    assert.match(shown, /dsh：收信聊天 = /, '读得出的身份照常列出');
  }
  assert.match(await bindAs(host, u, 'engineer'), /identity_unresolved/);
  assert.equal((await run(host, COMMANDS.bind, u)).kind, 'error', '共用命令同样无法判定这个聊天代表谁');
  await wiring.dispose();
});

/* ------------------------------------------------------------------ 自启：各管各的 receiver（生产没有启停命令了） */

test('生产的 receiver 随自动绑定立即自启，按身份各管各的；状态里看得到；卸载全部停掉', async t => {
  const host = fakeCtx();
  const { wiring, receivers } = wire(t, host);
  const lanes = wiring.parts.identities;
  assert.deepEqual([await lanes.dsh.autoStart, await lanes.engineer.autoStart], ['skipped_unbound', 'skipped_unbound'], '生产默认开 autoStart');
  const dsh = receivers.seen.get('dsh');
  const engineer = receivers.seen.get('engineer');
  const e = chat(host, 'chat-E');
  assert.match(await bindAs(host, e, 'engineer'), /现在是 engineer/);
  // 不等宿主下一次轮询：切换一落地就启动这个身份的 receiver。
  await until(() => lanes.engineer.receiver.status().running === true, 'engineer receiver');
  assert.deepEqual([dsh.start, engineer.start], [0, 1], '只启动被绑定的那个身份');
  assert.match((await run(host, COMMANDS.status, e)).text, /engineer：收信聊天 = 这个聊天（chat-E）；自动收信：开/);
  const a = chat(host, 'chat-A');
  assert.equal((await run(host, COMMANDS.bind, a)).kind, 'success');
  await until(() => lanes.dsh.receiver.status().running === true, 'dsh receiver');
  assert.deepEqual([dsh.start, engineer.start], [1, 1]);
  await wiring.dispose();
  assert.deepEqual([dsh.watching, engineer.watching, dsh.stop, engineer.stop], [false, false, 1, 1], '卸载停掉仍在跑的 receiver');
  assert.deepEqual(counts(host), [0, 0, 0]);
});

test('autoStart 按身份各自生效：后绑定的身份只启动它自己的 receiver；写 autoStart: false 才关', async t => {
  const host = fakeCtx();
  const { wiring, receivers } = wire(t, host);
  const lanes = wiring.parts.identities;
  await bind(wiring.parts.store, 'engineer', { session: { host: 'local', id: 'chat-E', cwd: 'C:/work/chat-E' }, mode: 'auto', capacity: 50,
    authority: AUTHORITY, source: 'test:direct-write' });
  assert.deepEqual([await lanes.dsh.retryAutoStart(), await lanes.engineer.retryAutoStart()], ['skipped_unbound', 'started']);
  assert.equal(await lanes.engineer.retryAutoStart(), 'already_running');
  assert.deepEqual([receivers.seen.get('dsh').start, receivers.seen.get('engineer').start], [0, 1]);
  assert.equal(wiring.parts.retryAutoStart, lanes.dsh.retryAutoStart, '旧字段仍指向宿主身份');
  await wiring.dispose();
  assert.equal(await lanes.engineer.retryAutoStart(), 'disposed');

  const off = wire(t, fakeCtx(), { extra: { autoStart: false } }).wiring;
  assert.deepEqual([await off.parts.identities.dsh.autoStart, await off.parts.identities.engineer.retryAutoStart()], ['disabled', 'disabled']);
  await off.dispose();
});

test('卸载时某个身份的 receiver 停不下来：其余照停、注册全部释放、错误留在该身份的状态里', async t => {
  const host = fakeCtx();
  const { wiring, receivers } = wire(t, host, { receivers: fakeReceivers({ stopFailsFor: 'engineer' }) });
  await wiring.parts.identities.dsh.receiver.start(null);
  await wiring.parts.identities.engineer.receiver.start(null);
  await wiring.dispose();
  assert.deepEqual(counts(host), [0, 0, 0]);
  assert.equal(receivers.seen.get('dsh').watching, false);
  assert.match(String(wiring.parts.identities.engineer.receiver.status().shutdownError), /stop failed/);
  assert.equal(wiring.parts.identities.dsh.receiver.status().shutdownError, undefined);
});

for (const name of [COMMANDS.unbind, COMMANDS.status]) {
  test(`注册在共用命令 ${name} 处失败：之前注册的全部回滚，重试成功`, async t => {
    const host = fakeCtx();
    host.failRegister = name;
    const { wiring } = wire(t, host);
    assert.equal(wiring.enabled, false);
    assert.deepEqual(counts(host), [0, 0, 0]);
    host.failRegister = null;
    const retry = wire(t, host).wiring;
    assert.equal(retry.enabled, true);
    await retry.dispose();
    assert.deepEqual(counts(host), [0, 0, 0]);
  });
}

/* ------------------------------------------------------------------ 端到端：真实 receiver / 记账 / 适配器 */

test('端到端：dsh 投给 engineer 的信只唤醒 engineer 的聊天一次，它读信回执后记为 completed', async t => {
  const host = fakeCtx();
  const instances = new Map();
  const quiet = () => ({ on() {}, close() {} });
  const receivers = { factory: options => { const receiver = createReceiver({ ...options, watch: quiet }); instances.set(options.agent, receiver); return receiver; } };
  const { wiring, root } = wire(t, host, { receivers });
  const a = chat(host, 'chat-A');
  const e = chat(host, 'chat-E');
  assert.equal((await run(host, COMMANDS.bind, a)).kind, 'success');
  assert.match(await bindAs(host, e, 'engineer'), /现在是 engineer/);
  // 两个 receiver 随绑定自启（start() 等首轮扫描结束才算 running）。两个身份同时自启时，首轮扫描会争同一把
  // 投递写锁，没抢到的那个首轮被跳过、还没记基线 —— 所以投信前各扫一次，把基线定在"空信箱"上。
  await until(() => wiring.parts.identities.dsh.receiver.status().running && wiring.parts.identities.engineer.receiver.status().running, 'both receivers');
  for (const identity of ['dsh', 'engineer']) assert.equal((await instances.get(identity).scan()).agent, identity, identity + ' 的基线已记下');

  await deliver(root, 'dsh', { id: 'eng-task-1', to: 'engineer' });
  await deliver(root, 'codex', { id: 'eng-task-2', to: 'engineer' });   // codex 不在 engineer 的白名单里
  await instances.get('dsh').scan();
  const scanned = await instances.get('engineer').scan();
  assert.equal(scanned.entries['eng-task-1'].state, 'submitted');
  assert.deepEqual([scanned.entries['eng-task-2'].state, scanned.entries['eng-task-2'].reason], ['denied', 'sender_not_allowed']);
  assert.equal(host.followups.length, 1, '只唤醒一次');
  assert.equal(host.followups[0].chat, 'chat-E', '唤醒的是 engineer 的绑定聊天');
  assert.match(host.followups[0].message.content[0].text, /"agent":"engineer","id":"eng-task-1"/);

  // 被唤醒的聊天用同一套工具处理：工具自动落在 engineer 的信箱；A 按 id 也读不到。
  await assert.rejects(tool(host, 'localpost_read', { id: 'eng-task-1' }, a), /letter not found/);
  assert.match(await tool(host, 'localpost_read', { id: 'eng-task-1' }, e), /do the thing/);
  assert.equal(JSON.parse(await tool(host, 'localpost_reply', { id: 'eng-task-1', outcome: 'completed', body: '已处理' }, e)).outcome, 'completed');
  const after = await instances.get('engineer').scan();
  assert.equal(after.entries['eng-task-1'].state, 'completed');
  assert.equal(host.followups.length, 1, '回执之后不再唤醒');
  await wiring.dispose();
  assert.deepEqual([instances.get('dsh').diagnostics().running, instances.get('engineer').diagnostics().running], [false, false]);
});

/* ------------------------------------------------------------------ 生产零接触 */

test('本进程从未写过真实生产信箱（调用期见证；生产 receiver 自己的定时重写不算在内）', () => {
  assert.deepEqual(writesUnder(PRODUCTION_ROOT), []);
});
