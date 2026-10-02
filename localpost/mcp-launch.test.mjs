import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMailbox } from './mailbox.mjs';
import { removeTreeSync } from './temp-tree.mjs';

const tempRoot = path.resolve(import.meta.dirname, '../.localpost-tmp/mcp-launch');
// 经批准的允许表（方案 ①，按实测收窄到 SystemRoot）。启动层改允许表时，这里必须有意识地跟着改。
const ALLOWED = ['MAILBOX_ADMIN', 'MAILBOX_IDENTITY', 'MAILBOX_ROOT', 'MAILBOX_TOOLS', 'SystemRoot'];
// dsh 现有的父环境过滤（npm 版 dsh-subprocess 0.1.5-rc.1 与桌面版 app.asar 相同，2026-10-02 核对）：只按名字剔除这些。
const dshFilters = name => /KEY|PASSWORD|SECRET|TOKEN/i.test(name) || name.toUpperCase().startsWith('DSH_');
// 探针：名字都能通过上面的过滤，所以只能靠启动层挡住。PATH、USERPROFILE 等还会从测试进程的完整环境里一起带过去。
const PROBES = { MY_PASSPHRASE: 'probe-value-must-never-be-printed', HTTPS_PROXY: 'http://probe-proxy:8080',
  http_proxy: 'http://probe-proxy-lower:8080', OPENAI_ORG: 'probe-org', NODE_OPTIONS: '--no-warnings' };

function tempDir(t) {
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  t.after(() => removeTreeSync(dir));
  return dir;
}
// 启动层只认同目录的 mcp-server.mjs，所以把它和假 server 一起复制进临时目录。
function probeCopy(t) {
  const dir = tempDir(t);
  fs.copyFileSync(path.join(import.meta.dirname, 'mcp-launch.mjs'), path.join(dir, 'mcp-launch.mjs'));
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'env-probe-server.mjs'), path.join(dir, 'mcp-server.mjs'));
  return dir;
}
// 模拟宿主交给启动层的环境：完整父环境 + 探针 + 本次的 MAILBOX_* 设置。
function hostEnv(extra) {
  const env = { ...process.env, TEMP: tempRoot, TMP: tempRoot, ...PROBES };
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
  run.firstLine = new Promise(resolve => child.stdout.on('data', function first() {
    const end = run.stdout.indexOf('\n');
    if (end >= 0) { child.stdout.off('data', first); resolve(JSON.parse(run.stdout.slice(0, end))); }
  }));
  return run;
}
function envReport(stderr) {
  const match = /^\[mcp-launch\] server pid=(\d+) entry=(.+) env=(.*)$/m.exec(stderr);
  assert.ok(match, 'MAILBOX_ENV_REPORT=1 must print a report line; stderr=' + stderr);
  return { pid: Number(match[1]), entry: match[2], names: match[3].split(',') };
}
const letter = (extra = {}) => ({
  id: 'task-one', thread_id: 'thread-one', from: 'dsh', to: 'codex', type: 'task',
  subject: 'Analyze', body: 'Please review', budget: 'standard', created_at: '2026-10-01T10:00:00.000Z', ...extra,
});

test('the server receives only allowlisted names: probes that pass the dsh filter, PATH and case variants are dropped', { timeout: 15000 }, async t => {
  for (const name of [...Object.keys(PROBES), 'PATH', 'USERPROFILE']) assert.equal(dshFilters(name), false, name + ' must be a name the dsh filter lets through');
  const dir = probeCopy(t);
  const env = hostEnv({ MAILBOX_ROOT: dir, mailbox_identity: 'codex', MAILBOX_TOOLS: '', MAILBOX_ENV_REPORT: '1' });
  assert.ok(Object.keys(env).some(name => name.toUpperCase() === 'PATH'), 'the PATH probe must actually reach the launcher');
  const run = launch(t, path.join(dir, 'mcp-launch.mjs'), env);
  const seen = await run.firstLine;
  run.child.stdin.end('exit\n');
  assert.equal(await run.closed, 0, run.stderr);
  // 小写 mailbox_identity 归一成 MAILBOX_IDENTITY；显式空串 MAILBOX_TOOLS 照传；没设置的 MAILBOX_ADMIN 不凭空出现；
  // 探针、PATH、USERPROFILE、TEMP 等全部不在（libuv 补变量的路径也被堵住）。
  assert.deepEqual(seen.names, ['MAILBOX_IDENTITY', 'MAILBOX_ROOT', 'MAILBOX_TOOLS', 'SystemRoot']);
  assert.ok(seen.names.every(name => ALLOWED.includes(name)));
  // 报告行与子进程实际收到的一致，且只有名字。
  const report = envReport(run.stderr);
  assert.equal(report.pid, seen.pid);
  assert.equal(report.entry, path.join(dir, 'mcp-server.mjs'));
  assert.deepEqual(report.names, seen.names);
  assert.ok(!run.stderr.includes(PROBES.MY_PASSPHRASE), 'values must never be reported');
});

