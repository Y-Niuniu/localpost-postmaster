import fs from 'node:fs/promises'
import path from 'node:path'
import { acquireLease } from '../fs-safe.mjs'

// Race worker: hammer one lock and report the outcome distribution to a file, so the parent
// never has to capture this process's stdio. Used to prove that concurrent acquisition never
// throws and never misreports a transient lock state as corruption.
const root = process.argv[2]
const iterations = Number(process.argv[3] || 100)
const leaseName = process.argv[4] || '.race.lock'
const reportFile = process.argv[5] || path.join(root, 'worker-' + process.pid + '.json')
const tally = { acquired: 0, busy: 0, invalid_owner_needs_reconcile: 0, recovery_busy_needs_reconcile: 0, other: 0 }
const errors = []
const stacks = []
for (let index = 0; index < iterations; index += 1) {
  try {
    const lease = await acquireLease(root, { name: leaseName, staleMs: 1000 })
    if (lease.acquired) { tally.acquired += 1; await lease.release(); continue }
    if (Object.hasOwn(tally, lease.reason)) tally[lease.reason] += 1
    else { tally.other += 1; errors.push('unexpected reason: ' + lease.reason) }
  } catch (error) {
    errors.push(error.code || error.message)
    if (stacks.length < 3) stacks.push(String(error.stack || error))
  }
}
await fs.writeFile(reportFile, JSON.stringify({ tally, errors, stacks }), 'utf8')
