import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMailbox } from './mailbox.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/mcp-launch');
const launcherFile = path.join(import.meta.dirname, 'mcp-launch.mjs');
// 经批准的允许表（方案 ①，按实测收窄到 SystemRoot；MAILBOX_ENV_REPORT 只用于让 server 自报实际收到的变量名）。
// 启动层改允许表时，这里必须有意识地跟着改。
const ALLOWED = ['MAILBOX_ADMIN', 'MAILBOX_ENV_REPORT', 'MAILBOX_IDENTITY', 'MAILBOX_ROOT', 'MAILBOX_TOOLS', 'SystemRoot'];
// dsh 现有的父环境过滤（npm 版 dsh-subprocess 0.1.5-rc.1 与桌面版 app.asar 相同，2026-10-02 核对）：只按名字剔除这些。
const dshFilters = name => /KEY|PASSWORD|SECRET|TOKEN/i.test(name) || name.toUpperCase().startsWith('DSH_');
// 探针：名字都能通过上面的过滤，所以只能靠启动层挡住。PATH、USERPROFILE 等还会从测试进程的完整环境里一起带过去。
const PROBES = { MY_PASSPHRASE: 'probe-value-must-never-be-printed', HTTPS_PROXY: 'http://probe-proxy:8080',
  http_proxy: 'http://probe-proxy-lower:8080', OPENAI_ORG: 'probe-org' };

