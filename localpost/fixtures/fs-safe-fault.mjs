/**
 * fs-safe 故障注入 fixture。只在**本子进程**里替换 node:fs / node:fs/promises 的方法，
 * 绝不在测试进程里改共享的内置模块：进程内 mock 会让同一进程里其它测试的真实 I/O 一起出错
 * （codex 2026-10-03 指出）。
 *
 * 用法：node fs-safe-fault.mjs <场景> <根目录>
 * 结果以一行 JSON 写到 stdout，断言全部在父测试里做；未知场景退出码 2。
 *
 * 为什么是落盘文件而不是 node -e：见 reply-then-hang.mjs 的说明（本机规则禁止内联脚本）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { acquireLease, atomicWrite, safePath, RENAME_ATTEMPTS } from '../fs-safe.mjs';

const [scenario, root] = process.argv.slice(2);
const transient = code => Object.assign(new Error(code + ': injected'), { code });
const same = (a, b) => path.resolve(String(a)) === path.resolve(String(b));
// 早已不存在的 pid（Windows 上 OpenProcess 返回参数错误 → ESRCH），配一个过期的启动时间就是陈旧锁。
const writeStale = file => fs.writeFileSync(file, JSON.stringify({ token: 'dead-owner', pid: 2147483647, started_at: Date.now() - 60000 }), 'utf8');
const ownerOf = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

const scenarios = {
  // 陈旧锁回收时，reclaim gate 的释放连续遇到瞬时错误直到重试耗尽。
  async 'gate-release-exhausted'() {
    const name = '.gate.lock';
    const lock = path.join(root, name);
    const gate = lock + '.reclaim';
    writeStale(lock);
    const unlink = fsp.unlink;
    let failing = true, injected = 0;
    fsp.unlink = async (target, ...rest) => {
      if (failing && same(target, gate)) { injected += 1; throw transient('EPERM'); }
      return unlink(target, ...rest);
    };
    const result = {};
    try { await acquireLease(root, { name, staleMs: 1000 }); result.first = 'resolved'; }
    catch (error) { result.first = error.code || error.message; }
    const owner = ownerOf(lock);
    result.injected = injected;
    result.afterFailure = { mainLockOwnerPid: owner?.pid ?? null, mainLockIsOurs: owner?.pid === process.pid, gateExists: fs.existsSync(gate) };
    failing = false;
    const second = await acquireLease(root, { name, staleMs: 1000 });
    const third = await acquireLease(root, { name, staleMs: 1000 });
    result.second = second.reason;
    result.thirdWhileSecondHeld = third.reason;
    await second.release();
    result.mainLockAfterRelease = fs.existsSync(lock);
    // 没能释放的 gate 是可见故障：之后的陈旧回收要报 needs_reconcile，处理掉 gate 后才恢复。
    writeStale(lock);
    result.recoveryWithLeftoverGate = (await acquireLease(root, { name, staleMs: 1000 })).reason;
    fs.rmSync(gate, { force: true });
    const recovered = await acquireLease(root, { name, staleMs: 1000 });
    result.recoveryAfterGateHandled = recovered.reason;
    await recovered.release();
    return result;
  },

  async 'release-transient-read'() {
    const name = '.rel.lock';
    const lease = await acquireLease(root, { name });
    const readFile = fsp.readFile;
    let injected = 0;
    fsp.readFile = async (target, ...rest) => {
      if (same(target, path.join(root, name)) && injected < 2) { injected += 1; throw transient('EPERM'); }
      return readFile(target, ...rest);
    };
    const released = await lease.release();
    return { acquired: lease.acquired, released, injected, lockExists: fs.existsSync(path.join(root, name)) };
  },

  async 'release-transient-unlink'() {
    const name = '.rel2.lock';
    const lease = await acquireLease(root, { name });
    const unlink = fsp.unlink;
    let injected = 0;
    fsp.unlink = async (target, ...rest) => {
      if (same(target, path.join(root, name)) && injected < 2) { injected += 1; throw transient('EPERM'); }
      return unlink(target, ...rest);
    };
    const released = await lease.release();
    return { acquired: lease.acquired, released, injected, lockExists: fs.existsSync(path.join(root, name)) };
  },

  async 'release-unconfirmable'() {
    const name = '.rel3.lock';
    const lease = await acquireLease(root, { name });
    const unlink = fsp.unlink;
    fsp.unlink = async (target, ...rest) => {
      if (same(target, path.join(root, name))) throw transient('EPERM');
      return unlink(target, ...rest);
    };
    let error = null;
    try { await lease.release(); } catch (caught) { error = caught.code || caught.message; }
    return { acquired: lease.acquired, error, lockExists: fs.existsSync(path.join(root, name)) };
  },

  // safePath 每次调用都会解析一次根目录：第 1 次是主锁路径，第 2 次才是回收阶段的 gate 路径。
  // 只在第 2 次注入，确认覆盖的是回收阶段，而不是 acquireLease 开头那次。
  async 'reclaim-realpath-transient'() {
    const name = '.stale.lock';
    const lock = path.join(root, name);
    writeStale(lock);
    const native = fs.realpathSync.native;
    let rootCalls = 0, injectedAt = null;
    fs.realpathSync.native = (target, ...rest) => {
      if (same(target, root)) {
        rootCalls += 1;
        if (rootCalls === 2) { injectedAt = rootCalls; throw transient('EPERM'); }
      }
      return native(target, ...rest);
    };
    const lease = await acquireLease(root, { name, staleMs: 1000 });
    return { acquired: lease.acquired, reason: lease.reason, rootCalls, injectedAt,
      staleLockKept: ownerOf(lock)?.token === 'dead-owner', gateExists: fs.existsSync(lock + '.reclaim') };
  },

  async 'rename-transient'() {
    const target = safePath(root, 'x.json');
    const rename = fsp.rename;
    let refusals = 2;
    fsp.rename = async (from, to) => {
      if (refusals > 0) { refusals -= 1; throw transient('EPERM'); }
      return rename(from, to);
    };
    await atomicWrite(target, '{"ok":true}');
    return { refusalsLeft: refusals, content: JSON.parse(fs.readFileSync(target, 'utf8')), entries: fs.readdirSync(root) };
  },

  async 'rename-persistent'() {
    const target = safePath(root, 'x.json');
    let calls = 0, code = 'EPERM';
    fsp.rename = async () => { calls += 1; throw transient(code); };
    const attempt = async () => { try { await atomicWrite(target, '{}'); return 'resolved'; } catch (error) { return error.code; } };
    const transientResult = { error: await attempt(), calls, entries: fs.readdirSync(root) };
    calls = 0; code = 'ENOENT';
    const otherResult = { error: await attempt(), calls, entries: fs.readdirSync(root) };
    return { attempts: RENAME_ATTEMPTS, transient: transientResult, other: otherResult };
  },
};

const run = scenarios[scenario];
if (!run) { process.stderr.write('unknown scenario: ' + scenario + '\n'); process.exit(2); }
process.stdout.write(JSON.stringify(await run()) + '\n');
