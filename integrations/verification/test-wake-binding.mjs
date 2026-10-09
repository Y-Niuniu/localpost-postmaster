/**
 * 自测"收信聊天开关"（2026-10-09）：wake-binding.mjs + localpost-switch.mjs + 四个桥脚本对绑定的遵守。
 *
 *   W1 decide() 的判定表（无文件 / 读不出 / 关 / 本聊天 / 别的聊天 / 待认领 / 过期）
 *   W2 claude：here 用 CLAUDE_CODE_SESSION_ID 精确绑定；status 认出"就是这个聊天"；重复 here 无改动；off
 *   W3 codex：here 拿不到会话 id ⇒ 登记待认领（30 分钟）
 *   W4 gemini：here 必须带 UUID 会话 id；不带时提示去 brain 目录找、并且什么都不写
 *   W5 codex-check：别的聊天静默、本聊天提醒、关掉静默、待认领被本聊天 Stop 认领、过期按旧行为
 *   W6 claude-check：--context / --rewake 只在被绑聊天里；--context 不认领，--rewake 认领
 *   W7 claude-wake：别的聊天不挂守望；被绑聊天接管别的聊天的活守望；绑定挪走后守望自己退出
 *   W8 gemini wake：关掉不发；绑定的会话优先于 config.json；没有绑定文件时用 config.json（旧行为）
 *
 * 隔离：全部在临时根里；子进程环境删掉 CLAUDE_CODE_SESSION_ID（本套件可能就在 Claude Code 里跑，不能把真实会话 id 带进去）；
 * gemini 一律 isolatedEnv（假 agentapi，永不真发）。
 *
 *   node integrations/verification/test-wake-binding.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SRC, TEST_CONVERSATION_ID, makeRoot, fakeAgentapi, isolatedEnv, readCalls } from './lib/harness.mjs';

const ROOTS = [];
const checks = [];
const record = (name, ok, detail = '') => { checks.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanEnv = (extra = {}) => { const env = { ...process.env, ...extra }; if (!Object.hasOwn(extra, 'CLAUDE_CODE_SESSION_ID')) delete env.CLAUDE_CODE_SESSION_ID; return env; };
const OTHER_UUID = '00000000-0000-4000-8000-000000000002';

/** 一个"部署好的桥目录"：config.json + 共用两件 + 指定的桥脚本，信箱根就是这个临时根。 */
function deployed(identity, scripts, config = {}) {
  const root = makeRoot('wake-' + identity);
  ROOTS.push(root);
  fs.mkdirSync(path.join(root, 'agents', identity, 'inbox'), { recursive: true });
  for (const file of ['wake-binding.mjs', 'localpost-switch.mjs']) fs.copyFileSync(path.join(SRC.shared, file), path.join(root, file));
  for (const [dir, file] of scripts) fs.copyFileSync(path.join(SRC[dir], file), path.join(root, file));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ identity, mailboxRoot: root, allowFrom: ['dsh'], ...config }, null, 2) + '\n');
  return root;
}
const letter = (root, identity, id) => fs.writeFileSync(path.join(root, 'agents', identity, 'inbox', id + '.json'), JSON.stringify({
  id, thread_id: 'wake-binding', from: 'dsh', to: identity, type: 'task', subject: 'self test ' + id, body: 'x', budget: 'standard', created_at: new Date().toISOString(),
}, null, 2));
const bindingOf = (root, identity) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'wake', identity + '.json'), 'utf8')); } catch { return null; } };
const setBinding = (root, identity, fields) => {
  fs.mkdirSync(path.join(root, 'runtime', 'wake'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', 'wake', identity + '.json'), JSON.stringify({ schema: 'localpost-wake-binding-v1', identity, mode: 'on', session: null, pending: null, ...fields }));
};
const cli = (root, args, extra = {}) => spawnSync(process.execPath, [path.join(root, 'localpost-switch.mjs'), ...args], { encoding: 'utf8', env: cleanEnv(extra) });
const hook = (root, script, args, session) => spawnSync(process.execPath, [path.join(root, script), ...args],
  { encoding: 'utf8', env: cleanEnv(), input: session === undefined ? '' : JSON.stringify({ session_id: session, hook_event_name: 'Stop' }) });

try {
  /* ---------------------------------------------------------------- W1 判定表 */
  const { decide } = await import(new URL('file:///' + path.join(SRC.shared, 'wake-binding.mjs').replace(/\\/g, '/')).href);
  const future = new Date(Date.now() + 60000).toISOString();
  const past = new Date(Date.now() - 60000).toISOString();
  const table = [
    [null, 'S1', 'legacy'], [{ invalid: true }, 'S1', 'legacy'], [{ mode: 'off', session: 'S1' }, 'S1', 'off'],
    [{ mode: 'on', session: 'S1' }, 'S1', 'mine'], [{ mode: 'on', session: 'S1' }, 'S2', 'other'], [{ mode: 'on', session: 'S1' }, null, 'other'],
    [{ mode: 'on', session: null, pending: { expiresAt: future } }, 'S3', 'claim'], [{ mode: 'on', session: null, pending: { expiresAt: future } }, null, 'other'],
    [{ mode: 'on', session: null, pending: { expiresAt: past } }, 'S3', 'legacy'], [{ mode: 'sideways', session: 'S1' }, 'S1', 'legacy'],
  ];
  const wrong = table.filter(([binding, session, expected]) => decide(binding, session) !== expected);
  record('W1 decide() 判定表 10 条', wrong.length === 0, wrong.map(row => JSON.stringify(row)).join(' '));

  /* ---------------------------------------------------------------- W2 claude CLI */
  const c = deployed('claude', [['claude', 'claude-check.mjs']]);
  let r = cli(c, ['here'], { CLAUDE_CODE_SESSION_ID: 'S1' });
  let b = bindingOf(c, 'claude');
  record('W2a claude here 用 CLAUDE_CODE_SESSION_ID 精确绑定', r.status === 0 && b?.mode === 'on' && b.session === 'S1' && /CLAUDE_CODE_SESSION_ID/.test(b.by), r.stdout.trim());
  r = cli(c, ['status'], { CLAUDE_CODE_SESSION_ID: 'S1' });
  record('W2b status 认出就是这个聊天', /S1（就是这个聊天）/.test(r.stdout), r.stdout.trim().split('\n')[1]);
  const before = fs.readFileSync(path.join(c, 'runtime', 'wake', 'claude.json'), 'utf8');
  r = cli(c, ['here'], { CLAUDE_CODE_SESSION_ID: 'S1' });
  record('W2c 重复 here = 无改动（文件逐字节不变）', /本来就是/.test(r.stdout) && fs.readFileSync(path.join(c, 'runtime', 'wake', 'claude.json'), 'utf8') === before);
  r = cli(c, ['off'], { CLAUDE_CODE_SESSION_ID: 'S1' });
  record('W2d off 关掉自动收信', r.status === 0 && bindingOf(c, 'claude')?.mode === 'off' && /已停止/.test(r.stdout));

  /* ---------------------------------------------------------------- W3 codex CLI */
  const x = deployed('codex', [['codex', 'codex-check.mjs']]);
  r = cli(x, ['here']);
  b = bindingOf(x, 'codex');
  const window = Date.parse(b?.pending?.expiresAt ?? '') - Date.parse(b?.pending?.requestedAt ?? '');
  record('W3 codex here 拿不到会话 id ⇒ 登记待认领 30 分钟', r.status === 0 && b?.session === null && window === 30 * 60 * 1000 && /登记/.test(r.stdout), r.stdout.trim());

  /* ---------------------------------------------------------------- W4 gemini CLI */
  const g = deployed('gemini', [['gemini', 'wake.mjs']], { conversationId: TEST_CONVERSATION_ID, maxAttemptsPerLetter: 3 });
  r = cli(g, ['here']);
  record('W4a gemini here 不带会话 id ⇒ 拒绝并指路 brain 目录，什么都不写', r.status === 1 && /brain/.test(r.stderr) && bindingOf(g, 'gemini') === null, r.stderr.trim().slice(0, 80));
  r = cli(g, ['here', '--session', 'not-a-uuid']);
  record('W4b gemini 会话 id 不是 UUID ⇒ 拒绝', r.status === 1 && bindingOf(g, 'gemini') === null);
  r = cli(g, ['here', '--session', OTHER_UUID]);
  record('W4c gemini here --session <UUID> ⇒ 绑定', r.status === 0 && bindingOf(g, 'gemini')?.session === OTHER_UUID, r.stdout.trim());

  /* ---------------------------------------------------------------- W5 codex-check */
  letter(x, 'codex', 'cx-1');
  fs.rmSync(path.join(x, 'runtime'), { recursive: true, force: true });
  const blocks = res => { try { return JSON.parse(res.stdout.trim()).decision === 'block'; } catch { return false; } };
  record('W5a 没有绑定文件 ⇒ 照旧提醒（任何聊天）', blocks(hook(x, 'codex-check.mjs', [], 'S9')));
  setBinding(x, 'codex', { session: 'S1' });
  record('W5b 绑在 S1：S2 的 Stop 静默', hook(x, 'codex-check.mjs', [], 'S2').stdout.trim() === '');
  record('W5c 绑在 S1：S1 的 Stop 提醒', blocks(hook(x, 'codex-check.mjs', [], 'S1')));
  setBinding(x, 'codex', { mode: 'off' });
  record('W5d 关掉 ⇒ 静默', hook(x, 'codex-check.mjs', [], 'S1').stdout.trim() === '');
  setBinding(x, 'codex', { pending: { requestedAt: new Date().toISOString(), expiresAt: future } });
  const claimed = hook(x, 'codex-check.mjs', [], 'S3');
  b = bindingOf(x, 'codex');
  record('W5e 待认领：S3 的 Stop 认领并提醒', blocks(claimed) && b?.session === 'S3' && b.pending === null && /codex Stop hook/.test(b.by), JSON.stringify(b?.by));
  record('W5f 认领之后 S4 的 Stop 静默', hook(x, 'codex-check.mjs', [], 'S4').stdout.trim() === '');
  setBinding(x, 'codex', { pending: { requestedAt: past, expiresAt: past } });
  record('W5g 登记过期 ⇒ 照旧提醒、不认领', blocks(hook(x, 'codex-check.mjs', [], 'S5')) && bindingOf(x, 'codex')?.session === null);

  /* ---------------------------------------------------------------- W6 claude-check */
  letter(c, 'claude', 'cl-1');
  setBinding(c, 'claude', { session: 'S1' });
  const context = res => { try { return /cl-1/.test(JSON.parse(res.stdout.trim()).hookSpecificOutput.additionalContext); } catch { return false; } };
  record('W6a --context：别的聊天不注入', hook(c, 'claude-check.mjs', ['--context'], 'S2').stdout.trim() === '');
  record('W6b --context：被绑聊天注入', context(hook(c, 'claude-check.mjs', ['--context'], 'S1')));
  record('W6c --rewake：别的聊天 exit 0', hook(c, 'claude-check.mjs', ['--rewake'], 'S2').status === 0);
  record('W6d --rewake：被绑聊天 exit 2 唤醒', hook(c, 'claude-check.mjs', ['--rewake'], 'S1').status === 2);
  setBinding(c, 'claude', { pending: { requestedAt: new Date().toISOString(), expiresAt: future } });
  record('W6e --context 不认领待认领的登记', hook(c, 'claude-check.mjs', ['--context'], 'S3').stdout.trim() === '' && bindingOf(c, 'claude')?.session === null);
  const rewake = hook(c, 'claude-check.mjs', ['--rewake'], 'S3');
  record('W6f --rewake（回合结束）认领并唤醒', rewake.status === 2 && bindingOf(c, 'claude')?.session === 'S3');

  /* ---------------------------------------------------------------- W7 claude-wake */
  const w = deployed('claude', [['claude', 'claude-wake.mjs']], { pollSeconds: 5, watchSeconds: 60 });
  const wakeLog = () => (fs.existsSync(path.join(w, 'wake.log')) ? fs.readFileSync(path.join(w, 'wake.log'), 'utf8') : '');
  const lockOf = () => { try { return JSON.parse(fs.readFileSync(path.join(w, 'watch.lock'), 'utf8')); } catch { return null; } };
  const startWake = session => {
    const child = spawn(process.execPath, [path.join(w, 'claude-wake.mjs')], { stdio: ['pipe', 'ignore', 'ignore'], env: cleanEnv() });
    child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'Stop' }));
    child.exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    return child;
  };
  const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'timeout')]);
  // 先让守望记下基线（空信箱），之后的信才算新信。
  setBinding(w, 'claude', { session: 'S2' });
  const skipped = startWake('S1');
  record('W7a 绑在别的聊天 ⇒ 不挂守望、不建锁', (await within(skipped.exited, 8000)) === 0 && lockOf() === null && /the mail chat is another session/.test(wakeLog()));
  setBinding(w, 'claude', { mode: 'off' });
  record('W7b 关掉 ⇒ 不挂守望', (await within(startWake('S1').exited, 8000)) === 0 && lockOf() === null && /automatic mail is off/.test(wakeLog()));
  // 别的聊天（S2）的守望活着、占着锁；用户把收信切到 S1 ⇒ S1 回合结束时接管。
  fs.writeFileSync(path.join(w, 'sleeper.mjs'), 'setTimeout(() => {}, 60000);\n');
  const sleeper = spawn(process.execPath, [path.join(w, 'sleeper.mjs')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(w, 'watch.lock'), JSON.stringify({ pid: sleeper.pid, at: Date.now(), session: 'S2' }) + '\n');
  setBinding(w, 'claude', { session: 'S1' });
  const watcher = startWake('S1');
  await sleep(2500);
  const taken = lockOf();
  record('W7c 被绑聊天接管别的聊天的活守望', taken?.pid === watcher.pid && taken.session === 'S1' && /take over: the mail chat is this session/.test(wakeLog()), JSON.stringify(taken));
  // 收信切去 S2 ⇒ S1 的守望在下一轮（5 秒）核对时自己退出，不再叫醒这里。
  setBinding(w, 'claude', { session: 'S2' });
  letter(w, 'claude', 'cw-1');
  const code = await within(watcher.exited, 12000);
  record('W7d 绑定挪走 ⇒ 守望自己退出（exit 0，不唤醒）', code === 0 && /stop watching: the mail chat is no longer this session/.test(wakeLog()), String(code));
  sleeper.kill();
  if (code === 'timeout') watcher.kill();

  /* ---------------------------------------------------------------- W8 gemini wake */
  const api = fakeAgentapi(g, { exitCode: 0 });
  const env = isolatedEnv(g, api);
  delete env.CLAUDE_CODE_SESSION_ID;
  const runWake = () => spawnSync(process.execPath, [path.join(g, 'wake.mjs')], { encoding: 'utf8', env, cwd: g });
  fs.rmSync(path.join(g, 'runtime'), { recursive: true, force: true });
  runWake();                                                   // 首次运行只记基线
  letter(g, 'gemini', 'gm-1');
  setBinding(g, 'gemini', { mode: 'off' });
  runWake();
  record('W8a 关掉 ⇒ 不发送', readCalls(api.calls).length === 0);
  setBinding(g, 'gemini', { session: OTHER_UUID });
  runWake();
  let calls = readCalls(api.calls);
  record('W8b 绑定的会话优先于 config.json', calls.length === 1 && calls[0].includes(OTHER_UUID) && !calls[0].includes(TEST_CONVERSATION_ID), calls[0]?.slice(0, 80));
  fs.rmSync(path.join(g, 'runtime'), { recursive: true, force: true });
  letter(g, 'gemini', 'gm-2');
  runWake();
  calls = readCalls(api.calls);
  record('W8c 没有绑定文件 ⇒ 用 config.json 的会话（旧行为）', calls.length === 2 && calls[1].includes(TEST_CONVERSATION_ID), calls[1]?.slice(0, 80));
} finally {
  for (const root of ROOTS) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 交给系统 temp 清理 */ } }
}

const bad = checks.filter(([, ok]) => !ok).length;
console.log(`\n小结：${checks.length - bad}/${checks.length} 通过`);
process.exitCode = bad === 0 ? 0 : 1;