function tempDir(t) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(dir));
  return dir;
}
// 启动层只认同目录的 mcp-server.mjs，所以把它（可按 edits 做故障注入）和假 server 或真实 server 一起复制进临时目录。
function launcherCopy(t, { edits = [], realServer = false } = {}) {
  const dir = tempDir(t);
  let source = fs.readFileSync(launcherFile, 'utf8');
  for (const [from, to] of edits) {
    assert.ok(source.includes(from), 'the launcher no longer contains: ' + from);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path.join(dir, 'mcp-launch.mjs'), source);
  // The real server's whole import closure: mailbox.mjs also uses the claim ledger (session-binding, letter-claims).
  if (realServer) for (const name of ['mcp-server.mjs', 'mailbox.mjs', 'fs-safe.mjs', 'session-binding.mjs', 'letter-claims.mjs'])
    fs.copyFileSync(path.join(import.meta.dirname, name), path.join(dir, name));
  else fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'env-probe-server.mjs'), path.join(dir, 'mcp-server.mjs'));
  return path.join(dir, 'mcp-launch.mjs');
}
// 模拟宿主交给启动层的环境：完整父环境 + 探针 + 注册配置覆盖为空的代码加载变量 + 本次的 MAILBOX_* 设置。
function hostEnv(extra) {
  const env = { ...process.env, TEMP: tempRoot, TMP: tempRoot, ...PROBES, NODE_OPTIONS: '', OPENSSL_CONF: '' };
  for (const name of Object.keys(env)) if (/^MAILBOX_/i.test(name)) delete env[name];
  return { ...env, ...extra };
}
function launch(t, launcher, env, args = []) {
  const child = spawn(process.execPath, [launcher, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const run = { child, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { run.stdout += value; }); child.stderr.on('data', value => { run.stderr += value; });
  run.closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  run.exited = new Promise(resolve => child.on('exit', resolve));
  run.firstLine = new Promise(resolve => child.stdout.on('data', function first() {
    const end = run.stdout.indexOf('\n');
    if (end >= 0) { child.stdout.off('data', first); resolve(JSON.parse(run.stdout.slice(0, end))); }
  }));
  return run;
}
const rpc = calls => calls.map(value => JSON.stringify(value)).join('\n') + '\n';
const initialize = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-test', version: '0' } } });
const list = id => ({ jsonrpc: '2.0', id, method: 'tools/list' });
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const responses = run => (run.stdout.trim() ? run.stdout.trim().split('\n').map(line => JSON.parse(line)) : []);
const serverPid = stderr => Number(/^\[mcp-launch\] server pid=(\d+) /m.exec(stderr)?.[1]);
const letter = (extra = {}) => ({
  id: 'task-one', thread_id: 'thread-one', from: 'dsh', to: 'codex', type: 'task',
  subject: 'Analyze', body: 'Please review', budget: 'standard', created_at: '2026-10-01T10:00:00.000Z', ...extra,
});
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function until(condition, message, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, typeof message === 'function' ? message() : message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
// 进程树测试失败时也不留孤儿。
const reap = (t, ...pids) => t.after(() => { for (const pid of pids) if (alive(pid)) process.kill(pid); });

test('the server receives only allowlisted names: probes that pass the dsh filter, PATH and case variants are dropped', { timeout: 15000 }, async t => {
  for (const name of [...Object.keys(PROBES), 'PATH', 'USERPROFILE']) assert.equal(dshFilters(name), false, name + ' must be a name the dsh filter lets through');
  const launcher = launcherCopy(t);
  const env = hostEnv({ MAILBOX_ROOT: path.dirname(launcher), mailbox_identity: 'codex', MAILBOX_TOOLS: '', MAILBOX_ENV_REPORT: '1' });
  assert.ok(Object.keys(env).some(name => name.toUpperCase() === 'PATH'), 'the PATH probe must actually reach the launcher');
  const run = launch(t, launcher, env);
  const seen = await run.firstLine;
  run.child.stdin.end('exit\n');
  assert.equal(await run.closed, 0, run.stderr);
  // 小写 mailbox_identity 归一成 MAILBOX_IDENTITY；显式空串 MAILBOX_TOOLS 照传；没设置的 MAILBOX_ADMIN 不凭空出现；
  // 探针、PATH、USERPROFILE、TEMP 以及空的 NODE_OPTIONS / OPENSSL_CONF 全部不在（libuv 补变量的路径也被堵住）。
  assert.deepEqual(seen.names, ['MAILBOX_ENV_REPORT', 'MAILBOX_IDENTITY', 'MAILBOX_ROOT', 'MAILBOX_TOOLS', 'SystemRoot']);
  assert.ok(seen.names.every(name => ALLOWED.includes(name)));
  // 启动层报告的 pid 和入口与实际一致，且不写任何值。
  assert.equal(serverPid(run.stderr), seen.pid);
  assert.ok(run.stderr.includes('entry=' + path.join(path.dirname(launcher), 'mcp-server.mjs')), run.stderr);
  assert.ok(!run.stderr.includes(PROBES.MY_PASSPHRASE), 'values must never be reported');
});

test('through the launcher the real server finishes the handshake and all seven tools, and reports the names it actually received', { timeout: 15000 }, async t => {
  const root = tempDir(t);
  const admin = createMailbox({ root });
  await admin.deliver(letter());
  const run = launch(t, launcherFile, hostEnv({ MAILBOX_ROOT: root, mailbox_identity: 'codex', MAILBOX_ENV_REPORT: '1' }));
  run.child.stdin.end(rpc([
    initialize(1), { jsonrpc: '2.0', method: 'notifications/initialized' }, list(2),
    call(3, 'mailbox_rules'), call(4, 'mailbox_roster'), call(5, 'mailbox_inbox', { agent: 'codex' }), call(6, 'mailbox_read', { agent: 'codex', id: 'task-one' }),
    call(7, 'mailbox_send', { from: 'codex', to: 'dsh', type: 'task', subject: 'Ping', body: 'Generated id' }),
    call(8, 'mailbox_reply', { agent: 'codex', reply_to: 'task-one', body: 'Done', outcome: 'completed' }),
    call(9, 'mailbox_archive', { agent: 'codex', id: 'task-one' }),
  ]));
  assert.equal(await run.closed, 0, run.stderr);
  const out = responses(run);
  assert.deepEqual(out.map(response => response.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const response of out) assert.equal(response.error ?? response.result.isError, undefined, JSON.stringify(response));
  assert.match(out[0].result.instructions, /Identity: codex\./);
  assert.equal(out[1].result.tools.length, 7);
  assert.equal(JSON.parse(out[8].result.content[0].text).idempotent, true);
  assert.equal(admin.inbox('codex').length, 0);
  assert.equal(admin.inbox('dsh').length, 2, 'the reply and the letter sent with a generated id');
  // 这一行是 server 自己报的「实际收到」，不是启动层「准备传入」的名字。
  assert.match(run.stderr, /^\[mailbox-mcp\] env names: MAILBOX_ENV_REPORT,MAILBOX_IDENTITY,MAILBOX_ROOT,SystemRoot$/m);
  assert.ok(serverPid(run.stderr) > 0, run.stderr);
});

test('exit code 2 passes through: fail-closed settings still refuse to start, and the launcher takes no arguments', { timeout: 20000 }, async t => {
  const root = tempDir(t);
  const cases = [
    [{ MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex', MAILBOX_TOOLS: '' }, [], /Invalid MAILBOX_TOOLS/],
    [{ MAILBOX_ROOT: root }, [], /requires MAILBOX_IDENTITY/],
    [{ MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex' }, ['other-server.mjs'], /takes no arguments/],
  ];
  for (const [env, args, message] of cases) {
    const run = launch(t, launcherFile, hostEnv(env), args);
    run.child.stdin.end(args.length ? undefined : rpc([list(1)]));
    assert.equal(await run.closed, 2, message + ' stderr=' + run.stderr);
    assert.equal(run.stdout, '', 'nothing may reach the MCP stream');
    assert.match(run.stderr, message);
    if (args.length) assert.doesNotMatch(run.stderr, /mailbox-mcp/, 'the server must not start');
  }
});

test('any other server exit code passes through the launcher unchanged', { timeout: 15000 }, async t => {
  const run = launch(t, launcherCopy(t), hostEnv({ MAILBOX_IDENTITY: 'codex' }));
  await run.firstLine;
  run.child.stdin.end('exit 7\n');
  assert.equal(await run.closed, 7, run.stderr);
});

test('MAILBOX_ADMIN and a non-empty MAILBOX_TOOLS keep their values and permission semantics behind the launcher', { timeout: 30000 }, async t => {
  const root = tempDir(t);
  await createMailbox({ root }).deliver(letter({ id: 'task-two', from: 'codex', to: 'dsh' }));
  const run = async (extra, calls) => {
    const launched = launch(t, launcherFile, hostEnv({ MAILBOX_ROOT: root, ...extra }));
    launched.child.stdin.end(rpc(calls));
    return { code: await launched.closed, stderr: launched.stderr, out: responses(launched) };
  };
  const text = response => response.result.content[0].text;
  // 限制名单（小写名也取得到）：列表只剩这两项，直接调用 mailbox_send 也被拒。
  const limited = await run({ MAILBOX_IDENTITY: 'codex', mailbox_tools: 'mailbox_inbox,mailbox_archive' },
    [list(1), call(2, 'mailbox_send', letter({ id: 'task-three', from: 'codex', to: 'dsh' })), call(3, 'mailbox_inbox', { agent: 'codex' })]);
  assert.equal(limited.code, 0, limited.stderr);
  assert.deepEqual(limited.out[0].result.tools.map(tool => tool.name), ['mailbox_inbox', 'mailbox_archive']);
  assert.equal(limited.out[1].result.isError, true);
  assert.match(text(limited.out[1]), /not allowed in this deployment: mailbox_send/);
  assert.equal(limited.out[2].result.isError, undefined, text(limited.out[2]));
  // 注册用的 MAILBOX_ADMIN='0' + 身份：仍是身份绑定模式，跨身份操作被拒。
  const bound = await run({ MAILBOX_IDENTITY: 'codex', MAILBOX_ADMIN: '0' }, [initialize(1), call(2, 'mailbox_archive', { agent: 'dsh', id: 'task-two' })]);
  assert.equal(bound.code, 0, bound.stderr);
  assert.match(bound.out[0].result.instructions, /Identity: codex\./);
  assert.match(text(bound.out[1]), /does not own mailbox/);
  // MAILBOX_ADMIN='1' 且不绑定身份：显式管理员模式；'0' 且不绑定身份：拒绝启动。
  const admin = await run({ MAILBOX_ADMIN: '1' }, [initialize(1)]);
  assert.equal(admin.code, 0, admin.stderr);
  assert.match(admin.out[0].result.instructions, /administrator mode/);
  const unbound = await run({ MAILBOX_ADMIN: '0' }, [initialize(1)]);
  assert.equal(unbound.code, 2);
  assert.match(unbound.stderr, /requires MAILBOX_IDENTITY/);
  assert.ok(fs.existsSync(path.join(root, 'agents/dsh/inbox/task-two.json')), 'nothing outside the permissions was touched');
  assert.equal(fs.existsSync(path.join(root, 'agents/dsh/inbox/task-three.json')), false);
});

test('NODE_OPTIONS and OPENSSL_CONF must be cleared by the host: the launcher refuses them, but a preload has already run', { timeout: 20000 }, async t => {
  const dir = tempDir(t);
  const marker = path.join(dir, 'preload.marker');
  const preload = '--require=' + path.join(import.meta.dirname, 'fixtures', 'preload-marker.cjs');
  const config = path.join(dir, 'empty.cnf');
  fs.writeFileSync(config, '');
  const base = { MAILBOX_ROOT: dir, MAILBOX_IDENTITY: 'codex', LP_PRELOAD_MARKER: marker };
  for (const [name, value] of [['NODE_OPTIONS', preload], ['OPENSSL_CONF', config]]) {
    const run = launch(t, launcherFile, hostEnv({ ...base, [name]: value }));
    run.child.stdin.end(rpc([list(1)]));
    assert.equal(await run.closed, 2, run.stderr);
    assert.equal(run.stdout, '', 'nothing may reach the MCP stream');
    assert.match(run.stderr, new RegExp('must clear ' + name));
    assert.doesNotMatch(run.stderr, /mailbox-mcp/, 'the server must not start');
  }
  // 预加载在启动层自己的代码之前就执行了：启动层只能事后拒绝，挡不住 —— 只能靠宿主在建进程前清掉。
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preload ran before the launcher');
  fs.rmSync(marker);
  // 宿主按注册配置覆盖为空（父环境里另有一份小写 node_options 也压得住）：预加载不再执行，server 正常工作。
  const run = launch(t, launcherFile, { ...hostEnv(base), node_options: preload, NODE_OPTIONS: '' });
  run.child.stdin.end(rpc([initialize(1), list(2)]));
  assert.equal(await run.closed, 0, run.stderr);
  assert.equal(responses(run)[1].result.tools.length, 7);
  assert.equal(fs.existsSync(marker), false, 'a cleared NODE_OPTIONS must not preload anything');
});

test('path 1 alone: killing the launcher the way the SDK closes it (TerminateProcess on Windows) also ends the server', { timeout: 15000 }, async t => {
  // 假 server 只认 `exit` 行，stdin 断开也不会自己退出；启动层被硬杀时也来不及跑 'exit' 处理。
  // 所以 server 若结束，只能是第 1 条路径（非 detached）。对照：改成 detached 时这个测试会失败。
  const run = launch(t, launcherCopy(t), hostEnv({ MAILBOX_IDENTITY: 'codex' }));
  const { pid } = await run.firstLine;
  reap(t, pid);
  assert.equal(alive(pid), true, 'the server must be running before the launcher is killed');
  run.child.kill();
  await run.exited;
  await until(() => !alive(pid), 'the server outlived its launcher: pid ' + pid);
});

test('path 2 alone: a launcher that dies from a JavaScript error ends the server first, even without the job object', { timeout: 15000 }, async t => {
  // 故障注入：去掉第 1 条路径（改成 detached），启动 1.5 秒后让启动层抛出未捕获异常。假 server 不认 EOF，只有 'exit' 里的清理能结束它。
  const launcher = launcherCopy(t, { edits: [['detached: false', 'detached: true'],
    ["child.on('spawn', () => {", "child.on('spawn', () => { setTimeout(() => { throw new Error('injected launcher crash'); }, 1500);"]] });
  const run = launch(t, launcher, hostEnv({ MAILBOX_IDENTITY: 'codex' }));
  const { pid } = await run.firstLine;
  reap(t, pid);
  assert.equal(await run.exited, 1, run.stderr);
  assert.match(run.stderr, /injected launcher crash/);
  await until(() => !alive(pid), 'the server outlived a crashed launcher: pid ' + pid);
});

test('path 3 alone: without the job object the real server still exits on the EOF the host delivers when the launcher dies', { timeout: 15000 }, async t => {
  // 故障注入：去掉第 1 条路径（detached）；硬杀启动层，第 2 条路径也不会运行。剩下的只有：宿主关掉 stdin → 真实 server 读到 EOF 后退出。
  const launcher = launcherCopy(t, { edits: [['detached: false', 'detached: true']], realServer: true });
  const run = launch(t, launcher, hostEnv({ MAILBOX_ROOT: tempDir(t), MAILBOX_IDENTITY: 'codex', MAILBOX_ENV_REPORT: '1' }));
  await until(() => /\[mailbox-mcp\] ready/.test(run.stderr) && serverPid(run.stderr) > 0, () => 'the server never became ready: ' + run.stderr, 10000);
  const pid = serverPid(run.stderr);
  reap(t, pid);
  run.child.kill();
  await run.exited;
  await until(() => !alive(pid), 'the real server did not exit on EOF: pid ' + pid);
});

test('if the host itself dies (as when dsh crashes), the launcher and the server both end', { timeout: 15000 }, async t => {
  const launcher = launcherCopy(t);
  const host = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'fake-host.mjs'), launcher],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: hostEnv({ MAILBOX_IDENTITY: 'codex' }) });
  t.after(() => { if (host.exitCode === null) host.kill(); });
  let output = '';
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', value => { output += value; });
  await until(() => output.includes('\n'), 'the fake host never reported its process tree', 10000);
  const tree = JSON.parse(output.slice(0, output.indexOf('\n')));
  reap(t, tree.launcher, tree.server);
  assert.ok(alive(tree.launcher) && alive(tree.server), 'the whole tree must be running before the host dies');
  host.kill();
  await until(() => !alive(tree.launcher) && !alive(tree.server),
    () => `orphans left behind: launcher ${tree.launcher} alive=${alive(tree.launcher)}, server ${tree.server} alive=${alive(tree.server)}`);
});
