# 宿主 v4「生产者自有 source kind」契约 —— 结论、证据与改法建议

- 任务：t1（team `localpost-e2-fix`），attempt `9badeb87-4d93-477b-9464-02c42cd917e9`
- 结论时间：2026-10-04（Europe/London）
- 被判定的宿主构建：`C:/Users/16548/AppData/Local/Programs/DeepSeek Harness/resources/app.asar`
  - size = 121348951 bytes
  - sha256 = `983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2`
  - `dsh/package.json` name=`@deepseek-ai/dsh-desktop-runtime` version=`0.2.0-rc.2`
- 本目录只读副本：`_asar_extract/`（与 app.asar 内同名条目 **逐字节一致**，已用 sha256 逐个比对；行号引用以此副本为准）

---

## 0. 可复制粘贴的结论

**宿主受理的形态**：`message.source.kind` 必须是**非空字符串**，且**不等于 `'plugin'`**。除此之外**没有白名单**（`plugin:localpost` 这类"未知 kind"原样保留）。

**LocalPost 应当发送的 source**（推荐，与宿主自己的 V3→V4 迁移结果逐字节一致）：

```js
// localpost/dsh-adapter.mjs —— 交给 agent.followup(message) 的那一份
source: Object.freeze({ kind: 'plugin:localpost', form: 'relay' }),
```

等价的最小 diff（只改这一行 + 注释）：

```diff
-        source: Object.freeze({ kind: 'plugin', plugin: 'localpost', form: 'relay' }),
+        // 宿主 v4 只受理"生产者自有 kind"：非空且 != 'plugin'。
+        // 'plugin:localpost' 正是宿主 V3→V4 迁移对 plugin='localpost' 的产出（见 §2），因此新旧记录同名。
+        source: Object.freeze({ kind: 'plugin:localpost', form: 'relay' }),
```

**不要**发 `{ kind: 'plugin', plugin: 'localpost', form: 'relay' }`（当前实现）——它在写入路径被确定性拒绝，错误串就是 E2 现场看到的 `format v4 message requires a producer-owned source kind`。

---

## 1. 故障链（可复现，非推测）

1. `localpost/receiver.mjs:138-142` 构造派发请求，`source: { kind: 'plugin', plugin: 'localpost', form: 'relay' }`。
2. `localpost/dsh-adapter.mjs:43-47` 校验通过（自检条件正是 `kind==='plugin' && plugin==='localpost' && form==='relay'`）。
3. `dsh-adapter.mjs:88` 调 `agent.followup(message)`（rc.2 公共 Agent API，README 见 §4.3），消息进入会话。
4. 会话落盘时走 `@deepseek-ai/dsh-session-persistence-jsonl` 的 V4 编码器
   `releasedV4SessionFormatCodec.encodeEvent(event)`（worker.cjs:11743-11750）→ `assertV4RowAdmission`（worker.cjs:11758-11770）→ `assertV4SourceRowAdmission`（worker.cjs:10918-10928）。
5. `user/message` 行的 `data` 就是消息本体；由于 `source.kind === 'plugin'`，调用 `source(message)`（worker.cjs:10900-10903）→ 抛
   `SessionFormatError("format v4 message requires a producer-owned source kind")`。

**实测复现**（用宿主自己的导出函数，不是复刻品）：

```
current adapter  {kind:'plugin',plugin:'localpost',form:'relay'}
    assertV4RowAdmission: THROW format v4 message requires a producer-owned source kind
    encodeEvent:          THROW format v4 message requires a producer-owned source kind
recommended      {kind:'plugin:localpost',form:'relay'}
    assertV4RowAdmission: PASS
    encodeEvent:          PASS
```

复现脚本：`work/e2-contract/verify-source-kind.mjs`（在 DSH run_code/PTC 程序里 `await import("file:///C:/AI_ASSIST/work/e2-contract/verify-source-kind.mjs")` 即跑）。
它直接 `import` app.asar 内的 `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`，调用真实的 `assertV4RowAdmission` 与 `releasedV4SessionFormatCodec.encodeEvent`。

### 对 `docs/evidence/e2-blocker-producer-owned-source-kind-20261004.md` 第 39 行的更正

