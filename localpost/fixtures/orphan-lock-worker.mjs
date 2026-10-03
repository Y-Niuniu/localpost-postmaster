import fs from 'node:fs'

// Simulates a process that dies between the exclusive lock create and the owner write:
// it creates the file with 'wx' and exits immediately, leaving an empty lock behind.
const target = process.argv[2]
const handle = fs.openSync(target, 'wx', 0o600)
fs.closeSync(handle)
process.exit(0)
