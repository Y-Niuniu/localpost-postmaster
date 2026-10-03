import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { acquireLease, assertId, safePath, atomicWrite, RENAME_ATTEMPTS } from './fs-safe.mjs';
import { removeTree } from './temp-tree.mjs';

test('exclusive lease has exactly one concurrent owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-lock-'));
  try {
    const leases = await Promise.all(Array.from({ length: 12 }, () => acquireLease(root)));
    assert.equal(leases.filter(x => x.acquired).length, 1);
    await Promise.all(leases.map(x => x.release()));
    const next = await acquireLease(root);
    assert.equal(next.acquired, true);
    await next.release();
  } finally { await removeTree(root); }
});

test('release cannot remove a replaced owner, and live old locks are not stolen', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-owner-'));
  try {
    const lease = await acquireLease(root, { now: 1 });
    assert.equal((await acquireLease(root, { now: Date.now() })).acquired, false);
    await fs.writeFile(path.join(root, '.postmaster.lock'), JSON.stringify({ token: 'replacement', pid: process.pid, started_at: 1 }));
    await lease.release();
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.postmaster.lock'))).token, 'replacement');
  } finally { await removeTree(root); }
});

test('paths reject traversal and linked escapes; writes use no shared temporary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-path-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-outside-'));
  try {
    for (const id of ['../x', 'a/b', 'a\\b', '.hidden', 'a:b']) assert.throws(() => assertId(id));
    for (const relative of ['../x', 'a/../../x', 'C:\\x']) assert.throws(() => safePath(root, relative));
    await fs.symlink(outside, path.join(root, 'escape'), 'junction');
    assert.throws(() => safePath(root, 'escape/x.json'), /escapes/);
    const target = safePath(root, 'safe/x.json');
    await Promise.all(Array.from({ length: 6 }, (_, i) => atomicWrite(target, JSON.stringify({ i }))));
    assert.ok(Number.isInteger(JSON.parse(await fs.readFile(target, 'utf8')).i));
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['x.json']);
  } finally {
    await removeTree(root);
    await removeTree(outside);
  }
});

test('stale dead ISO owner is recovered once, unknown owner is retained', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-stale-'));
  try {
    await fs.writeFile(path.join(root, '.postmaster.lock'), JSON.stringify({ token: 'old', pid: 2147483647, started_at: '2020-01-01T00:00:00Z' }));
    const leases = await Promise.all(Array.from({ length: 5 }, () => acquireLease(root)));
    assert.equal(leases.filter(x => x.acquired).length, 1);
    await Promise.all(leases.map(x => x.release()));
    await fs.writeFile(path.join(root, '.postmaster.lock'), '{bad');
    const unknown = await acquireLease(root);
    assert.equal(unknown.acquired, false);
    assert.match(unknown.reason, /reconcile/);
    assert.equal(await fs.readFile(path.join(root, '.postmaster.lock'), 'utf8'), '{bad');
  } finally { await removeTree(root); }
});

// 替换 rename 的故障注入放进子进程 fixture：测试进程里不改共享的内置模块方法。
const fault = (scenario, root) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'fs-safe-fault.mjs'), scenario, root],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`fixture ${scenario} exited ${code}: ${err}`)));
});

test('a transient replacing-rename refusal is retried within a bound and leaves no temporary', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-rename-'));
  t.after(() => removeTree(root));
  const r = await fault('rename-transient', root);
  assert.equal(r.refusalsLeft, 0);
  assert.deepEqual(r.content, { ok: true });
  assert.deepEqual(r.entries, ['x.json']);
});

test('a persistent rename refusal fails after the bound; other rename errors are not retried', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-rename-'));
  t.after(() => removeTree(root));
  const r = await fault('rename-persistent', root);
  assert.equal(r.attempts, RENAME_ATTEMPTS);
  assert.deepEqual(r.transient, { error: 'EPERM', calls: RENAME_ATTEMPTS, entries: [] });
  assert.deepEqual(r.other, { error: 'ENOENT', calls: 1, entries: [] });
});