原文："我们的 `plugin:'localpost'` 未映射到被接受的 producer kind（映射结果仍不满足 producer-owned 条件）"。
**不成立**：`producerKind('localpost', role)` 的产物是 `plugin:localpost`，它**是**被受理的（§0 实测 PASS）。
真正的原因是**那条重写只存在于 V3→V4 迁移阶段，对"新注入的原生 V4 消息"根本不会执行**：全 asar 符号扫描显示 `rewriteV3MessageSource` 只出现在 1 个文件（定义 + 唯一调用点 `index.js:1492`，位于 `ReleasedV3ToV4Stage.transformEvent` 内），作用对象是"已发布的 V3 记录"。所以 `agent.followup()` 送进来的消息以**原始 wrapper** 抵达 V4 受理器并被拒。

---

## 2. (a) `producerKind` 定义与全部入参形态

文件：`dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`（只读副本 `_asar_extract/index.js`）

```js
// index.js:86-93
/** Resolve the current producer kind for one released V3 plugin string. */
function producerKind(plugin, role) {
	if (plugin === "@deepseek-ai/dsh-system-prompt" && role === "system") return "system-prompt";
	const renamed = Object.hasOwn(RENAMED_PRODUCERS, plugin) ? RENAMED_PRODUCERS[plugin] : void 0;
	if (renamed !== void 0) return renamed;
	if (RELEASED_SAME_NAME_PRODUCERS.has(plugin)) return plugin;
	return `plugin:${plugin}`;              // index.js:92 —— 兜底：完整原样保留
}
```

入参：`(plugin: string, role: string)`。**仅两个入参**；`plugin` 由调用方保证是 string（`rewritePluginSource` 在 `index.js:103` 先校验类型，否则抛 `plugin source at seq … is not a canonical: plugin requires a string`）。

三张表（`index.js:50-85`）：

| 表 | 内容 | 结果 |
|---|---|---|
| `RENAMED_PRODUCERS`（:51-57） | `compact`→`compact-checkpoint`；`tools-code-mode`/`tools-ptc`→`ptc-mode`；`dsh-compaction-basic`→`compact-basic`；`@deepseek-ai/dsh-system-prompt`→`runtime-context` | 映射值 |
| `RELEASED_SAME_NAME_PRODUCERS`（:59-85，Set） | agent-instructions, session-reference, team-message, goal, skill-invocation, skill-catalog, coordinator, subagent-report, subagent-settled, webhook, agent-message, model-selection, plan-mode, time-context, tmux-context, user-approval, repeat-tool-reminder, tool-cordis, cordis-host-runner, tool-goal, tool-jobs, hooks-codex, hooks-claude-code, schedule, dsh-session-title-llm | 原名 |
| 其余 | **任何其它名字** | `plugin:<完整原名>` |

同时的官方文档（`_asar_extract/v3tov4.README.md`）：
- :120 "A plugin source requires a string `plugin`, including the empty string. Conversion removes that property, replaces `kind`, and preserves every other own JSON property."
- :130 "Any other plugin name → `plugin:` followed by the complete original name"
- :134 "The complete plugin string is retained after `plugin:`: a plugin named `acme` becomes `plugin:acme`. Direct sources, including unknown and already-prefixed kinds, keep their original kind and every own JSON field."
- :223 "Producer attribution | Interpreted message slots require an object source with a nonempty, non-`plugin` kind. **Unknown attribution and own JSON metadata survive**; this does not grant a producer runtime authority."

### 实测映射（跑真实迁移 stage：`createSessionFormatV3ToV4([]).createStage(...)` + `transformEvent`）

```
plugin=localpost                              -> kind={"kind":"plugin:localpost"}
plugin=acme                                   -> kind={"kind":"plugin:acme"}
plugin=@dsh-external/dsh-localpost-postmaster  -> kind={"kind":"plugin:@dsh-external/dsh-localpost-postmaster"}
plugin=goal                                   -> kind={"kind":"goal"}
```

即：**`plugin:'localpost'` 是宿主自己认定的生产者身份串，其 V4 kind 就是 `plugin:localpost`。**

---

## 3. (b) 有没有生产者/插件注册表？

**没有运行时注册表。这是硬编码映射 + 一条"来者不拒"的准入规则。**

证据：
1. 映射表是 `Object.freeze` 字面量 / `new Set([...])` 字面量，编译进产物：`_asar_extract/index.js:51-85`；同一份 `RENAMED` 表被原样复制进持久化 worker 包：`_asar_extract/worker.cjs:10890-10896`（`Object.freeze({...})`）。
2. 全 app.asar 文本扫描（8519 个 js/cjs/mjs）中 `producerKind` 只出现在 1 个文件、`registerProducer`/`producerRegistry` 出现 **0** 次、字面量 `"plugin:"`/`'plugin:'` 出现 **0** 次（只有模板串 `\`plugin:${...}\``）。
3. 真正管准入的 `source()`（`index.js:124-127`）只做四个判断，**没有任何表格查询**：
   ```js
   if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
       || value["kind"].length === 0 || value["kind"] === "plugin")
     throw new SessionFormatError("format v4 message requires a producer-owned source kind");
   ```
