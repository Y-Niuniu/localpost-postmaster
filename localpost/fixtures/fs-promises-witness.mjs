/**
 * 调用期 IO 观测器（node:fs/promises 版）。
 *
 * 与 fs-witness.mjs 同源：测试用 `module.registerHooks` 把插件自身模块的
 * `node:fs/promises` 导入改写到本模块，插件的每次 promise 版 fs 调用都经过这里。
 */
import fsp from 'node:fs/promises';

export const witness = { on: false, hits: [] };

const cache = new Map();
const wrap = (name, fn) => {
  const wrapped = function (...args) {
    if (witness.on) witness.hits.push(name + ' ' + String(args?.[0] ?? ''));
    return fn.apply(fsp, args);
  };
  return wrapped;
};

export default new Proxy(fsp, {
  get(target, property) {
    const value = target[property];
    if (typeof value !== 'function') return value;
    const key = String(property);
    if (!cache.has(key)) cache.set(key, wrap(key, value));
    return cache.get(key);
  },
});
