/**
 * Which chat of an external client receives an identity's LocalPost mail (2026-10-09, user decision: switch it in plain
 * language, like DSH's localpost_bind_here). One small file per identity, `<mailboxRoot>/runtime/wake/<identity>.json`,
 * written by localpost-switch.mjs when the user asks for it in that chat, and read by the client's wake bridge
 * (claude-wake / claude-check / codex-check / gemini wake) on every run:
 *
 *   no file            legacy: the bridge behaves exactly as before this change (any chat of the client)
 *   mode off           nobody is woken or reminded; letters wait in the inbox for manual handling
 *   mode on + session  only that chat: Claude Code session_id, Codex session_id, Antigravity conversationId
 *   mode on + pending  the chat that asked could not name itself (Codex has no session id in its shell): the first hook
 *                      that runs in a chat before `expiresAt` - that chat's own Stop at the end of its turn - claims it
 *
 * Deployed next to each bridge (same directory), so a bridge never runs code from the shared mailbox. The binding is
 * data: the worst a wrong write can do is send the wake-up to another of the user's own chats, or to none.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'localpost-wake-binding-v1';
// How long a pending binding waits for the asking chat's Stop: a long turn can run "here" early.
export const CLAIM_WINDOW_MS = 30 * 60 * 1000;
const text = value => typeof value === 'string' && value.trim() !== '';

export const bindingPath = (root, identity) => path.join(root, 'runtime', 'wake', identity + '.json');

/** The identity's binding, null when there is none, or `{ invalid: true }` when the file cannot be used. */
export function readBinding(root, identity) {
  let raw;
  try { raw = fs.readFileSync(bindingPath(root, identity), 'utf8'); } catch { return null; }
  try {
    const binding = JSON.parse(raw);
    return binding && typeof binding === 'object' && binding.schema === SCHEMA && binding.identity === identity ? binding : { invalid: true };
  } catch { return { invalid: true }; }
}

/** Replaces the identity's binding in one rename, so a reader sees the old or the new file, never half of one. */
export function writeBinding(root, identity, fields, now = new Date()) {
  const file = bindingPath(root, identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { schema: SCHEMA, identity, mode: 'on', session: null, pending: null, ...fields, updatedAt: now.toISOString() };
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
  return next;
}

/**
 * What a bridge running in chat `session` (null when the client did not say which) does:
 *   'legacy' as before; 'off' nothing; 'mine' this chat is the one; 'other' leave it to the bound chat;
 *   'claim' take the pending binding first (claim), then act as 'mine'.
 * An unusable file falls back to 'legacy' - the behaviour the user had before - and status says it is unreadable.
 */
export function decide(binding, session, now = Date.now()) {
  if (!binding || binding.invalid) return 'legacy';
  if (binding.mode === 'off') return 'off';
  if (binding.mode !== 'on') return 'legacy';
  if (text(binding.session)) return text(session) && binding.session === session ? 'mine' : 'other';
  const expires = Date.parse(binding.pending?.expiresAt ?? '');
  if (Number.isFinite(expires) && expires > now) return text(session) ? 'claim' : 'other';
  return 'legacy';
}

/** Chat `session` takes a pending binding (only while it is still pending) and gets back the binding that stands now. */
export function claim(root, identity, session, how, now = new Date()) {
  const current = readBinding(root, identity);
  if (decide(current, session, now.getTime()) !== 'claim') return current;
  writeBinding(root, identity, { mode: 'on', session, pending: null, by: how }, now);
  return readBinding(root, identity);
}

/** Decides for chat `session`, claiming a pending binding on the way when `mayClaim`; returns the final decision. */
export function settle(root, identity, session, { mayClaim = false, how = 'claimed by a hook' } = {}) {
  const first = decide(readBinding(root, identity), session);
  if (first !== 'claim') return first;
  if (!mayClaim) return 'other';
  return decide(claim(root, identity, session, how), session);
}

/** The JSON a hook receives on stdin, or {} when there is none (a terminal, an ignored stdin, or not JSON). */
export function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const value = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
