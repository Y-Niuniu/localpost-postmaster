# DSH 宿主能力事实报告（T1 准备，只读）

> 2026-10-03 · 回应 codex 工单 `codex-20261003-auto-t1-host-prep`。**只读调查，未改生产、未启用派发。**
> 方法：自建最小 asar 读取器（`work/localpost-six-gates-evidence/asar.mjs`）直接读**本机实际安装的** DSH 代码。

## 一、宿主身份（实测，不信 PATH）

| 项 | 值 |
|---|---|
| 运行中的宿主 | **DeepSeek Harness 桌面版**（`DeepSeek Harness.exe`），进程启动于 2026-10-03 11:31:22 |
| dsh 代码位置 | `C:\Users\16548\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（**121,348,951 字节**，内含 `dsh/node_modules/@deepseek-ai/**`，共 **12,967** 条目） |
| **不能**当作证据的 | PATH 里的 npm 版 dsh：`...\Roaming\npm\node_modules\@deepseek-ai\dsh` = **0.1.5-rc.1**（与运行版不同） |
| asar 内是否有可直接读的副本 | `app.asar.unpacked/dsh/` 只有少数包（desktop-host、session-log-export、libreoffice-kit），**主体不在其中** |
| Node | `C:\Program Files\nodejs\node.exe` 24.15.0（SHA-256 `3331E1FF…E9B4A5`，见方案 §二.4 基线） |

## 二、可用宿主接点（精确符号）

### 1. 在线 agent 解析

- 文件：`dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js`
- 符号：`AgentRegistry`（`ctx.agents` 服务），注释原文：**"Agent service (`ctx.agents`): tracks live agents"**
- 取用：`this.get(sessionId)`（:339 `resolve: (sessionId) => this.get(sessionId)`）
- 语义：**只返回在线的 agent**；会话不在线 → 取不到 ⇒ "是否在线"可观测 ✅

### 2. 整轮之后投递（whole turn）

- 文件：`dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`
- `:850` `async prompt(request)` → `:882` `if (request.mode === "steer") agent.steer(message);` `:883` `else agent.followup(message);`
- 轮次边界守卫在 `:966`：`if (request.action.kind === "steer" && (target !== "next-turn" || agent.status !== "running")) throw new RemoteError("session/steer-unavailable", …)`
  ⇒ **`agent.status` 可判断"当前是否正在跑一整轮"**
- 队列语义：`dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` 中的 `"next-turn"` / `"next-step"` 两个队列，
  `:92` 注释 **"Durably cancel all pending input, clearing next-step before next-turn"** ⇒ 队列是**持久**的 ✅
- **结论**：`agent.followup(message)` 就是"本轮结束后投递"，且宿主自带持久队列。

### 3. 用户在聊天 A 内的**显式绑定动作**（关键）

- 文件：`dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js`
- 模块注释原文：**"Plugin-owned human-command registry shared by interactive UI adapters"**
- 注册：`register(definition)`（:262 "**Register a global or calling-agent-scoped command**"）
  - definition 形状（`normalizeDefinition`）：`{ definitionId?, name, description, input?: {hint, attachments?}, recordInput?, handler }`
- **handler 收到的上下文（决定性证据）**：`:379` 构造并冻结 `invocation`
  ```js
  const invocation = Object.freeze({ commandId, agent, rawInput: parsed.rawInput, attachments, signal });
  const output = command.definition.handler(invocation);   // :388
  ```
  ⇒ **handler 直接拿到 `invocation.agent`，也就是"用户在哪条聊天里敲下这条命令"的确切 agent/session** ✅
- 另有 `list(agent)` / `find(agent, name)`，以及"Parse and execute a known command **without sending it to the model**"。

### 4. 持久受理状态

- **宿主不提供**可跨崩溃证明的原子受理回执（与 codex 早前判定一致：`followup()` 不给调用方 receipt）。
- 记录位置只能在 LocalPost 侧：现有 `runtime/queues/<agent>.json` + 新的逐信 claim 台账（Claude 的 `letter-claims`/`session-binding` 模块）。
- 因此只能承诺 **at-most-once wake + 显式 result 对账**，**不得宣称 exactly-once**。

### 5. 客户端关闭 / 重启 / 身份变化时可验证的事实

| 事实 | 能否验证 | 依据 |
|---|---|---|
| 会话当前是否在线 | ✅ | `ctx.agents.get(sessionId)` 取不到 |
| 会话当前是否在跑一轮 | ✅ | `agent.status !== "running"`（`:966`） |
| 会话身份是否仍是同一个 | ⚠️ 需自己记录并比对 | 宿主无"身份版本"概念，必须由我们持久记录 `hostId/sessionId/cwd/generation` 再校验 |
| 客户端重启后原会话 | ⚠️ 同上 | 重启后需重新 `get(sessionId)`；取不到就 pending，**不得回退到最近会话** |

## 三、宿主**没有**的能力（禁止补洞）

1. **没有 UI 焦点 / "当前可见会话"API**（前一日已实测：`activeSessionId`/`visibleSession`/`focusedSession` 全无；`currentSessionId` 只在客户端 UI 代码里）。
2. **没有不可变 / 密封的插件注册**（无 machine-level overlay、无 immutable registration、无 read-only profile）。
3. **没有可跨崩溃证明的受理回执**（见二.4）。
4. **没有"列出某用户当前打开的聊天"**——绑定只能来自命令调用本身携带的 agent。
5. 禁止用：最近会话、mtime、草稿、UI 焦点猜测、进程内 Map 兜底。

## 四、建议的最小桥接点

1. **绑定**：LocalPost 插件注册一条人类命令（如 `/localpost-bind`）。用户在**目标聊天 A** 里敲它；
   handler 从 `invocation.agent` 读取确切会话身份，写 `{hostId, sessionId, cwd?, generation, createdAt, source:"user-command"}` 到绑定文件。
   —— 全程**不猜焦点**，满足 codex 绑定契约第 1 条。
2. **投递**：`ctx.agents.get(boundSessionId)` → 取不到 ⇒ 保持 pending（**永不回退**）；取到 ⇒ 校验身份/代次 → `agent.followup(message)`。
3. **受理**：LocalPost 侧持久台账记 `reserved → dispatching → accepted`，崩溃进 `uncertain/needs_reconcile`；用显式 result 对账。
4. **重启后**：重新 `get(sessionId)`；身份或代次不符 ⇒ fail closed 并告警。

## 五、风险（供审计）

1. `invocation.agent` 的对象生命周期：命令执行期间有效；**绑定必须立刻落盘**，不能持有 agent 引用当长期凭据。
2. 会话 id 复用/身份漂移：宿主无身份版本，必须靠我们的 `generation` + `handoffDigest` 校验。
3. `followup` 无回执 ⇒ 只能 at-most-once；不确定态必须人工/result 对账收口。
4. 命令注册属于**插件装配**范围：需要插件在"聊天 A 所在 profile"里加载；这一点与第 3 步「装配不可变」的已知缺口同源。
5. 本报告**只证明宿主接口存在**，**不等于** E 验收或生产启用。

## 六、本次未做

未改任何生产文件、未启用 receiver 或自动派发、未唤醒任何真实 agent、未处理历史积压、未合并未审提交。

## 七、整合审查清单（T1 用，含 P0 门禁）

### 7.1 每次整合的固定动作

1. 核对 `base_rev` 是否等于当前 main；核对 commit 是否存在。
2. `git diff --name-status <base>..<commit>` 逐项确认范围；**出现未说明的既有文件修改即停**。
3. worktree 内跑：专项测试 → `node scripts/test.mjs`；记录原始数字与退出码。
4. 未经 codex 审计通过，**不得**合并 main。
5. 审计通过后：`--no-ff` 合并（保留被审 SHA）→ main 全量复测 → 双方核对远端 main SHA。
6. 回执写明 diff 范围、测试命令与数量、base/commit/merge SHA。

### 7.2 P0 门禁（来源：`codex-20261003-auto-t1-p0-integrator-gate`）

**必须满足（缺一即不得合并）**：

1. 自动转移前必须有**可验证的宿主 barrier / 租约撤销**，证明旧会话已完成相关整轮并失去该信处理权。
2. 宿主无法证明时：`accepted` 或受理结果不确定的信**固定为原 generation 的 `needs_reconcile`**，不得自动转移或重投；新 generation 仍可处理**新信**。
3. `retireSession` 失败且旧会话仍可能处理已转移信 ⇒ 轮换 **fail closed**，不得只记 warning 后宣称安全完成。
4. 旧 generation 的**迟到 result 只能作为原 owner 的对账证据**，不得与新 owner 同时完成一封信。
5. 候选会话验证必须绑定**全部**：`hostId / cwd / identity / generation / sessionId / authority / handoffDigest`，不能只信布尔回显。

**对抗测试（必须存在并通过）**：

- 旧会话仍活跃时尝试轮换 ⇒ 断言未证明撤权的信**不转移**。
- barrier 之后、逐信 CAS 前后分别崩溃 ⇒ 恢复后仍**只有一个 owner**。
- `retireSession` 失败 ⇒ 相关信保持冻结/待核对，**不进入新会话**。
- 旧代迟到 result 与新代竞争 ⇒ 断言**不能双完成**。

### 7.3 E1–E6 隔离入口（真机验收用，属 T1 之后的独立门槛）

- 隔离测试根：`work/localpost-e-test/`（不碰 `C:/AI_ASSIST/.mailbox`）；测试信 id 一律 `mcptest-` 前缀。
- 隔离测试会话：A、B 两个专用会话；生产 `dispatch` 全程关闭。
- 逐项步骤与通过标准见 `docs/live-acceptance-plan.md`（E1 绑定不投错、E2 整轮后投递、E3 关客户端不丢且只投原绑定、E4 幂等含重启与重放、E5 不确定不二次唤醒+真实 result 对账、E6 人工/自动单消费者）。
- E 全部通过 **仍不等于** 可启用：还有 T2 用户批准与 T3 生产部署两道独立门槛。