4. 另一处含 `plugin` 的 `SOURCE_KINDS` 集合（`worker.cjs:9989-10005`）属于 **V2→V3** 的历史迁移（同一 bundle 的 `../session-format-v2-to-v3/src/payload.ts` 区段，用于 :10100 `cannot safely transform unclassified message source`），与 V4 准入无关，且它本身就把 `"plugin"` 列为合法——正是"旧世界"的表征。
5. 结论性推论：**注册键不存在**；V3 时代的键是"插件身份串"（首方用短名如 `goal`/`schedule`，也有包名形态 `@deepseek-ai/dsh-system-prompt`）。对第三方，V4 的规范表达就是 `plugin:<完整身份串>`。LocalPost 的身份串历来是 `'localpost'`（`dsh-adapter.mjs:44`、`receiver.mjs:140` 一直如此），所以 `plugin:localpost` 是唯一"新旧同名"的选择。

---

## 4. (c) 真实代码：谁在用 `kind:'plugin'`，谁已经在用"自有 kind"

### 4.1 已废弃形态（V3 wrapper）在**文档**里仍在流传 —— 这正是我们踩坑的根源

| 位置 | 内容 | 性质 |
|---|---|---|
| `dsh-agent/README.md:50-57`（宿主自己的包文档） | 示例 `handle.agent.steer({ content: […], source: { kind: 'plugin', plugin: 'my-plugin' } })` | **过时**：当前 `dsh-agent@0.2.0-rc.2` 的 README 仍这么写，adapter 照抄并不奇怪 |
| `dsh-agent/README.zh.md:56` | 同上 | 同上 |
| `dsh-repeat-tool-reminder/README.md:91` | "来源为 `{kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice', summary: …}`" | **过时**：见 4.2，实际代码已改成自有 kind |
| `dsh-session-format-v2-to-v3/README.md:72` | 合成 system 消息来源 `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }` | 历史格式文档 |
| 已发布的旧 SDK（用户插件树内 vendored）：`tools/dsh-super-injector/node_modules/@deepseek-ai/dsh-llm@0.0.1-rc.5/lib/types/message.d.ts:94-104` | `MessageSourceMap { user; plugin: { kind:'plugin'; plugin:string } & ContextFormed; model; tool }`，注释 :92 "Merge-extensible sum type — plugins add their own `kind`s." | 旧版类型确实声明过 `plugin` 变体；同文件 :42-54 定义了 `ContextForm = … \| 'relay' \| 'recall'`（"A message another agent addressed to this one."）——我们的 `form:'relay'` 词源在此 |
| `tools/dsh-super-injector/node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.js:144` | `message(source = { kind: 'plugin', plugin: 'dsh-llm/assembler' })` | 旧版 SDK 内部生产者也用 wrapper |
| `tools/dsh-super-injector/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:121` | `{ kind: "plugin", plugin: "user-approval" }` | 旧版首方包 |
| `worker.cjs:9785` / `worker.cjs:10769` | `{kind:"plugin", plugin:"goal"}` / `{kind:"plugin", plugin:"@deepseek-ai/dsh-system-prompt"}`（role: system） | **宿主二进制内的 V3 编解码器/迁移器**——它在**读/合成旧记录**，不是在写 V4 |

### 4.2 当前宿主真正的生产者写法（`0.2.0-rc.2`，裸身份作 kind）

| 生产者 | 代码 | source |
|---|---|---|
| `dsh-repeat-tool-reminder/lib/index.js:1458-1462` | `/** The \`{kind:'repeat-tool-reminder'}\` producer source stamped on every reminder */ const REMINDER_SOURCE = { kind: "repeat-tool-reminder" };`（:1572 带 `form: "notice"`） | `{kind:'repeat-tool-reminder', form:'notice', …}` |
| `dsh-schedule/lib/index.js:1594` | `source: { kind: "schedule" }` + `agent.followup(message)` | `{kind:'schedule'}` |
| `dsh-cordis-host-runner/lib/index.js:2393/2402/2415/2428/2455` | `source: { kind: "cordis-host-runner" }`（steer / inject） | `{kind:'cordis-host-runner'}` |
| `dsh-subagent/lib/types/continuation-messages.js:10-11` | `kind: 'agent-message', form: 'relay', senderSessionId` （`subagent/index.js` 里 `form: "relay"`） | **V4 里"给本 agent 的跨 agent 消息"的一等生产者** |
| `dsh-llm/lib/index.js:93` / `dsh-tools/lib/index.js:1386` / `dsh-spill-policy:248` | `{kind:'system-prompt'}` / `{kind:'ptc-mode'}` | 内置 |

