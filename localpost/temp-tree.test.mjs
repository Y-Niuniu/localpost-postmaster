import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { removeTree, removeTreeSync, isTransient } from './temp-tree.mjs';

const flaky = (failures, code = 'EPERM') => {
  let calls = 0;
  return {
    get calls() { return calls; },
    remover: async () => { calls++; if (calls <= failures) { const error = new Error('Permission denied'); error.code = code; throw error; } },
  };
};

test('瞬时 EPERM 会重试直到成功，并如实报告尝试次数', async () => {
  const stub = flaky(2);
  const result = await removeTree('C:/nowhere', { remover: stub.remover, delayMs: 1 });
  assert.deepEqual(result, { removed: true, attempts: 3 });
  assert.equal(stub.calls, 3);
});

test('非瞬时错误立刻抛出，不做无意义重试', async () => {
  const stub = flaky(5, 'ENOTDIR');
  await assert.rejects(() => removeTree('C:/nowhere', { remover: stub.remover, delayMs: 1 }), /Permission denied/);
  assert.equal(stub.calls, 1);
});

test('重试耗尽仍失败时抛出最后一次错误，不吞掉真实泄漏', async () => {
  const stub = flaky(99);
  await assert.rejects(() => removeTree('C:/nowhere', { remover: stub.remover, attempts: 3, delayMs: 1 }), (error) => {
    assert.equal(error.code, 'EPERM');
    return true;
  });
  assert.equal(stub.calls, 3);
});

const flakySync = (failures, code = 'EPERM') => {
  let calls = 0;
  return {
    get calls() { return calls; },
    remover: () => { calls++; if (calls <= failures) { const error = new Error('Permission denied'); error.code = code; throw error; } },
  };
};

test('同步版本同样重试瞬时错误并最终失败时报错', () => {
  const stub = flakySync(1);
  assert.deepEqual(removeTreeSync('C:/nowhere', { remover: stub.remover, delayMs: 1 }), { removed: true, attempts: 2 });
  assert.equal(stub.calls, 2);
  const hard = flakySync(99);
  assert.throws(() => removeTreeSync('C:/nowhere', { remover: hard.remover, attempts: 2, delayMs: 1 }), /Permission denied/);
  assert.equal(hard.calls, 2);
});

test('真实目录：同步与异步清理都能删干净嵌套结构', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpost-temptree-'));
  const nested = path.join(root, 'a', 'b');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'x.json'), '{}\n');
  removeTreeSync(path.join(root, 'a'));
  assert.deepEqual(await fs.readdir(root), []);
  await fs.rm(root, { recursive: true, force: true });
});

test('isTransient 只认可恢复的错误码', () => {
  assert.equal(isTransient({ code: 'EPERM' }), true);
  assert.equal(isTransient({ code: 'ENOTEMPTY' }), true);
  assert.equal(isTransient({ code: 'ENOENT' }), false);
  assert.equal(isTransient(new Error('boom')), false);
});
