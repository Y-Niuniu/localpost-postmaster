/**
 * Mutation run for the mail-turn guard's lifecycle (C2): seed each defect back into the guard, the adapter or the
 * wiring, run the C2 tests, restore the file. Every mutant must be KILLED; a survivor means the tests cannot tell that
 * defect from the real code.
 *
 *   node scripts/mail-turn-guard-mutants.mjs
 *
 * It edits tracked sources in place, so it refuses to start unless every target file is unmodified in git: an
 * interrupted run is then always undone by `git checkout -- <file>`. Each file is restored after every mutant and in a
 * finally block, and its sha256 is compared at the end. Exit 0 only when every mutant applied and was killed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const GUARD = 'localpost/mail-turn-guard.mjs';
const ADAPTER = 'localpost/dsh-adapter.mjs';
const WIRING = 'localpost/dsh-wiring.mjs';
const TESTS = ['localpost/mail-turn-guard.test.mjs', 'localpost/dsh-adapter.test.mjs', 'localpost/dsh-wiring.test.mjs'];

const mutants = [
  ['G1', GUARD, 'restricts while still pending (before the claim)',
    "if (armament.state !== 'active') return undefined;", "if (armament.state === 'released') return undefined;"],
  ['G2', GUARD, 'never restricts', "try { return policy(exec); }", 'try { return undefined; }'],
  ['G3', GUARD, 'any turn/end of the session releases', 'if (event?.data?.turn === armament.turn) armament.release', 'if (true) armament.release'],
  ['G4', GUARD, 'a turn/end of another session releases',
    "if (armament.state !== 'active' || session !== agent.session || event?.type !== 'turn/end') return;",
    "if (armament.state !== 'active' || event?.type !== 'turn/end') return;"],
  ['G5', GUARD, 'cancel counts as the end (released at cancel)',
    "steps.push({ messageId, step: 'cancelled', turn: armament.turn });",
    "steps.push({ messageId, step: 'cancelled', turn: armament.turn }); armament.release('cancelled');"],
  ['G6', GUARD, 'a drain timeout disposes the guard',
    "const held = live.filter(armament => armament.state !== 'released');",
    "for (const armament of live) armament.release('timeout'); const held = live.filter(armament => armament.state !== 'released');"],
  ['G7', GUARD, 'cancel drops the user\'s queued input', "agent.cancel({ kind: 'hook', reason }, { keepInbox: true });", "agent.cancel({ kind: 'hook', reason }, {});"],
  ['G8', GUARD, 'a queued relay is not withdrawn', 'try { removed = agent.inbox?.remove?.(messageId) === true; }', 'try { removed = false; }'],
  ['G9', GUARD, 'the claim of any message activates',
    "if (armament.state !== 'pending' || payload?.message?.id !== messageId) return;", "if (armament.state !== 'pending') return;"],
  ['G10', GUARD, 'a discard after the claim releases',
    "if (armament.state === 'pending' && payload?.message?.id === messageId) armament.release('discarded-before-claim');",
    "if (payload?.message?.id === messageId) armament.release('discarded-before-claim');"],
  ['G11', GUARD, 'every child is refused during a mail turn', 'try { owned = agents?.isOwnedBy?.(child.id, armament.agent) === true; }', 'try { owned = true; }'],
  ['G12', GUARD, 'no child is refused', "if (owned) return 'an automatic mail turn may not create child agents", "if (false) return 'an automatic mail turn may not create child agents"],
  ['G13', GUARD, 'children are refused before the claim too', "if (armament.state !== 'active') continue;", 'if (false) continue;'],
  ['G14', GUARD, 'a failing policy admits', "catch (error) { return 'localpost-mail-turn: the policy failed", "catch (error) { return undefined; 'localpost-mail-turn: the policy failed"],
  ['G15', GUARD, 'a half-made armament is left behind',
    "for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* best effort: nothing was enqueued */ } }",
    '/* no cleanup */'],
  ['G16', GUARD, 'an unenqueued relay is released even when it waits in the inbox',
    "if (armament?.state === 'pending' && !inboxHolds(armament.agent, armament.messageId)) armament.release('never-enqueued');",
    "if (armament?.state === 'pending') armament.release('never-enqueued');"],
  ['G17', ADAPTER, 'the relay is enqueued before it is armed',
    'try { armament = mailTurnGuard.arm(agent, message.id); }', 'try { await agent.followup(message); armament = mailTurnGuard.arm(agent, message.id); }'],
  ['G18', ADAPTER, 'a guard that cannot be armed is ignored',
    "throw failure('guard_unavailable', 'The bound chat could not be put under the mail-turn guard; nothing was sent',",
    "if (false) throw failure('guard_unavailable', 'The bound chat could not be put under the mail-turn guard; nothing was sent',"],
  ['G19', ADAPTER, 'dispatch is enabled without a mail-turn guard',
    "mailTurnGuard: typeof mailTurnGuard?.arm === 'function' && typeof mailTurnGuard?.settleUnenqueued === 'function',", 'mailTurnGuard: true,'],
  ['G20', WIRING, 'unload skips the drain', 'lastDrain = await mailTurnGuard.drain({ timeoutMs: drainTimeoutMs });', 'lastDrain = { released: [], held: [], steps: [], idle: [] };'],
  ['G21', WIRING, 'the drain runs before the receiver is stopped',
    'try { await control.stop(); } catch (error) { shutdownError = error; }\n          try {\n            lastDrain = await mailTurnGuard.drain({ timeoutMs: drainTimeoutMs });',
    'try {\n            lastDrain = await mailTurnGuard.drain({ timeoutMs: drainTimeoutMs });\n            try { await control.stop(); } catch (error) { shutdownError = error; }'],
];