当前 `MessageSourceMap`（宿主 `dsh-llm@0.2.0-rc.2` 的生成类型，`lib/typert.host.js:417`）**已不含 `plugin` 成员**，且含一等定义：

```ts
// lib/typert.host.js:233（行内字符串声明）
export interface AgentMessageSource {
    readonly kind: 'agent-message';
    readonly form: 'relay';
    readonly senderSessionId: SessionId;
}
```

> 说明：`plugin` 成员在 0.0.1-rc.5（旧发布）里存在，在 0.2.0-rc.2 的 `MessageSourceMap` 里已移除——这就是"发出者按旧文档写、宿主按新契约收"的错位。

### 4.3 派发用的 API 契约（rc.2）

`dsh-agent/README.md:45-59`："The handle's methods route **identified user-role messages** into the agent's inbox. `followup()` queues an ordinary next-turn prompt and wakes the driver"。示例就是 `{content, source}`（无 `id`/`role`）——宿主自己补 `role:'user'` 并铸 `id`（`dsh-llm/lib/index.js:37-63`：`createMessage` 里 `id: brandString(randomUUID())`，`createUserMessage` 补 `role:"user"`）。**message 形状本身不用动，只需改 source。**

---

## 5. (d) role 相关差异

- `producerKind` 里**唯一**对 role 敏感的映射是 `@deepseek-ai/dsh-system-prompt`：`role === 'system' → 'system-prompt'`，其它 role → `'runtime-context'`（`index.js:88`，文档 `v3tov4.README.md:127-128`）。
- 实测 role 矩阵（同一 stage，同一条消息换 role）：

```
plugin \ role                              user                 assistant            system
localpost                                  plugin:localpost     plugin:localpost     plugin:localpost
@deepseek-ai/dsh-system-prompt             runtime-context      runtime-context      system-prompt
goal                                       goal                 goal                 goal
acme                                       plugin:acme          plugin:acme          plugin:acme
```

- 结论：**LocalPost 与 role 无关**（`followup` 固定 user-role），role 不会拯救也不会破坏 `plugin:localpost`。
- 另一处 role 影响是"消息在哪个槽被校验"：`assertV4SourceRowAdmission`（`worker.cjs:10918-10928`）对 `user/message` 取 `data` 本体，对 `system/assistant/tool` 取 `data.message`；`developer/message` 另走 `assertV4DeveloperData`（`index.js:297-301`，同样要求 nonempty 且非 `'plugin'`）。**四条路径对 kind 的要求一致。**

---

## 6. 给 adapter-fixer 的推荐改法（含取舍与风险）

### 方案 A（推荐）：只改 adapter 的"宿主边界"，内部请求词表不动

`localpost/dsh-adapter.mjs`
- 保持 :43-47 的请求自检不变（仍是 `kind==='plugin' && plugin==='localpost' && form==='relay'`）——这样 receiver 与 E2 测试夹具无需改动；
- 只把 :68 交给 `agent.followup` 的 source 改成 `{ kind: 'plugin:localpost', form: 'relay' }`；
- 在 :66-68 加一行注释说明"请求词表(V3 风格) ≠ 宿主持久化词表(V4 生产者自有 kind)"，并引用本文件。

**理由/取舍**：
- 改动面最小（adapter 内 1 行 + 注释），不触碰 `receiver.mjs`、不触碰受理/账本逻辑；
- adapter 本就是"宿主边界适配器"（其文件头注释自称 same-host adapter for the installed DSH），把旧词表翻译成当前宿主词表正是它的职责；将来宿主再改拼写，只需改这一处；
- 已核验**无账本副作用**：acceptance 账本与信封摘要是 `{key, target, messageReference, digest}`（`ledger-acceptance.mjs:31-43`），`digest = envelopeDigest(envelope)`（`mailbox.mjs:14`，只对信封算 sha256）。**source 不参与任何持久摘要**，改名不会引起 `digest_conflict`、不会使已受理信件失效。

