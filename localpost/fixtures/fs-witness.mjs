/**
 * 调用期 IO 观测器（node:fs 版）。
 *
 * 用法：测试用 `module.registerHooks` 把**插件自身模块**的 `node:fs` 导入改写到本模块，
 * 于是插件的每一次 fs 调用都先经过这里 —— 这是"调用期观测"，不是"事后快照"，
 * 因此能看见元数据读取（statSync）与「创建后立刻删除」的瞬时写入。
 *
 * 只统计 `witness.on === true` 期间的调用；默认关闭，避免把测试自己的 fixture IO 算进来。
 */
import fs from 'node:fs';

export const witness = { on: false, hits: [] };

const cache = new Map();
const wrap = (name, fn) => {
  const wrapped = function (...args) {
    if (witness.on) witness.hits.push(name + ' ' + String(args?.[0] ?? ''));
    return fn.apply(fs, args);
  };
  return wrapped;
};

export default new Proxy(fs, {
  get(target, property) {
    const value = target[property];
    if (typeof value !== 'function') return value;
    const key = String(property);
    if (!cache.has(key)) cache.set(key, wrap(key, value));
    return cache.get(key);
  },
});
