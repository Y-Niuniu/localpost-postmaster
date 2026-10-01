import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
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

test('同名并发创建只有一个成功：其余明确拒绝，且不触碰胜者的快照', async () => {
  const root = await fixture();
  try {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => createSnapshot({ root, label: 'race', now })));
    const won = settled.filter((x) => x.status === 'fulfilled');
    assert.equal(won.length, 1);
    for (const lost of settled.filter((x) => x.status === 'rejected')) assert.match(lost.reason.message, /refusing to overwrite/);
    const snap = won[0].value;
    assert.deepEqual((await listSnapshots({ root })).map((x) => x.path), [snap.path]);
    assert.deepEqual((await fs.readdir(path.join(root, snap.path))).sort(), ['alerts.json', 'ledger.json', 'manifest.json']);
    assert.equal((await verifySnapshot({ root, snapshot: snap.path })).ok, true);
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

test('非 UTF-8 字节原样快照与恢复：清单记录的是磁盘真实字节', async () => {
  const root = await fixture();
  try {
    const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x7d, 0x0a]);
    await fs.writeFile(path.join(root, 'postmaster.config.json'), raw);
    const snap = await createSnapshot({ root });
    const entry = snap.manifest.managed.find((x) => x.name === 'postmaster.config.json');
    assert.deepEqual({ bytes: entry.bytes, sha256: entry.sha256 }, { bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') });
    assert.deepEqual(await fs.readFile(path.join(root, snap.path, 'postmaster.config.json')), raw);
    await fs.writeFile(path.join(root, 'postmaster.config.json'), '{}\n');
    const applied = await restoreSnapshot({ root, snapshot: snap.path, apply: true });
    assert.equal(applied.targetVerified.ok, true);
    assert.deepEqual(await fs.readFile(path.join(root, 'postmaster.config.json')), raw);
  } finally { await removeTree(root); }
});

// 每一项都是对 manifest 的一种篡改：verify 必须 ok=false，restore --apply 必须拒绝且不写目标文件。
const MANIFEST_TAMPERING = {
  '空对象': () => ({}),
  '不是对象（数组）': () => [],
  '不是对象（null）': () => null,
  '缺 schema': ({ schema, ...m }) => m,
  'schema 不符': (m) => ({ ...m, schema: 'localpost-migration-snapshot-v0' }),
  '顶层多出未知字段': (m) => ({ ...m, note: 'x' }),
  '缺 root': ({ root, ...m }) => m,
  'label 非法': (m) => ({ ...m, label: '../x' }),
  'created_at 不是规范时间': (m) => ({ ...m, created_at: 'yesterday' }),
  '缺 managed': ({ managed, ...m }) => m,
  'managed 不是数组': (m) => ({ ...m, managed: {} }),
  'managed 为空': (m) => ({ ...m, managed: [] }),
  'managed 少一项': (m) => ({ ...m, managed: m.managed.slice(1) }),
  'managed 重复一项': (m) => ({ ...m, managed: [m.managed[0], m.managed[0], m.managed[2]] }),
  '受管项未知文件名': (m) => ({ ...m, managed: m.managed.map((x, i) => (i ? x : { ...x, name: 'evil.json' })) }),
  '受管项缺 present': (m) => ({ ...m, managed: m.managed.map(({ present, ...x }, i) => (i ? { present, ...x } : x)) }),
  'present 不是布尔': (m) => ({ ...m, managed: m.managed.map((x, i) => (i ? x : { ...x, present: 'yes' })) }),
  '受管项缺 sha256': (m) => ({ ...m, managed: m.managed.map(({ sha256, ...x }, i) => (i ? { ...x, sha256 } : x)) }),
  '受管项缺 bytes': (m) => ({ ...m, managed: m.managed.map(({ bytes, ...x }, i) => (i ? { ...x, bytes } : x)) }),
  'sha256 格式非法': (m) => ({ ...m, managed: m.managed.map((x, i) => (i ? x : { ...x, sha256: x.sha256.toUpperCase() })) }),
  'bytes 不是非负整数': (m) => ({ ...m, managed: m.managed.map((x, i) => (i ? x : { ...x, bytes: -1 })) }),
  '受管项多出未知字段': (m) => ({ ...m, managed: m.managed.map((x, i) => (i ? x : { ...x, extra: true })) }),
  '缺席项夹带字段': (m) => ({ ...m, managed: m.managed.map((x) => (x.present ? x : { ...x, bytes: 0 })) }),
  'bytes 被改（结构合法）': (m) => ({ ...m, managed: m.managed.map((x, i) => (i ? x : { ...x, bytes: x.bytes + 1 })) }),
  '全部伪造为缺席（结构合法）': (m) => ({ ...m, managed: m.managed.map(({ name }) => ({ name, present: false })) }),
  '缺 envelopes': ({ envelopes, ...m }) => m,
  '信封条目缺 sha256': (m) => ({ ...m, envelopes: m.envelopes.map(({ sha256, ...x }) => x) }),
  '信封路径越界': (m) => ({ ...m, envelopes: m.envelopes.map((x) => ({ ...x, path: '../outside.json' })) }),
  '信封条目重复': (m) => ({ ...m, envelopes: [m.envelopes[0], m.envelopes[0]] }),
};

test('manifest 严格校验：空对象、缺字段、未知结构一律 verify 失败，restore --apply 拒绝写回', async (t) => {
  const root = await fixture();
  try {
    const snap = await createSnapshot({ root });
    const manifestPath = path.join(root, snap.path, 'manifest.json');
    const original = await fs.readFile(manifestPath, 'utf8');
    await fs.writeFile(path.join(root, 'ledger.json'), '{ "schema": "changed" }\n');
    for (const [name, tamper] of Object.entries(MANIFEST_TAMPERING)) {
      await t.test(name, async () => {
        await fs.writeFile(manifestPath, JSON.stringify(tamper(JSON.parse(original)), null, 2) + '\n');
        const verified = await verifySnapshot({ root, snapshot: snap.path });
        assert.equal(verified.ok, false);
        assert.ok(verified.problems.length > 0);
        await assert.rejects(() => restoreSnapshot({ root, snapshot: snap.path, apply: true }), /integrity check/);
        assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), '{ "schema": "changed" }\n');
      });
    }
    await fs.writeFile(manifestPath, 'not json');
    await assert.rejects(() => verifySnapshot({ root, snapshot: snap.path }), /missing or unreadable/);
    await assert.rejects(() => restoreSnapshot({ root, snapshot: snap.path, apply: true }), /missing or unreadable/);
    assert.equal(await fs.readFile(path.join(root, 'ledger.json'), 'utf8'), '{ "schema": "changed" }\n');
    await fs.writeFile(manifestPath, original);
    assert.equal((await verifySnapshot({ root, snapshot: snap.path })).ok, true);
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
