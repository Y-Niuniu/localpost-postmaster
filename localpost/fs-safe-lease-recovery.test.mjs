import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EMPTY_LOCK_GRACE_MS, acquireLease } from './fs-safe.mjs'
import { removeTree } from './temp-tree.mjs'

const roots = []
async function scratch(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'localpost-lease-' + name + '-'))
  roots.push(dir)
  return dir
}
test.after(async () => { for (const dir of roots) await removeTree(dir) })

const transient = code => Object.assign(new Error(code + ': injected'), { code })
const runOrphanWorker = (target) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'orphan-lock-worker.mjs'), target], { stdio: 'ignore' })
  child.on('error', reject)
  child.on('close', (code) => resolve(code))
})

test('a real process that dies after the exclusive create leaves an empty lock that is reported, not a permanent busy', async () => {
  const root = await scratch('orphan')
  const lock = path.join(root, '.orphan.lock')
  assert.equal(await runOrphanWorker(lock), 0, 'the orphan worker must exit cleanly')
  assert.equal(fs.readFileSync(lock, 'utf8'), '', 'the lock is left empty')

  const fresh = await acquireLease(root, { name: '.orphan.lock', staleMs: 1000 })
  assert.equal(fresh.acquired, false)
  assert.equal(fresh.reason, 'busy', 'a just-created empty lock is still being written')

  const aged = new Date(Date.now() - (EMPTY_LOCK_GRACE_MS + 2000))
  fs.utimesSync(lock, aged, aged)
  const stale = await acquireLease(root, { name: '.orphan.lock', staleMs: 1000 })
  assert.equal(stale.acquired, false)
  assert.equal(stale.reason, 'invalid_owner_needs_reconcile', 'an orphaned empty lock must surface as a fault, never block forever as busy')
  assert.equal(fs.existsSync(lock), true, 'the lock is reported, not silently stolen')
})

test('release retries a transient owner read and then removes the lock', async (t) => {
  const root = await scratch('release-read')
  const lock = path.join(root, '.rel.lock')
  const lease = await acquireLease(root, { name: '.rel.lock' })
  assert.equal(lease.acquired, true)
  const original = fsp.readFile
  let injected = 0
  t.mock.method(fsp, 'readFile', async (target, ...rest) => {
    if (String(target).endsWith('.rel.lock') && injected < 2) { injected += 1; throw transient('EPERM') }
    return original(target, ...rest)
  })
  const result = await lease.release()
  assert.deepEqual(result, { released: true })
  assert.equal(injected, 2, 'the transient read really happened')
  assert.equal(fs.existsSync(lock), false, 'the lock is gone')
})

test('release retries a transient unlink and then removes the lock', async (t) => {
  const root = await scratch('release-unlink')
  const lock = path.join(root, '.rel2.lock')
  const lease = await acquireLease(root, { name: '.rel2.lock' })
  const original = fsp.unlink
  let injected = 0
  t.mock.method(fsp, 'unlink', async (target, ...rest) => {
    if (String(target).endsWith('.rel2.lock') && injected < 2) { injected += 1; throw transient('EPERM') }
    return original(target, ...rest)
  })
  const result = await lease.release()
  assert.deepEqual(result, { released: true })
  assert.equal(injected, 2)
  assert.equal(fs.existsSync(lock), false)
})

test('an unconfirmable release fails loudly instead of pretending to succeed', async (t) => {
  const root = await scratch('release-fail')
  const lock = path.join(root, '.rel3.lock')
  const lease = await acquireLease(root, { name: '.rel3.lock' })
  t.mock.method(fsp, 'unlink', async (target, ...rest) => {
    if (String(target).endsWith('.rel3.lock')) throw transient('EPERM')
    return fsp.unlink.wrapped?.(target, ...rest)
  })
  await assert.rejects(lease.release(), (error) => error.code === 'LEASE_RELEASE_UNCERTAIN')
  assert.equal(fs.existsSync(lock), true, 'the lock is still there and the caller knows')
})

test('stale recovery survives a transient realpath refusal instead of throwing', async (t) => {
  const root = await scratch('reclaim')
  const lock = path.join(root, '.stale.lock')
  fs.writeFileSync(lock, JSON.stringify({ token: 'dead-owner', pid: 999999999, started_at: Date.now() - 60000 }), 'utf8')
  const original = fs.realpathSync.native
  let injected = 0
  t.mock.method(fs.realpathSync, 'native', (target, ...rest) => {
    if (injected < 1 && path.resolve(String(target)) === path.resolve(root)) { injected += 1; throw transient('EPERM') }
    return original(target, ...rest)
  })
  const lease = await acquireLease(root, { name: '.stale.lock', staleMs: 1000 })
  assert.equal(injected, 1, 'the transient refusal really happened during recovery')
  assert.equal(lease.acquired, false)
  assert.equal(lease.reason, 'busy', 'a transient refusal during recovery is a busy lock, never a throw')
})
