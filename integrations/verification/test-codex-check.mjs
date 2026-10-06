/**
 * 自测 codex-check.mjs（半自动桥的判据）：
 *   ① 收件箱里有白名单来的 task → 必须输出 {"decision":"block","reason":…}
 *   ② 收件箱空 → 必须静默 exit 0（不打扰）
 *   ③ result 类型不触发（回执是给人看的）
 *   ④ 非白名单发件人不触发
 * 全程在临时根上进行，不碰真实信箱。
 *
 *   node C:\AI_ASSIST\work\scripts\test-codex-check.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/16548/.codex/localpost-wake/codex-check.mjs';
const T = path.resolve('C:/AI_ASSIST/work/tmp_codex_wake');
const INBOX = path.join(T, 'agents', 'codex', 'inbox');

fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(INBOX, { recursive: true });
fs.copyFileSync(SRC, path.join(T, 'codex-check.mjs'));
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify({
  identity: 'codex', mailboxRoot: 'C:/AI_ASSIST/work/tmp_codex_wake',
  allowFrom: ['dsh', 'claude'],
}, null, 2) + '\n');

const letter = (id, from, type = 'task') => ({
  id, thread_id: 'selftest', from, to: 'codex', type,
  subject: `自测 ${id}`, body: '正文', budget: 'standard', created_at: new Date().toISOString(),
});
const write = (env) => fs.writeFileSync(path.join(INBOX, `${env.id}.json`), JSON.stringify(env, null, 2));
const clear = () => fs.rmSync(INBOX, { recursive: true, force: true }) || fs.mkdirSync(INBOX, { recursive: true });
const run = () => spawnSync(process.execPath, [path.join(T, 'codex-check.mjs')], { encoding: 'utf8' });

const checks = [];
const record = (name, ok, detail) => { checks.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`); };

// ① 有白名单 task
write(letter('t-dsh', 'dsh'));
let r = run();
let parsed = null;
try { parsed = JSON.parse(r.stdout.trim()); } catch { /* 保持 null */ }
record('① 白名单 task → block + reason', r.status === 0 && parsed?.decision === 'block' && /t-dsh/.test(parsed.reason || ''), JSON.stringify(parsed).slice(0, 120));

// ③ result 不触发（在 t-dsh 仍存在时清空，只留 result）
clear(); write(letter('r-1', 'dsh', 'result'));
r = run();
record('③ result 不触发', r.status === 0 && r.stdout.trim() === '', JSON.stringify(r.stdout.trim()).slice(0, 60));

// ④ 非白名单发件人不触发
clear(); write(letter('t-stranger', 'stranger'));
r = run();
record('④ 非白名单发件人不触发', r.status === 0 && r.stdout.trim() === '', JSON.stringify(r.stdout.trim()).slice(0, 60));

// ② 空收件箱静默
clear();
r = run();
record('② 空收件箱 → 静默 exit 0', r.status === 0 && r.stdout.trim() === '' && r.stderr.trim() === '', `exit=${r.status}`);

fs.rmSync(T, { recursive: true, force: true });
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n小结：${checks.length - failed}/${checks.length} 通过；临时根已删 ${T}`);
process.exitCode = failed === 0 ? 0 : 1;
