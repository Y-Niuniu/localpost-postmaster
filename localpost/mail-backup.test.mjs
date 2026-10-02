import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SCHEMA, backupMailbox, listSnapshots, pruneSnapshots, restoreSnapshot, verifySnapshot } from './mail-backup.mjs'
import { removeTree } from './temp-tree.mjs'

const DAY = 24 * 60 * 60 * 1000
const roots = []

async function scratch(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-backup-' + name + '-'))
  roots.push(dir)
  return dir
}

test.after(async () => {
  for (const dir of roots) await removeTree(dir)
})

async function writeFixture(root) {
  await fs.mkdir(path.join(root, 'agents', 'codex', 'inbox'), { recursive: true })
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true })
  await fs.writeFile(path.join(root, 'agents', 'codex', 'inbox', 'a.json'), '{"id":"a"}\n', 'utf8')
  await fs.writeFile(path.join(root, 'attachments', 'note.md'), '# note\n', 'utf8')
  await fs.writeFile(path.join(root, 'ledger.json'), '{"records":[]}\n', 'utf8')
  return root
}

/**
 * Write a structurally valid snapshot by hand: manifest entries carry real
 * bytes and SHA-256, so the "newest must verify" gate behaves as in production
 * while created_at stays fully under the test's control.
 */
async function fakeSnapshot(target, name, options = {}) {
  const dir = path.join(target, name)
  await fs.mkdir(dir, { recursive: true })
  if (options.raw !== undefined) {
    await fs.writeFile(path.join(dir, 'manifest.json'), options.raw, 'utf8')
    return dir
  }
  const files = []
  for (const file of options.files || []) {
    const full = path.join(dir, ...file.path.split('/'))
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, file.body, 'utf8')
    files.push({ path: file.path, bytes: Buffer.byteLength(file.body), sha256: createHash('sha256').update(file.body).digest('hex') })
  }
  const manifest = {
    schema: SCHEMA,
    created_at: options.createdAt,
    source: 'test',
    file_count: files.length,
    total_bytes: files.reduce((sum, x) => sum + x.bytes, 0),
    excluded: [],
    skipped: [],
    files,
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString()
}

test('backup writes a verified snapshot whose manifest matches the source', async () => {
  const source = await writeFixture(await scratch('src'))
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target, now: new Date('2026-10-02T00:00:00Z') })
  assert.equal(result.name, '2026-10-02T00-00-00-000Z')
  assert.equal(result.fileCount, 3)
  assert.equal(result.verification.ok, true)
  const manifest = JSON.parse(await fs.readFile(path.join(result.snapshot, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'localpost-mail-backup-v1')
  assert.deepEqual(manifest.files.map((x) => x.path), ['agents/codex/inbox/a.json', 'attachments/note.md', 'ledger.json'])
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/)
})

test('backup excludes lock and tmp files and records them as skipped', async () => {
  const source = await writeFixture(await scratch('skip'))
  await fs.writeFile(path.join(source, '.postmaster.lock'), 'x', 'utf8')
  await fs.writeFile(path.join(source, 'ledger.json.tmp'), 'x', 'utf8')
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target })
  assert.equal(result.fileCount, 3)
  assert.deepEqual(result.skipped.map((x) => x.path + ':' + x.reason).sort(), ['.postmaster.lock:excluded pattern', 'ledger.json.tmp:excluded pattern'])
})

test('backup refuses to overwrite an existing snapshot name', async () => {
  const source = await writeFixture(await scratch('collide'))
  const target = await scratch('dst')
  const now = new Date('2026-10-02T00:00:00Z')
  await backupMailbox({ source, target, now })
  await assert.rejects(backupMailbox({ source, target, now }), /refusing to overwrite/)
})

test('backup rejects an empty source instead of publishing an empty snapshot', async () => {
  const source = await scratch('empty')
  const target = await scratch('dst')
  await assert.rejects(backupMailbox({ source, target }), /no files to back up/)
  assert.deepEqual(await fs.readdir(target), [])
})

