import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

const runOrphanWorker = (target) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'orphan-lock-worker.mjs'), target], { stdio: 'ignore' })
  child.on('error', reject)
  child.on('close', (code) => resolve(code))
})
// 故障注入全部放进子进程 fixture：测试进程里不替换任何共享的内置模块方法。
const fault = (scenario, root) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'fs-safe-fault.mjs'), scenario, root],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = '', err = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
  child.on('error', reject)
  child.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`fixture ${scenario} exited ${code}: ${err}`)))
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

test('a reclaim gate whose release cannot be confirmed fails loudly without stranding a main lock its live owner cannot release', async () => {
  const r = await fault('gate-release-exhausted', await scratch('gate'))
  assert.equal(r.first, 'LEASE_RELEASE_UNCERTAIN', 'the gate release failure is explicit, not swallowed')
  assert.ok(r.injected >= 1, 'the gate release really failed')
  assert.equal(r.afterFailure.mainLockIsOurs, false, 'no main lock is left that this live actor holds but has no lease to release')
  assert.equal(r.afterFailure.mainLockOwnerPid, null, 'the stale main lock was removed and not recreated before the gate was released')
  assert.equal(r.second, 'acquired', 'the main lock can be taken again without any manual cleanup')
  assert.equal(r.thirdWhileSecondHeld, 'busy', 'never two owners')
  assert.equal(r.mainLockAfterRelease, false)
  assert.equal(r.recoveryWithLeftoverGate, 'recovery_busy_needs_reconcile', 'the unreleased gate stays a visible fault for later stale recoveries')
  assert.equal(r.recoveryAfterGateHandled, 'acquired', 'once the gate fault is handled, stale recovery works again')
})

test('release retries a transient owner read and then removes the lock', async () => {
  const r = await fault('release-transient-read', await scratch('release-read'))
  assert.equal(r.acquired, true)
  assert.deepEqual(r.released, { released: true })
  assert.equal(r.injected, 2, 'the transient read really happened')
  assert.equal(r.lockExists, false, 'the lock is gone')
})

test('release retries a transient unlink and then removes the lock', async () => {
  const r = await fault('release-transient-unlink', await scratch('release-unlink'))
  assert.equal(r.acquired, true)
  assert.deepEqual(r.released, { released: true })
  assert.equal(r.injected, 2)
  assert.equal(r.lockExists, false)
})

test('an unconfirmable release fails loudly instead of pretending to succeed', async () => {
  const r = await fault('release-unconfirmable', await scratch('release-fail'))
  assert.equal(r.acquired, true)
  assert.equal(r.error, 'LEASE_RELEASE_UNCERTAIN')
  assert.equal(r.lockExists, true, 'the lock is still there and the caller knows')
})

test('stale recovery survives a transient realpath refusal in the reclaim phase instead of throwing', async () => {
  const r = await fault('reclaim-realpath-transient', await scratch('reclaim'))
  assert.equal(r.injectedAt, 2, 'the refusal was injected into the second root resolution, i.e. the reclaim gate path')
  assert.equal(r.rootCalls, 2, 'acquisition reached the reclaim phase and went no further')
  assert.equal(r.acquired, false)
  assert.equal(r.reason, 'busy', 'a transient refusal during recovery is a busy lock, never a throw')
  assert.equal(r.staleLockKept, true, 'nothing was reclaimed without the gate')
  assert.equal(r.gateExists, false, 'no gate was created')
})