const targets = [...new Set(mutants.map(([, file]) => file))];
for (const file of targets) {
  const clean = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', file], { cwd: root });
  if (clean.status !== 0) { console.log('REFUSED: ' + file + ' differs from HEAD; commit or restore it first'); process.exit(2); }
}
const originals = new Map(targets.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const sha = text => createHash('sha256').update(text).digest('hex');
const tmp = path.join(root, '.localpost-tmp', 'suite');
fs.mkdirSync(path.join(tmp, 'dsh-home'), { recursive: true });
const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, DSH_HOME: path.join(tmp, 'dsh-home') };
const restoreAll = () => { for (const [file, text] of originals) fs.writeFileSync(path.join(root, file), text); };

let ok = true;
try {
  for (const [id, file, label, from, to] of mutants) {
    const original = originals.get(file);
    const parts = original.split(from);
    if (parts.length !== 2) { ok = false; console.log(`NOT-APPLIED ${id} (${parts.length - 1} matches in ${file}) -- ${label}`); continue; }
    fs.writeFileSync(path.join(root, file), parts.join(to));
    const run = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: root, env, encoding: 'utf8', timeout: 240000 });
    fs.writeFileSync(path.join(root, file), original);
    const out = (run.stdout ?? '') + (run.stderr ?? '');
    const failed = [...new Set(out.split('\n').filter(line => line.startsWith('✖ ') && !line.startsWith('✖ failing tests'))
      .map(line => line.slice(2).replace(/ \(\d+(\.\d+)?ms\)$/, '').trim()))];
    const pass = /ℹ pass (\d+)/.exec(out)?.[1], fail = /ℹ fail (\d+)/.exec(out)?.[1];
    if (run.status === 0) ok = false;
    console.log(`${run.status === 0 ? 'SURVIVED' : 'KILLED  '} ${id} pass=${pass} fail=${fail} [${file}] -- ${label}` + (failed.length ? `\n           by: ${failed.join(' | ')}` : ''));
  }
} finally {
  restoreAll();
}
const restored = [...originals].every(([file, text]) => sha(fs.readFileSync(path.join(root, file), 'utf8')) === sha(text));
console.log(`restored=${restored} mutants=${mutants.length}`);
process.exit(ok && restored ? 0 : 1);