test('through the launcher the real server finishes the MCP handshake and all seven tools with only SystemRoot and MAILBOX_*', { timeout: 15000 }, async t => {
  const root = tempDir(t);
  const admin = createMailbox({ root });
  await admin.deliver(letter());
  const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const run = launch(t, path.join(import.meta.dirname, 'mcp-launch.mjs'), hostEnv({ MAILBOX_ROOT: root, mailbox_identity: 'codex', MAILBOX_ENV_REPORT: '1' }));
  run.child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, 'mailbox_rules'), call(4, 'mailbox_roster'), call(5, 'mailbox_inbox', { agent: 'codex' }), call(6, 'mailbox_read', { agent: 'codex', id: 'task-one' }),
    call(7, 'mailbox_send', { from: 'codex', to: 'dsh', type: 'task', subject: 'Ping', body: 'Generated id' }),
    call(8, 'mailbox_reply', { agent: 'codex', reply_to: 'task-one', body: 'Done', outcome: 'completed' }),
    call(9, 'mailbox_archive', { agent: 'codex', id: 'task-one' }),
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal(await run.closed, 0, run.stderr);
  const responses = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.map(response => response.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const response of responses) assert.equal(response.error ?? response.result.isError, undefined, JSON.stringify(response));
  assert.match(responses[0].result.instructions, /Identity: codex\./);
  assert.equal(responses[1].result.tools.length, 7);
  assert.equal(JSON.parse(responses[8].result.content[0].text).idempotent, true);
  assert.equal(admin.inbox('codex').length, 0);
  assert.equal(admin.inbox('dsh').length, 2, 'the reply and the letter sent with a generated id');
  assert.deepEqual(envReport(run.stderr).names, ['MAILBOX_IDENTITY', 'MAILBOX_ROOT', 'SystemRoot']);
});

test('exit codes pass through: fail-closed settings still refuse to start, and the launcher takes no arguments', { timeout: 20000 }, async t => {
  const root = tempDir(t);
  const launcher = path.join(import.meta.dirname, 'mcp-launch.mjs');
  const cases = [
    [{ MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex', MAILBOX_TOOLS: '' }, [], /Invalid MAILBOX_TOOLS/],
    [{ MAILBOX_ROOT: root }, [], /requires MAILBOX_IDENTITY/],
    [{ MAILBOX_ROOT: root, MAILBOX_IDENTITY: 'codex' }, ['other-server.mjs'], /takes no arguments/],
  ];
  for (const [env, args, message] of cases) {
    const run = launch(t, launcher, hostEnv(env), args);
    run.child.stdin.end(args.length ? undefined : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    assert.equal(await run.closed, 2, message + ' stderr=' + run.stderr);
    assert.equal(run.stdout, '', 'nothing may reach the MCP stream');
    assert.match(run.stderr, message);
    if (args.length) assert.doesNotMatch(run.stderr, /mailbox-mcp/, 'the server must not start');
  }
});

test('killing the launcher the way the SDK closes it (TerminateProcess on Windows) also ends the server', { timeout: 15000 }, async t => {
  const dir = probeCopy(t);
  const run = launch(t, path.join(dir, 'mcp-launch.mjs'), hostEnv({ MAILBOX_ROOT: dir, MAILBOX_IDENTITY: 'codex' }));
  const { pid } = await run.firstLine;
  const alive = () => {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  t.after(() => { if (alive()) process.kill(pid); });
  assert.equal(alive(), true, 'the server must be running before the launcher is killed');
  // 假 server 只认 `exit` 行，stdin 断开也不会自己退出；它若结束，只能是被外部终止（job object）。
  // 对照实测：spawn 改成 detached（不进 job object）时，这个测试会失败。
  const exited = new Promise(resolve => run.child.on('exit', resolve));
  run.child.kill();
  await exited;
  const deadline = Date.now() + 5000;
  while (alive()) {
    assert.ok(Date.now() < deadline, 'the server outlived its launcher: pid ' + pid);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});
