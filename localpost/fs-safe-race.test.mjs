import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safePath } from './fs-safe.mjs'
import { removeTree } from './temp-tree.mjs'

const WORKERS = 6
const ITERATIONS = 120
const worker = path.join(import.meta.dirname, 'fixtures', 'lease-race-worker.mjs')

function runWorker(root, tag) {
  const report = path.join(root, 'worker-' + tag + '.json')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, String(ITERATIONS), '.race.lock', report], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, report }))
  })
}

test('concurrent lease acquisition never throws and never calls a transient state corruption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-lease-race-'))
  try {
    const runs = await Promise.all(Array.from({ length: WORKERS }, (_, index) => runWorker(root, String(index))))
    for (const run of runs) assert.equal(run.code, 0, 'a race worker must exit cleanly')
    const reports = []
    for (const run of runs) reports.push(JSON.parse(await fs.readFile(run.report, 'utf8')))
    const sum = (key) => reports.reduce((total, report) => total + report.tally[key], 0)
    assert.deepEqual(reports.flatMap((report) => report.errors), [], 'a racing acquisition must never throw')
    assert.equal(sum('invalid_owner_needs_reconcile'), 0, 'a transient lock state must not be reported as a corrupt lock')
    assert.equal(sum('other'), 0, 'every reason must be a known one')
    assert.equal(sum('acquired') + sum('busy') + sum('recovery_busy_needs_reconcile'), WORKERS * ITERATIONS, 'every attempt must be accounted for')
    assert.ok(sum('acquired') >= WORKERS, 'the lock must actually be obtainable under contention')
  } finally {
    await removeTree(root)
  }
})

test('a junction that leaves the root is still rejected, and ordinary paths still resolve', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-link-root-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-link-outside-'))
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', path.join(root, 'escape'), outside], { stdio: 'ignore' })
    assert.throws(() => safePath(root, 'escape'), /Linked path escapes mailbox root/)
    await fs.mkdir(path.join(root, 'agents'))
    await fs.writeFile(path.join(root, 'agents', 'a.json'), '{}', 'utf8')
    assert.equal(safePath(root, 'agents/a.json'), path.resolve(root, 'agents', 'a.json'))
    assert.equal(safePath(root, 'not-created-yet.json'), path.resolve(root, 'not-created-yet.json'))
    assert.throws(() => safePath(root, '../outside.json'), /Path escapes mailbox root/)
  } finally {
    await removeTree(root)
    await removeTree(outside)
  }
})
