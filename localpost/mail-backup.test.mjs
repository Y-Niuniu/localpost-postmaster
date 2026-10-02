import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { backupMailbox, listSnapshots, pruneSnapshots, restoreSnapshot, verifySnapshot } from './mail-backup.mjs'
import { removeTree } from './temp-tree.mjs'

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
  await fs.mkdir(path.join(root, 'agents', 'codex', 'archive'), { recursive: true })
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true })
  await fs.writeFile(path.join(root, 'agents', 'codex', 'inbox', 'a.json'), '{"id":"a"}\n', 'utf8')
  await fs.writeFile(path.join(root, 'agents', 'codex', 'archive', 'old.json'), '{"id":"old"}\n', 'utf8')
  await fs.writeFile(path.join(root, 'attachments', 'note.md'), '# note\n', 'utf8')
  await fs.writeFile(path.join(root, 'ledger.json'), '{"records":[]}\n', 'utf8')
  await fs.writeFile(path.join(root, 'postmaster.config.json'), '{"interval":15}\n', 'utf8')
  return root
}

test('backup writes a verified snapshot whose manifest matches the source', async () => {
  const source = await writeFixture(await scratch('src'))
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target, now: new Date('2026-10-02T00:00:00Z') })
  assert.equal(result.name, '2026-10-02T00-00-00-000Z')
  assert.equal(result.fileCount, 5)
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.expected, 5)
  const manifest = JSON.parse(await fs.readFile(path.join(result.snapshot, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'localpost-mail-backup-v1')
  assert.equal(manifest.file_count, 5)
  assert.deepEqual(manifest.files.map((x) => x.path), [
    'agents/codex/archive/old.json',
    'agents/codex/inbox/a.json',
    'attachments/note.md',
    'ledger.json',
    'postmaster.config.json',
  ])
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/)
})

test('backup excludes lock and tmp files and records them as skipped', async () => {
  const source = await writeFixture(await scratch('skip'))
  await fs.writeFile(path.join(source, '.postmaster.lock'), 'x', 'utf8')
  await fs.writeFile(path.join(source, 'ledger.json.tmp'), 'x', 'utf8')
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target })
  assert.equal(result.fileCount, 5)
  const reasons = result.skipped.map((x) => x.path + ':' + x.reason).sort()
  assert.deepEqual(reasons, ['.postmaster.lock:excluded pattern', 'ledger.json.tmp:excluded pattern'])
  await assert.rejects(fs.stat(path.join(result.snapshot, '.postmaster.lock')), { code: 'ENOENT' })
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

test('verify detects a tampered snapshot and leaves no staging debris', async () => {
  const source = await writeFixture(await scratch('tamper'))
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target })
  assert.equal((await verifySnapshot(result.snapshot)).ok, true)
  await fs.writeFile(path.join(result.snapshot, 'ledger.json'), '{"records":["tampered"]}\n', 'utf8')
  const after = await verifySnapshot(result.snapshot)
  assert.equal(after.ok, false)
  assert.deepEqual(after.differences, [{ path: 'ledger.json', reason: 'content mismatch' }])
  const listing = await listSnapshots(target)
  assert.equal(listing.snapshots.length, 1)
  assert.deepEqual(listing.incomplete, [])
})

test('restore reproduces the exact tree and refuses an existing destination', async () => {
  const source = await writeFixture(await scratch('restore-src'))
  const target = await scratch('dst')
  const result = await backupMailbox({ source, target })
  const dest = path.join(await scratch('out'), 'restored')
  const restored = await restoreSnapshot({ snapshot: result.snapshot, dest })
  assert.equal(restored.ok, true)
  assert.equal(restored.restored, 5)
  assert.equal(await fs.readFile(path.join(dest, 'agents', 'codex', 'inbox', 'a.json'), 'utf8'), '{"id":"a"}\n')
  await assert.rejects(restoreSnapshot({ snapshot: result.snapshot, dest }), /refusing to overwrite/)
})

test('prune keeps the newest snapshots and refuses while the newest is broken', async () => {
  const source = await writeFixture(await scratch('prune-src'))
  const target = await scratch('dst')
  const names = []
  for (const minute of ['00', '01', '02', '03']) {
    const result = await backupMailbox({ source, target, now: new Date('2026-10-0' + (Number(minute) + 1) + 'T00:00:00Z') })
    names.push(result.name)
  }
  const kept = await pruneSnapshots({ target, keep: 2 })
  assert.equal(kept.skipped, false)
  assert.deepEqual(kept.kept, [names[3], names[2]])
  assert.deepEqual(kept.removed, [names[1], names[0]])
  assert.equal((await listSnapshots(target)).snapshots.length, 2)

  const newest = path.join(target, names[3])
  await fs.writeFile(path.join(newest, 'ledger.json'), 'broken\n', 'utf8')
  const refused = await pruneSnapshots({ target, keep: 1 })
  assert.equal(refused.skipped, true)
  assert.match(refused.reason, /refusing to prune/)
  assert.equal((await listSnapshots(target)).snapshots.length, 2)
})

test('prune never removes the last remaining snapshot and rejects a bad keep', async () => {
  const source = await writeFixture(await scratch('last-src'))
  const target = await scratch('dst')
  await backupMailbox({ source, target })
  const result = await pruneSnapshots({ target, keep: 7 })
  assert.deepEqual(result.removed, [])
  assert.equal(result.kept.length, 1)
  await assert.rejects(pruneSnapshots({ target, keep: 0 }), /positive integer/)
  await assert.rejects(pruneSnapshots({ target, keep: 1.5 }), /positive integer/)
})

test('an interrupted staging directory is reported and never mistaken for a snapshot', async () => {
  const source = await writeFixture(await scratch('staging-src'))
  const target = await scratch('dst')
  await backupMailbox({ source, target })
  await fs.mkdir(path.join(target, '.staging-2026-10-02T00-00-01-000Z'))
  const listing = await listSnapshots(target)
  assert.equal(listing.snapshots.length, 1)
  assert.deepEqual(listing.incomplete, ['.staging-2026-10-02T00-00-01-000Z'])
  const prune = await pruneSnapshots({ target, keep: 1 })
  assert.equal(prune.skipped, false)
  assert.deepEqual(prune.incomplete, ['.staging-2026-10-02T00-00-01-000Z'])
})
