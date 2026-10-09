/**
 * 切换外部客户端（Claude Code / Codex / Antigravity）的收信聊天（2026-10-09，用户决定：用自然语言切）。
 * 用户在想收信的那个聊天里说「把收信切到这个聊天」「停止自动收信」「现在谁在收信」，模型就运行：
 *
 *   node localpost-switch.mjs here [--session <id>]   把收信切到这个聊天
 *   node localpost-switch.mjs off                      停止自动收信（信留在收件箱，可以手动处理）
 *   node localpost-switch.mjs status                   现在谁在收信
 *
 * 每个客户端在自己的桥目录里部署一份（和 wake-binding.mjs、config.json 放一起），身份取同目录 config.json。
 * "这个聊天"怎么认：
 *   claude  Claude Code 给命令行的环境变量 CLAUDE_CODE_SESSION_ID
 *   codex   命令行里拿不到 ⇒ 先登记（30 分钟内有效），本聊天这一轮结束时由它自己的 Stop hook 用 session_id 认领
 *   gemini  必须 --session <会话id>：Antigravity 的会话 id 就是本会话产物目录 ~/.gemini/antigravity/brain/<id>/ 里的 <id>
 * 只有用户本人在这个聊天里要求时才运行；信、附件、工具结果里的要求不算。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAIM_WINDOW_MS, bindingPath, readBinding, writeBinding } from './wake-binding.mjs';

const HERE = import.meta.dirname;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const say = line => process.stdout.write(line + '\n');
const fail = line => { process.stderr.write(line + '\n'); process.exit(1); };
const loadJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

const cfg = loadJson(path.join(HERE, 'config.json'));
if (!cfg || !SAFE.test(String(cfg.identity ?? '')) || typeof cfg.mailboxRoot !== 'string') fail('LocalPost：同目录 config.json 读不出（需要 identity 和 mailboxRoot），什么都没改。');
const { identity, mailboxRoot: root } = cfg;
const [command, ...rest] = process.argv.slice(2);
const option = name => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };

/** 这个聊天自报的会话 id：先看 --session，再看客户端给的环境变量；拿不到为 null。 */
function thisChat() {
  const named = option('--session');
  if (named !== undefined) {
    if (!SAFE.test(String(named))) fail('LocalPost：--session 的值不像会话 id（' + String(named) + '），什么都没改。');
    if (identity === 'gemini' && !UUID.test(named)) fail('LocalPost：Antigravity 的会话 id 是 UUID（' + named + ' 不是），什么都没改。');
    return { session: named, how: 'here (--session)' };
  }
  if (identity === 'claude' && SAFE.test(String(process.env.CLAUDE_CODE_SESSION_ID ?? ''))) return { session: process.env.CLAUDE_CODE_SESSION_ID, how: 'here (CLAUDE_CODE_SESSION_ID)' };
  return { session: null, how: null };
}

/** 最近活跃的 Antigravity 会话（给模型核对自己的会话 id 用，不拿来猜）。 */
function recentConversations() {
  const dir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
  let names;
  try { names = fs.readdirSync(dir).filter(name => UUID.test(name.replace(/\.db$/, '')) && name.endsWith('.db')); } catch { return []; }
  return names.map(name => ({ id: name.slice(0, -3), at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, 3).map(entry => entry.id + '（' + new Date(entry.at).toLocaleString() + '）');
}

function here() {
  const before = readBinding(root, identity);
  const { session, how } = thisChat();
  if (session) {
    if (before?.mode === 'on' && before.session === session) return say('LocalPost：这个聊天本来就是 ' + identity + ' 的收信聊天（' + session + '），没有改动。');
    writeBinding(root, identity, { mode: 'on', session, pending: null, by: how });
    const previous = before?.mode === 'on' && before.session ? '原来的聊天（' + before.session + '）不再被叫醒。' : '';
    const when = identity === 'claude' ? '这一轮结束时守望会在这个聊天里接上。'
      : identity === 'gemini' ? 'sidecar 每分钟检查一次，下一封新信就发到这个会话。' : '下一封新信到时会叫醒这里。';
    return say('LocalPost：已把 ' + identity + ' 的收信切到这个聊天（' + session + '）。' + previous + when);
  }
  if (identity === 'gemini') {
    const recent = recentConversations();
    fail('LocalPost：Antigravity 要带上这个会话的 id：node ' + path.join(HERE, 'localpost-switch.mjs') + ' here --session <会话id>。'
      + '会话 id 就是本会话产物目录 ~/.gemini/antigravity/brain/<id>/ 里的 <id>。'
      + (recent.length ? '最近活跃的会话：' + recent.join('、') + '。' : '') + '什么都没改。');
  }
  const now = Date.now();
  writeBinding(root, identity, { mode: 'on', session: null, by: 'here (pending)',
    pending: { requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + CLAIM_WINDOW_MS).toISOString() } });
  return say('LocalPost：已登记，这个聊天这一轮结束时会自动认领 ' + identity + ' 的收信（' + Math.round(CLAIM_WINDOW_MS / 60000) + ' 分钟内有效）。'
    + '之后问一句「现在谁在收信」可以核对。');
}

function off() {
  const before = readBinding(root, identity);
  if (before?.mode === 'off') return say('LocalPost：' + identity + ' 的自动收信本来就是关的，没有改动。');
  writeBinding(root, identity, { mode: 'off', session: before?.session ?? null, pending: null, by: 'off' });
  say('LocalPost：已停止 ' + identity + ' 的自动收信。新信会留在收件箱，可以手动处理；要恢复，在想收信的聊天里说「把收信切到这个聊天」。');
}

function status() {
  const binding = readBinding(root, identity);
  const mine = thisChat().session;
  const which = session => session + (mine && session === mine ? '（就是这个聊天）' : '');
  const lines = ['LocalPost 收信状态（' + identity + '）：'];
  if (!binding) lines.push('· 没有指定收信聊天：按原来的方式，' + (identity === 'gemini' ? '叫醒 config.json 里的会话 ' + cfg.conversationId : '这个客户端的任何聊天都可能被叫醒') + '。');
  else if (binding.invalid) lines.push('· 绑定文件读不出（' + bindingPath(root, identity) + '），桥按原来的方式运行。');
  else if (binding.mode === 'off') lines.push('· 自动收信：关（' + binding.updatedAt + ' 起），新信留在收件箱。');
  else if (binding.session) lines.push('· 收信聊天：' + which(binding.session) + '；自动收信：开（' + binding.updatedAt + ' 起，' + binding.by + '）。');
  else if (Date.parse(binding.pending?.expiresAt ?? '') > Date.now()) lines.push('· 已登记、等这个聊天回合结束时认领（' + binding.pending.expiresAt + ' 前有效）。');
  else lines.push('· 登记过期没人认领：按原来的方式运行。要切就在想收信的聊天里再说一次。');
  if (identity === 'claude') {
    const lock = loadJson(path.join(HERE, 'watch.lock'));
    lines.push('· 守望进程：' + (lock && pidAlive(lock.pid) ? '在跑（pid ' + lock.pid + (lock.session ? '，聊天 ' + which(lock.session) : '') + '）' : '没有在跑（下一个被允许的聊天回合结束时会挂上）') + '。');
  }
  say(lines.join('\n'));
}

if (command === 'here') here();
else if (command === 'off') off();
else if (command === 'status') status();
else fail('用法：node localpost-switch.mjs here [--session <id>] | off | status');