**必须同步改的测试**（否则测试会红）：
- `localpost/dsh-adapter.test.mjs:59`：`assert.deepEqual(delivered.source, { kind: 'plugin', plugin: 'localpost', form: 'relay' })` → 期望新形态；
- `dsh-adapter.test.mjs:36`：请求夹具（**这里取决于选 A 还是 B**：方案 A 下它仍是 V3 词表，不用改）；
- `dsh-adapter.test.mjs:96`：非法形态枚举里的 `{ source: { kind: 'plugin', plugin: 'localpost', form: 'steer' } }` 仍应被拒（保持）；
- `localpost/fixtures/fake-dsh-host.mjs:51` 只做 `message.source` 透传，**形状无关，无需改动**。

### 方案 B（不推荐）：全链词表升级

同时改 `receiver.mjs:140`、`dsh-adapter.mjs:44`、`dsh-adapter.test.mjs:36/96`。语义更"干净"，但把改动扩散到 receiver（生产派发路径的另一半）与三处测试；E2 验收夹具若固定了请求形态还要一起动。除非团队决定"内部请求也不再讲 V3 方言"，否则收益不抵风险。

### 风险与边界（必须写进回归说明）

1. **别在同一份代码里混用两种拼写**：`plugin:localpost`（与历史迁移同名）和 `localpost`（首方裸名风格）都能通过准入，但会让同一生产者在历史/新记录里分裂成两个 kind，后续归因统计（UI trigger 标题、会话分析）会对不上。选 `plugin:localpost`。
2. **`form:'relay'` 必须保留**。客户端 `dsh-client-ui-chat/lib/client.js:830-875` 的 `contextBody(form, …)` 对 `form` 是**封闭并集**，未知值走 `:871-873 default: throw new Error("unreachable context form: …")`；`'relay'` 是已知值（`:863 RelayBody`，词义正是"另一个 agent 发给本 agent 的消息"）。kind 未知**不会**炸：`turnTriggerDetails`（`:6627-6672`）对未知 kind 走 `:6667 default: break`，退回通用 "request" 标题/图标。
3. **不要改用 `{kind:'agent-message', form:'relay'}`**（虽然准入也 PASS）：该 kind 的一等类型要求 `senderSessionId: SessionId`（`dsh-llm/lib/typert.host.js:233`，实际生产者见 `dsh-subagent/lib/types/continuation-messages.js:10-11`），语义是"子 agent 续跑通道"。邮件中继的发信方是另一个 agent 身份（codex/claude/…），没有 DSH session id 可填；伪装成 `agent-message` 会让 UI 走 "agent" 图标与子 agent 语义，且准入层**不校验该字段**（只校验 kind），错误会被静默带进持久化记录。
4. **宿主文档仍在教旧写法**（`dsh-agent/README.md:56`、`dsh-repeat-tool-reminder/README.md:91`）。修复时请在 adapter 留注释指向本契约文件，避免下次有人"照文档改回去"。
5. **预检/能力位不受影响**：`capabilities.sourceIsRelay`（`dsh-adapter.mjs:27`）与 `SUPPORTED_VERSION = '0.2.0-rc.2'` 是插件自述，与宿主 kind 语法无关——本次不需要（也不应该）动它们。
6. **仍未实测的环节**：我没有启动/停止任何真实 receiver、没有派发真实信件（遵守任务硬约束）。上述结论全部来自宿主自身代码路径 + 真实导出函数的定向调用；端到端复验必须由 E2 隔离环境重跑（受理→派发→宿主受理→会话落盘→回执），修复后 E2 才能从"被阻塞"改判。

---

## 7. 复现方式（评审可直接照做）

**A. 打开 asar（不是目录，是归档）**

```js
// Electron-node（DSH harness 的 run_code/PTC 运行时即是）内：
process.noAsar = true;                       // 否则 fs 会把 .asar 当目录处理，statSync 得 size=0
const fd = fs.openSync(ASAR, "r");
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4), jsonLen = head.readUInt32LE(12);
const hbuf = Buffer.alloc(jsonLen); fs.readSync(fd, hbuf, 0, jsonLen, 16);   // 头 JSON 从偏移 16 开始
const header = JSON.parse(hbuf.toString("utf8"));
const dataStart = 8 + headerSize;             // 文件数据区起点（本构建 = 3392064）
// 条目：header.files[...] 递归，叶子带 { offset, size }；实际字节 = dataStart + offset
```

**B. 关键行的字节偏移（本构建，可直接 `readSync` 命中）**

