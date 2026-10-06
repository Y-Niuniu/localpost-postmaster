# E2 缺口记录：派发消息被宿主 v4 格式拒绝（2026-10-04）

## 现象
隔离 receiver 受理并派发 mcptest-e1b-1 到已绑定聊天 A 时，宿主侧报错：
`format v4 message requires a producer-owned source kind`（用户在 GUI 看到『本轮运行失败』对话框；DSH 未崩溃、未闪退）。

## 证据
1. **受理确实发生**（备份 localpost-e-test.bak-20261004-162956）：
   - runtime/queues/dsh.json 178B → **964B**（队列有内容）
   - runtime/sessions/dsh.json 946B → **1875B**（claims 有内容）
   - agents/dsh/inbox/mcptest-e1b-1.json 348B、runtime/arrivals/dsh/mcptest-e1b-1.json 506B（到达 pin A：thread=session-e53beab1…, gen=1）
2. **宿主校验源码**（app.asar，约第 930769 行起）：
```js
function rewriteV3MessageSource(source, seq, role) {
  const kind = source["kind"];
  if (typeof kind !== "string" || kind.length === 0) throw new SessionFormatError(`message source at seq ${seq} requires a nonempty kind`);
  if (kind === "plugin") return rewritePluginSource(source, seq, role);
  return source;
}
function rewritePluginSource(source, seq, role) {
  const plugin = source["plugin"];
  if (typeof plugin !== "string") throw new SessionFormatError(`plugin source at seq ${seq} is not canonical: plugin requires a string`);
  const kind = producerKind(plugin, role);
  if (Object.keys(source).length === 2) return { kind };
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== "plugin").map(([k, v]) => [k, k === "kind" ? kind : v]));
}
// 另一处（同族错误串）：
if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string" || value["kind"].length === 0 || value["kind"] === "plugin")
  throw new SessionFormatError("format v4 message requires a producer-owned source kind");
```
3. **我们发的内容**（localpost/dsh-adapter.mjs:68）：
```js
source: Object.freeze({ kind: 'plugin', plugin: 'localpost', form: 'relay' }),
```
同文件 :44 的自检期望 `request.source.kind === 'plugin' && request.source.plugin === 'localpost'`。

## 判断（准确缺口）
- 宿主 v4 对 `kind:'plugin'` 的消息**不再直接接受**，而是要求经 `producerKind(plugin, role)` 映射为**生产者自有 kind**，最终 kind 必须非空且 **≠ 'plugin'**。
- 我们的 `plugin:'localpost'` 未映射到被接受的 producer kind（映射结果仍不满足 producer-owned 条件）→ 消息被拒 → 派发失败。
- 这是**宿主契约与插件消息形态的集成缺口**，不是权限或绑定问题；与 E1 判定无关。

## 待定（下一步）
- 需确定 `producerKind` 接受的确切取值（是否要求宿主注册的插件 id 形态，如包名；或 role 相关的映射表）。
- 定形后在**自有 worktree** 修 `localpost/dsh-adapter.mjs`（及必要时其自检），commit 后回审；**不改 main**、不碰已发布五文件、不改预检常量。
- 修复前 **E2 记为『未执行/被阻塞』**，不得记为通过。

## 环境事件（同期，勿混淆）
- 16:26:06 与 16:29:56 各发生一次 `-RebuildRoot`（用户崩溃/报错后重启），旧根整体旁移进备份（未删除）：bak-20261004-162606、bak-20261004-162956。
- 因此 E1b 的实时根证据以备份为准；E1 判定点（到达 pin A + B 不能抢夺）已在两套根上分别成立。
---

## 更正（2026-10-04，来源：AgentTeams t1 契约任务，含行号实证）

本文档「判断（准确缺口）」一节中『producerKind 未映射到被接受的值』的说法**已被证伪，以本节为准**：

1. `producerKind('localpost')` 的映射本身是**合格的**（→ `plugin:localpost`），并无白名单或生产者注册表（`registerProducer`/`producerRegistry` 在 asar 内 0 命中；映射表为编译期字面量）。
2. 真正原因：`rewriteV3MessageSource` 这条重写路径**只存在于 V3→V4 迁移**里（全 asar 唯一调用点 `index.js:1492`，作用于**已发布的 V3 记录**）；**新注入的原生 V4 消息根本不经过它**，于是带 `kind:'plugin'` 的原生 V4 行在持久化时被拒。
3. 被拒的确切调用链（worker.cjs）：`encodeEvent` 11743-11750 → `assertV4RowAdmission` 11758-11770 → `assertV4SourceRowAdmission` 10918-10928 → `source()` 10900-10903 抛 `format v4 message requires a producer-owned source kind`。用宿主真实导出函数复现，错误串与 E2 现场一致。
4. 正确形态：`{ kind: 'plugin:localpost', form: 'relay' }`（与宿主 V3→V4 对 `plugin='localpost'` 的产出**逐字节一致**，保证新旧记录同名同归因）。`form:'relay'` 必须保留——客户端 `ContextInjectionRow` 对 `form` 是封闭并集，未知值会抛。
5. 本案与 role 无关。

**结论**：这是「插件按旧文档发裸 `kind:'plugin'`」造成的原生 V4 准入失败，修复面最小为 `localpost/dsh-adapter.mjs:68`（+ 其测试期望值）。E2 仍须隔离环境端到端重跑后方可改判。