# 自动派发启用验收方案（E）：可执行清单

> 2026-10-02 修订版 · 依据 `docs/live-acceptance.md`、`docs/integration.md` 与 codex 的启用审查更正
> 相关口径：`docs/rotation-decisions.md`（三道门槛、绑定契约、验收矩阵）
> 状态：**方案（未执行）**。生产派发保持关闭。

## 0. E 现在**跑不了**：缺的是实现，不是验收

`localpost/dsh-adapter.mjs` 注释明确：宿主集成必须先**提供并验证**绑定与受理契约。
适配器启用需四个能力全真：

| 能力 | 当前来源 | 现状 |
|---|---|---|
| `wholeTurn`（整轮后投递） | `runtimeVersion === '0.2.0-rc.2'` | ✅ 运行中的 harness 正是 rc.2 |
| `sourceIsRelay` | 代码内固定 | ✅ |
| **绑定提供者**（原 `trustedFocus`） | 需 `resolve() + verifyBinding()`；到达路由由受控投递写到达记录（`arrivalRoute`，2026-10-03 起） | LocalPost 侧已实现（T1）；DSH rc.2 无 `chatBinding`/`describeThread` → ❌ **仍关闭** |
| **受理提供者**（`dispatchIdempotent`） | 需 `durable + idempotent + acceptOnce()` | LocalPost 侧已实现（`ledger-acceptance.mjs`，T1）；只能 at-most-once |

**结论**：先补齐 `docs/rotation-decisions.md` §2 的四项实现，才能开始 E。

## 1. 契约变更：`trustedFocus` → **`trustedBinding`**

实测 DSH 宿主侧**没有**「当前可见会话」API（`currentSessionId` 只在客户端代码里）。
适配器契约因此从「可信焦点」改为「**可信显式绑定**」——不猜焦点，由用户主动绑定。

完整绑定要求见 `docs/rotation-decisions.md` §3；核心是**永不回退**到最近/最新/看起来像的会话。

## 2. E 验收项（修订后）

**共同前置**（安全护栏）：

- 隔离测试根（不碰生产 `C:/AI_ASSIST/.mailbox`）：`work/localpost-e-test/`
- 隔离测试会话 A、B（建议 `E-test-A` / `E-test-B`），不用于真实工作
- 测试信 id 一律 `mcptest-` 前缀，**不进生产账本**
- 生产 `dispatch` 全程关闭；只在测试根内启用
- 证据落盘 `work/localpost-six-gates-evidence/e-acceptance/`
- **任一步失败 → 立即停止、保持关闭、按 §4 处理**，不得"再试一次就好"

| # | 验收项 | 步骤（谁做） | 通过标准 | 证据 |
|---|---|---|---|---|
| **E1** | **可信显式绑定 + 不投错会话** | ① 用户在会话 A 内执行显式绑定动作 ② 我在测试根投 `mcptest-1` ③ 用户把 UI 切到 B 并停留 ④ 观察 | 信只出现在 **A**；**B 里没有**；receiver 记录 `delivered→A`；**无任何 fallback 痕迹** | A 的 transcript 片段 + B 为空 + receiver 日志 + 绑定记录（hostId/threadId/generation） |
| **E2** | **等整轮结束** | ① 用户在 A 里起一个明显较长的回合 ② 回合中我投 `mcptest-2` ③ 观察投递时间点 | 投递发生在**该回合结束之后**；**未插入**当前回合 | 回合起止时间戳 + 投递时间戳 |
| **E3** | **关客户端不丢；重开后仍只投原绑定 A** | ① 我投 `mcptest-3` 后用户**立刻关闭客户端** ② 等 30s ③ 用户重开 ④ 观察 | 关闭期间保持 pending；**只有原绑定的 A 以同一身份重新在线**才可投递；**恰好一次** | 队列状态前后对比 + A 的 transcript 仅一条 + 若期间 A 身份不符则仍 pending |
| **E4** | **幂等：重复事件 / 进程重启 / 同 key 重放** | ① 我制造 watcher 重复事件 ② **重启 receiver 进程** ③ 重放同一 `agent:id` ④ 观察 | 三件事合并后**只产生一次投递** | 投递计数 = 1 + 跨重启状态文件 + 重放被去重 |
| **E5** | **不确定受理不二次唤醒 + 真实 result 对账** | ① 我模拟"写了但收不到 receipt" ② 观察是否二次唤醒 ③ 用**真实 LocalPost result** 对账 | 进入 `uncertain/needs_reconcile`；**绝不二次唤醒**（at-most-once）；对账后收敛为终态 | 状态字段 + 无第二次 followup 调用 + 对账后的终态记录 |
| **E6（新增）** | **人工与自动单消费者** | ① 让一封 `mcptest-` 信同时被人工入口与自动 receiver 看到 ② 双方尝试处理 | **只有 claim 所有者能处理**；另一方被拒绝（不是静默重复处理） | claim 台账 + 被拒方的记录 |

**E2 的好消息**：DSH rc.2 的 `followup(input)` → `send(input, "next-turn", true)` 语义上就是「整轮之后投递」，
第 2 项需要的是**验证**而不是重写。

## 3. 分工（把用户动作压到最少）

| 我做 | 用户做 |
|---|---|
| 建隔离测试根、写测试信、受控启动 receiver（仅测试根）、制造重复/重放/丢确认场景、读状态、记录证据、出报告 | **执行一次显式绑定**（E1）· **切换会话 A/B**（E1）· **在 A 里跑一个长回合**（E2）· **关/开客户端**（E3） |

预计用户动手 **4 次**，每次 1 分钟内。其余在测试根内完成，**不碰生产**。

## 4. 失败与回退

- 任一项不通过 → **保持 `dispatch` 关闭**，存档失败现象/日志/队列状态，报告 codex 与用户。
- **明令禁止**：用"设个 capability 标志"绕过（`integration.md` 禁止）；
  静默退化成"投给最近/最新会话"；在生产根复现。
- 测试根与测试会话在验收结束、证据留档后清理。

## 5. 全部通过之后（仍不等于启用）

E 通过只是**第一道门槛 T1**。仍需：

1. codex 复核证据 → 结论；
2. **用户明确批准试点**（T2），并确认接受 C 的本地篡改风险与「显式绑定聊天」交互；
3. 部署 runbook 由用户亲自执行 + 宿主两轮退出验收零残留（T3）；
4. 首次只启用**一个信箱、一个绑定会话、精确发件人白名单**，权限只限自动阅读/分析/回复；
   改代码、改文件、配置、外部操作仍需单独授权；
5. 提供**一键禁用**；异常、不确定态、绑定漂移、版本变化一律 fail closed。

## 6. 本方案未做的事

未启用任何派发、未启动 receiver、未创建测试根或测试会话、未改任何生产配置、未联系任何真实模型。