| 断言 | 条目 | 行 | app.asar 字节偏移 |
|---|---|---|---|
| `function producerKind(` | `dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` | 87 | 55617649 |
| `format v4 message requires a producer-owned source kind`（V4 准入） | 同上 | 126 | 55619853 |
| 同串（持久化 worker 的写入路径） | `dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs` | 10902 | 56447598 |
| `export interface AgentMessageSource` | `dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js` | 233 | 52513582 |

（已逐个用 `readSync(..., offset)` 回读校验：读出的正是所引用的那段文本。）

**C. 直接跑宿主判定函数**：`await import("file:///C:/AI_ASSIST/work/e2-contract/verify-source-kind.mjs")`

**D. 迁移映射实测**：`createSessionFormatV3ToV4([])` → `createStage({sourceHeader:{version:3,id,createdAt,isSeeded:false,delegationDepth:0}, sourceInheritedEventCount:0})` → `transformEvent({type:'user/message',seq:0,time:0,data:{id,role:'user',content:[…],source:{kind:'plugin',plugin:'localpost',form:'relay'}}}, {emitEvent:e=>…})`（本目录脚本已内联该路径，见 §1/§2 输出）。

---

## 8. 未找到 / 未知（按任务要求明写，不推测填充）

- **未找到**任何"生产者注册 API"或运行时注册表（`registerProducer`/`producerRegistry` 全 asar 0 命中；映射表全是编译期字面量，见 §3）。
- **未找到**对第三方插件 kind 的**命名强制规范**文字：宿主只强制"非空且 ≠ `'plugin'`"；`plugin:<身份串>` 的用法见于迁移兜底与时迁移 README（§2），不存在"必须带 `plugin:` 前缀"的显式条款。推荐它是因为**与宿主自己的迁移产出逐字节一致**，不是因为发现硬性规则。
- **未找到**当前宿主对 `kind:'plugin'` 的任何"兼容/自动重写"入口：全 asar 里 `rewriteV3MessageSource` 只有 V3→V4 迁移一处调用（`index.js:1492`）。因此"让宿主兼容旧写法"不属于本次可选项（且硬约束禁止改宿主/main）。
- **未实测**（被任务硬约束排除）：真实 receiver 派发、真实 `.mailbox` 流转、宿主落盘后的端到端会话记录。
- **未核验**：其它 agent 身份（codex/claude 等）是否存在带 session id 的中继通道——若将来 LocalPost 要让宿主 UI 把它识别为 "agent" 触发器而非通用 "request"，需要单独立项（见 §6 风险 3）。

---

## 9. 本任务产出清单

| 路径 | 说明 |
|---|---|
| `work/e2-contract/host-producer-kind-contract.md` | 本文件 |
| `work/e2-contract/verify-source-kind.mjs` | 可复跑的宿主受理矩阵验证脚本 |
| `work/e2-contract/_asar_extract/index.js` | `dsh-session-format-v3-to-v4/lib/index.js` 只读副本（sha256 与 asar 条目一致） |
| `work/e2-contract/_asar_extract/worker.cjs` | `dsh-session-persistence-jsonl/lib/worker.cjs` 只读副本（同上） |
| `work/e2-contract/_asar_extract/v3tov4.README.md` | 该包的官方契约文档副本 |
| `work/e2-contract/_asar_extract/llm.typert.host.js` | 宿主 `dsh-llm` 生成类型副本（`MessageSourceMap`/`AgentMessageSource`） |
| `work/e2-contract/_asar_extract/agent.README.md` | 宿主 `dsh-agent` README 副本（V3 方言示例出处） |
| `work/e2-contract/_asar_extract/` 其余副本 | `chat.client.js`(ui-chat) · `subagent.index.js` · `subagent.continuation-messages.js` · `dsh-repeat-tool-reminder.index.js` · `session-format.index.js` · `session.index.js` · `session.types.index.js` · `session.types.js` · `session.surface.js` · `session.README.md` · `llm.index.js` · `llm.message.js` · `agent.dispatch.js` · `agent.types.index.js` · `trajectory.client.js` · `v0tov1.index.js` · `lib.index.js`(dsh-llm 打包入口) · `message.js`/README.md(早期命名重复，内容同 `llm.message.js`/`v3tov4.README.md`) |

> `_asar_extract/` 下的文件只是**取证副本**，不属于任何源码树；不需提交、可随时删除。本次未改动 `main`、`tools/dsh-localpost-postmaster/**`、`docs/evidence/**`、`.mailbox`，未触发插件热重载。
