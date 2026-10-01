import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSnapshot, listSnapshots, verifySnapshot, restoreSnapshot, SNAPSHOT_SCHEMA } from './migrate.mjs';
import { removeTree } from './temp-tree.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-migrate-'));
  await fs.writeFile(path.join(root, 'ledger.json'), JSON.stringify({ schema: 'localpost-ledger-v0.2', envelopes: { a: { status: 'replied' } } }, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'alerts.json'), '{ "schema": "localpost-alerts-v1", "alerts": [] }\n');
  await fs.mkdir(path.join(root, 'agents/dsh/inbox'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents/dsh/inbox/task-1.json'), '{ "id": "task-1" }\n');
  return root;
}

test('迁移快照名独立且不可覆盖：同标签同毫秒第二次直接拒绝', async () => {
  const root = await fixture();
  try {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const first = await createSnapshot({ root, label: 'pre-migration', now });
    assert.equal(first.path, 'runtime/snapshots/2026-10-01T12-00-00-000Z-pre-migration');
    await assert.rejects(() => createSnapshot({ root, label: 'pre-migration', now }), /refusing to overwrite/);
    const second = await createSnapshot({ root, label: 'pre-migration', now: now + 1000 });
    assert.notEqual(first.path, second.path);
    assert.equal((await listSnapshots({ root })).length, 2);
    assert.equal(first.manifest.schema, SNAPSHOT_SCHEMA);
  } finally { await removeTree(root); }
});

test('快照字节保真：受管文件逐字节一致、哈希入清单、缺失项如实记录', async () => {
  const root = await fixture();
  try {
    const snap = await createSnapshot({ root });
    const dir = path.join(root, snap.path);
    assert.equal(await fs.readFile(path.join(dir, 'ledger.json'), 'utf8'), await fs.readFile(path.join(root, 'ledger.json'), 'utf8'));
    const entry = snap.manifest.managed.find((x) => x.name === 'ledger.json');
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.bytes, Buffer.byteLength(await fs.readFile(path.join(root, 'ledger.json'), 'utf8')));
    assert.equal(snap.manifest.managed.find((x) => x.name === 'postmaster.config.json').present, false);
    assert.deepEqual(snap.manifest.envelopes.map((x) => x.path), ['agents/dsh/inbox/task-1.json']);
    assert.match(snap.manifest.envelopes[0].sha256, /^[0-9a-f]{64}$/);
  } finally { await removeTree(root); }
});

test('verify 能发现快照被改动或缺失', async () => {
  const root = await fixture();
  try {
    const snap = await createSnapshot({ root });
    assert.equal((await verifySnapshot({ root, snapshot: snap.path })).ok, true);
    await fs.writeFile(path.join(root, snap.path, 'ledger.json'), '{ "tampered": true }\n');
    const tampered = await verifySnapshot({ root, snapshot: snap.path });
    assert.equal(tampered.ok, false);
    assert.ok(tampered.problems.some((p) => p.name === 'ledger.json' && /hash/.test(p.reason)));
    await fs.rm(path.join(root, snap.path, 'alerts.json'));
    const missing = await verifySnapshot({ root, snapshot: snap.path });
    assert.ok(missing.problems.some((p) => p.name === 'alerts.json' && /missing/.test(p.reason)));
  } finally { await removeTree(root); }
});

test('restore 默认只预览不写盘，apply 才写回，被篡改的快照拒绝恢复', async () => {
  const root = await fixture();
  try {
    const snap = await createSnapshot({ root });
    const original = await fs.readFile(path.join(root, 'ledger.json'), 'utf8');
    await fs.writeFile(path.join(root, 'ledger.json'), '{ "schema": "changed" }\n');
    const preview = await restoreSnapshot({ root, snapshot: snap.path });
    assert.equal(preview.dry_run, true);
    assert.ok(preview.plan.some((p) => p.name === 'ledger.json' && p.action === 'overwrite'));
    assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), '{ "schema": "changed" }\n');
    const applied = await restoreSnapshot({ root, snapshot: snap.path, apply: true });
    assert.deepEqual(applied.restored.slice().sort(), ['alerts.json', 'ledger.json']);
    assert.equal(applied.after.ok, true);
    assert.deepEqual(applied.targetVerified, { ok: true, checked: 2, mismatches: [] });
    assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), original);
    await fs.writeFile(path.join(root, snap.path, 'alerts.json'), '{}\n');
    await assert.rejects(() => restoreSnapshot({ root, snapshot: snap.path, apply: true }), /integrity check/);
  } finally { await removeTree(root); }
});

test('恢复持有信箱写锁：已有新鲜锁时跳过而不是硬写', async () => {
  const root = await fixture();
  try {
    const snap = await createSnapshot({ root });
    await fs.writeFile(path.join(root, '.mailbox-write.lock'), JSON.stringify({ token: 'other', pid: process.pid, started_at: Date.now() }));
    const result = await restoreSnapshot({ root, snapshot: snap.path, apply: true });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.restored, []);
  } finally { await removeTree(root); }
});