test('verify detects a tampered snapshot and staging is reported separately', async () => {
  const source = await writeFixture(await scratch('tamper'))
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target })
  assert.equal((await verifySnapshot(result.snapshot)).ok, true)
  await fs.writeFile(path.join(result.snapshot, 'ledger.json'), '{"records":["tampered"]}\n', 'utf8')
  const after = await verifySnapshot(result.snapshot)
  assert.equal(after.ok, false)
  assert.deepEqual(after.differences, [{ path: 'ledger.json', reason: 'content mismatch' }])
  await fs.mkdir(path.join(target, '.staging-2026-10-02T00-00-01-000Z'))
  const listing = await listSnapshots(target)
  assert.equal(listing.snapshots.length, 1)
  assert.deepEqual(listing.staging, ['.staging-2026-10-02T00-00-01-000Z'])
  assert.deepEqual(listing.unreadable, [])
})

test('restore reproduces the exact tree and refuses an existing destination', async () => {
  const source = await writeFixture(await scratch('restore-src'))
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target })
  const dest = path.join(await scratch('out'), 'restored')
  const restored = await restoreSnapshot({ snapshot: result.snapshot, dest })
  assert.equal(restored.ok, true)
  assert.equal(restored.restored, 3)
  assert.equal(await fs.readFile(path.join(dest, 'agents', 'codex', 'inbox', 'a.json'), 'utf8'), '{"id":"a"}\n')
  await assert.rejects(restoreSnapshot({ snapshot: result.snapshot, dest }), /refusing to overwrite/)
})

test('retention is a time window: several snapshots from the same day all survive', async () => {
  const target = await scratch('dst')
  for (const hours of [20, 10, 1]) {
    await fakeSnapshot(target, 'aaa-' + hours, { createdAt: iso(hours * 60 * 60 * 1000), files: [{ path: 'ledger.json', body: 'body-' + hours }] })
  }
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.deepEqual(result.removed, [])
  assert.equal(result.kept.length, 3)
})

test('retention removes only what is older than the window, and never the newest', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'zzz-old', { createdAt: iso(9 * DAY), files: [{ path: 'ledger.json', body: 'old' }] })
  await fakeSnapshot(target, 'aaa-fresh', { createdAt: iso(2 * DAY), files: [{ path: 'ledger.json', body: 'fresh' }] })
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.deepEqual(result.removed, ['zzz-old'])
  assert.deepEqual(result.kept, ['aaa-fresh'])
})

test('ordering follows created_at, never the directory name', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'aaa-newest', { createdAt: iso(1 * DAY), files: [{ path: 'ledger.json', body: 'newest' }] })
  await fakeSnapshot(target, 'zzz-oldest', { createdAt: iso(30 * DAY), files: [{ path: 'ledger.json', body: 'oldest' }] })
  const listing = await listSnapshots(target)
  assert.deepEqual(listing.snapshots.map((x) => x.name), ['aaa-newest', 'zzz-oldest'])
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.deepEqual(result.removed, ['zzz-oldest'])
})

test('retention keeps the newest snapshot even when every snapshot is older than the window', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'snap-a', { createdAt: iso(30 * DAY), files: [{ path: 'ledger.json', body: 'a' }] })
  await fakeSnapshot(target, 'snap-b', { createdAt: iso(20 * DAY), files: [{ path: 'ledger.json', body: 'b' }] })
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.deepEqual(result.removed, ['snap-a'])
  assert.deepEqual(result.kept, ['snap-b'])
})

test('retention boundary: a snapshot created exactly at the cutoff is kept', async () => {
  const target = await scratch('dst')
  const now = new Date('2026-10-02T12:00:00.000Z')
  await fakeSnapshot(target, 'snap-exact', { createdAt: new Date(now.getTime() - 7 * DAY).toISOString(), files: [{ path: 'ledger.json', body: 'e' }] })
  await fakeSnapshot(target, 'snap-older', { createdAt: new Date(now.getTime() - 7 * DAY - 1).toISOString(), files: [{ path: 'ledger.json', body: 'o' }] })
  const result = await pruneSnapshots({ target, retentionDays: 7, now })
  assert.deepEqual(result.removed, ['snap-older'])
  assert.deepEqual(result.kept, ['snap-exact'])
})

