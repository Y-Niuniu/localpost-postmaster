import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const temporary = path.join(root, '.localpost-tmp', 'suite');
fs.mkdirSync(temporary, { recursive: true });
const tests = fs.readdirSync(path.join(root, 'localpost')).filter(x => x.endsWith('.test.mjs')).map(x => `localpost/${x}`);
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary } });
if (result.error) console.error(result.error.message);
if (result.status === 0) {
  const legacy = spawnSync(process.execPath, ['test/selftest.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, LOCALPOST_MAILBOX: path.join(root, 'localpost') } });
  if (legacy.error) console.error(legacy.error.message);
  process.exitCode = legacy.status ?? 1;
} else process.exitCode = result.status ?? 1;
