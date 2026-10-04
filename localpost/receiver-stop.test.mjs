import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReceiver } from './receiver.mjs';
import { removeTreeSync } from './temp-tree.mjs';

// The real receiver's stop() when a cleanup step fails (codex 2026-10-04): every step is still attempted - no new scan
// is scheduled, the watcher close is attempted, both timers are cleared, running scans are awaited - and only then is
// the failure reported. Only the watcher is injected; timers, scans and the state file are the real ones.
const TMP = path.resolve(import.meta.dirname, '../.localpost-tmp/receiver-stop');
function rootFor(t) {
  fs.mkdirSync(TMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP, 'case-'));
  t.after(() => removeTreeSync(root));
  return root;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A watcher whose first close() fails, as fs.FSWatcher can on Windows; it keeps the listener so a test can send a change hint. */
function failingWatch() {
  const seen = { watches: 0, closes: 0, listener: null };
  const watch = (dir, listener) => {
    seen.watches += 1;
    seen.listener = listener;
    return {
      on() { return this; },
      close() { seen.closes += 1; if (seen.closes === 1) throw Object.assign(new Error('close failed'), { code: 'EPERM' }); },
    };
  };
  return { watch, seen };
}
/** Every scan rewrites the receiver's state file with a fresh updatedAt. */
const lastScan = root => JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'queues', 'dsh.json'), 'utf8')).updatedAt;
const receiverOn = (t, root, watch, extra = {}) => {
  const receiver = createReceiver({ root, agent: 'dsh', allowFrom: ['codex'], watch, ...extra });
  // Safety net only: a receiver whose timers survived must not keep the test process alive.
  t.after(() => receiver.stop().catch(() => {}));
  return receiver;
};

test('when closing the watcher fails, stop still clears the interval and the pending debounce, then reports the failure', async t => {
  const root = rootFor(t);
  const { watch, seen } = failingWatch();
  const receiver = receiverOn(t, root, watch, { scanIntervalMs: 20, debounceMs: 60 });
  await receiver.start();
  await wait(70);                                     // the interval has been scanning every 20 ms
  seen.listener();                                    // a change hint: a debounced scan is now pending
  await assert.rejects(receiver.stop(), { message: 'close failed', code: 'EPERM' }, 'the failure is reported, not swallowed');
  const atStop = lastScan(root);
  await wait(250);                                    // > 10 intervals and > 4 debounce windows
  assert.equal(lastScan(root), atStop, 'no scan ran after stop: interval and debounce were both cleared');
  assert.equal(receiver.diagnostics().running, false);
});

test('stop waits for a scan that is already running, even when closing the watcher fails', async t => {
  const root = rootFor(t);
  const { watch } = failingWatch();
  const receiver = receiverOn(t, root, watch, { scanIntervalMs: 60000, debounceMs: 60 });
  await receiver.start();
  let settled = false;
  receiver.scan().then(() => { settled = true; }, () => { settled = true; });
  await assert.rejects(receiver.stop(), { message: 'close failed' });
  assert.equal(settled, true, 'the running scan had finished by the time stop reported');
});

test('a second stop after a failed one is a no-op: the watcher is not closed again and nothing is thrown', async t => {
  const root = rootFor(t);
  const { watch, seen } = failingWatch();
  const receiver = receiverOn(t, root, watch, { scanIntervalMs: 60000, debounceMs: 60 });
  await receiver.start();
  await assert.rejects(receiver.stop(), { message: 'close failed' });
  await receiver.stop();
  await receiver.stop();
  assert.equal(seen.closes, 1, 'the failed watcher is not touched again');
  // Starting again builds a fresh watcher, and that one stops cleanly.
  await receiver.start();
  assert.equal(seen.watches, 2);
  await receiver.stop();
  assert.equal(seen.closes, 2);
});

/** A watcher that closes cleanly and counts how many were opened and closed. */
function countingWatch() {
  const seen = { watches: 0, closes: 0 };
  const watch = () => { seen.watches += 1; return { on() { return this; }, close() { seen.closes += 1; } }; };
  return { watch, seen };
}

test('a stop that arrives while start is still under way leaves nothing running and nothing scheduled', async t => {
  const root = rootFor(t);
  const { watch, seen } = countingWatch();
  const receiver = receiverOn(t, root, watch, { scanIntervalMs: 20, debounceMs: 60 });
  const starting = receiver.start();                  // still waiting for the inbox directory and the first scan
  const stopping = receiver.stop();
  await Promise.all([starting, stopping]);
  assert.equal(receiver.diagnostics().running, false, 'stop() returned last, so the receiver is stopped');
  assert.deepEqual([seen.watches, seen.closes], [1, 1], 'the watcher the start opened was closed');
  const atStop = lastScan(root);
  await wait(200);                                    // ten intervals
  assert.equal(lastScan(root), atStop, 'no interval was left behind by the overtaken start');
});

test('concurrent starts open one watcher, and one stop closes it', async t => {
  const root = rootFor(t);
  const { watch, seen } = countingWatch();
  const receiver = receiverOn(t, root, watch, { scanIntervalMs: 60000, debounceMs: 60 });
  await Promise.all([receiver.start(), receiver.start(), receiver.start()]);
  assert.equal(seen.watches, 1);
  await receiver.stop();
  assert.equal(seen.closes, 1, 'no watcher was left open');
});