test('an invalid created_at is never deleted and is reported for manual handling', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'snap-good', { createdAt: iso(1 * DAY), files: [{ path: 'ledger.json', body: 'g' }] })
  const broken = await fakeSnapshot(target, 'snap-broken-date', { createdAt: 'not-a-date', files: [{ path: 'ledger.json', body: 'b' }] })
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.equal(result.removed.includes('snap-broken-date'), false)
  assert.equal(result.anomalies.length, 1)
  assert.match(result.anomalies[0].reason, /invalid created_at/)
  await fs.stat(path.join(broken, 'manifest.json'))
})

test('a created_at in the future is kept and reported', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'snap-now', { createdAt: iso(0), files: [{ path: 'ledger.json', body: 'n' }] })
  await fakeSnapshot(target, 'snap-future', { createdAt: new Date(Date.now() + 3 * DAY).toISOString(), files: [{ path: 'ledger.json', body: 'f' }] })
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.equal(result.removed.includes('snap-future'), false)
  assert.equal(result.anomalies.length, 1)
  assert.match(result.anomalies[0].reason, /future/)
})

test('a snapshot with an unreadable manifest is reported and never deleted', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'snap-ok', { createdAt: iso(1 * DAY), files: [{ path: 'ledger.json', body: 'ok' }] })
  const raw = await fakeSnapshot(target, 'snap-raw', { raw: '{ not json' })
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.deepEqual(result.unreadable.map((x) => x.name), ['snap-raw'])
  assert.equal(result.removed.length, 0)
  await fs.stat(path.join(raw, 'manifest.json'))
})

test('prune refuses when no snapshot exposes a usable created_at', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'snap-x', { createdAt: 'nope', files: [{ path: 'ledger.json', body: 'x' }] })
  await fakeSnapshot(target, 'snap-y', { createdAt: 'also-nope', files: [{ path: 'ledger.json', body: 'y' }] })
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.equal(result.skipped, true)
  assert.match(result.reason, /refusing to prune/)
  assert.equal(result.removed.length, 0)
  assert.equal(result.anomalies.length, 2)
})

test('prune refuses to run while the newest snapshot fails verification', async () => {
  const target = await scratch('dst')
  await fakeSnapshot(target, 'snap-old', { createdAt: iso(30 * DAY), files: [{ path: 'ledger.json', body: 'old' }] })
  const newest = await fakeSnapshot(target, 'snap-newest', { createdAt: iso(1 * DAY), files: [{ path: 'ledger.json', body: 'new' }] })
  await fs.writeFile(path.join(newest, 'ledger.json'), 'corrupted', 'utf8')
  const result = await pruneSnapshots({ target, retentionDays: 7 })
  assert.equal(result.skipped, true)
  assert.match(result.reason, /refusing to prune/)
  assert.equal(result.removed.length, 0)
})

test('prune rejects a nonsensical retention window and reports an empty target', async () => {
  const target = await scratch('dst')
  await assert.rejects(pruneSnapshots({ target, retentionDays: -1 }), /non-negative/)
  await assert.rejects(pruneSnapshots({ target, retentionDays: Number.NaN }), /non-negative/)
  const empty = await pruneSnapshots({ target, retentionDays: 7 })
  assert.equal(empty.skipped, true)
  assert.equal(empty.reason, 'no snapshots')
})

test('backup honours the retention window end to end', async () => {
  const source = await writeFixture(await scratch('e2e-src'))
  const target = await scratch('dst')
  await backupMailbox({ source, target, now: new Date(Date.now() - 10 * DAY) })
  await backupMailbox({ source, target, now: new Date(Date.now() - 6 * DAY) })
  const result = await backupMailbox({ source, target, now: new Date() })
  const prune = await pruneSnapshots({ target, retentionDays: 7 })
  assert.equal(prune.removed.length, 1)
  assert.equal((await listSnapshots(target)).snapshots.length, 2)
  assert.equal((await verifySnapshot(result.snapshot)).ok, true)
})
