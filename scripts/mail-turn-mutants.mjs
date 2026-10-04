/**
 * Mutation run for the mail-turn allowlist (C1): seed each defect back into localpost/dsh-mail-tools.mjs, run the
 * allowlist and mail-tool tests, restore the file. A mutant must be KILLED (some test fails); a survivor means the
 * tests cannot tell that defect from the real code.
 *
 *   node scripts/mail-turn-mutants.mjs
 *
 * It edits the tracked source in place, so it refuses to start unless that file is unmodified in git: an interrupted
 * run is then always undone by `git checkout -- localpost/dsh-mail-tools.mjs`. The file is restored after every mutant
 * and in a finally block, and its sha256 is compared at the end. Exit 0 only when every mutant applied and was killed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const relative = 'localpost/dsh-mail-tools.mjs';
const target = path.join(root, relative);
const clean = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', relative], { cwd: root });
if (clean.status !== 0) { console.log('REFUSED: ' + relative + ' differs from HEAD; commit or restore it first'); process.exit(2); }
const original = fs.readFileSync(target, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const tmp = path.join(root, '.localpost-tmp', 'suite');
fs.mkdirSync(path.join(tmp, 'dsh-home'), { recursive: true });
const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, DSH_HOME: path.join(tmp, 'dsh-home') };

const EXACT = "if (typeof name !== 'string' || !TOOL_NAMES.includes(name)) {";
const mutants = [
  ['M1', 'prefix instead of exact names (the b-probe defect)', EXACT, "if (typeof name !== 'string' || !name.startsWith('localpost_')) {"],
  ['M2', 'case-folded comparison', EXACT, "if (typeof name !== 'string' || !TOOL_NAMES.includes(name.toLowerCase())) {"],
  ['M3', 'trimmed / control-stripped comparison', EXACT, "if (typeof name !== 'string' || !TOOL_NAMES.includes(name.trim().replace(/[\\u0000-\\u001f\\u200b]/g, ''))) {"],
  ['M4', 'substring match', EXACT, "if (typeof name !== 'string' || !TOOL_NAMES.some(tool => name.includes(tool))) {"],
  ['M5', 'no registration identity check (the name alone admits)', 'if (!mine.has(effective)) {', 'if (false) {'],
  ['M6', 'no visibility check (message-level: the identity check still denies)', 'if (effective === undefined) {', 'if (false) {'],
  ['M7', 'no ours-registered check (message-level: the catch still denies)', 'if (!mine || mine.size === 0) {', 'if (false) {'],
  ['M8', 'fail-open catch', '  } catch (error) {\n    return MAIL_TURN_DENY_PREFIX', '  } catch (error) {\n    return undefined; MAIL_TURN_DENY_PREFIX'],
  ['M9', 'exec.name read twice', 'const mine = ours?.get(name);', 'const mine = ours?.get(exec.name);'],
  ['M10', 'non-string names coerced', EXACT, 'if (!TOOL_NAMES.includes(String(name))) {'],
  ['M11', 'identity checked in the global view instead of the caller\'s', 'const effective = tools.get(name, exec.agent);', 'const effective = tools.get(name);'],
];

let ok = true;
try {
  for (const [id, label, from, to] of mutants) {
    const parts = original.split(from);
    if (parts.length !== 2) { ok = false; console.log(`NOT-APPLIED ${id} (${parts.length - 1} matches) -- ${label}`); continue; }
    fs.writeFileSync(target, parts.join(to));
    const run = spawnSync(process.execPath, ['--test', 'localpost/mail-turn-allowlist.test.mjs', 'localpost/dsh-mail-tools.test.mjs'], { cwd: root, env, encoding: 'utf8' });
    fs.writeFileSync(target, original);
    const out = (run.stdout ?? '') + (run.stderr ?? '');
    const failed = [...new Set(out.split('\n').filter(line => line.startsWith('✖ ') && !line.startsWith('✖ failing tests'))
      .map(line => line.slice(2).replace(/ \(\d+(\.\d+)?ms\)$/, '').trim()))];
    const pass = /ℹ pass (\d+)/.exec(out)?.[1], fail = /ℹ fail (\d+)/.exec(out)?.[1];
    if (run.status === 0) ok = false;
    console.log(`${run.status === 0 ? 'SURVIVED' : 'KILLED  '} ${id} pass=${pass} fail=${fail} -- ${label}` + (failed.length ? `\n           by: ${failed.join(' | ')}` : ''));
  }
} finally {
  fs.writeFileSync(target, original);
}
const restored = sha(fs.readFileSync(target, 'utf8')) === sha(original);
console.log(`restored=${restored} mutants=${mutants.length}`);
process.exit(ok && restored ? 0 : 1);
