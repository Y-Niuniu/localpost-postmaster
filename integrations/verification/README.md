# verification —— 外部集成（wrapper 与三个唤醒桥）的验证套件

把 `integrations/` 里那批**不在 Git 里**的交付物（wrapper + 三个桥）的验收脚本收进仓库，使结论**能从仓库复现**。
起因：codex/GPT 源码评审多轮要求"保存确切源码快照/哈希**和测试证据**"。

> **2026-10-06 二轮加固**（GPT 对首版的判定是"暂不通过交付验收"，两处缺口都已修，见下）：
> - **[P1 已修] 测试隔离**：首版靠"本机恰巧没有 `agentapi`"来避免真发消息，且 Gemini 夹具继承 PATH、用 `dryRun=false` + **生产会话 id** —— 装了 agentapi 的机器会**真唤醒**。现在改为 `lib/harness.mjs` 的 `isolatedEnv()`：**假 `agentapi` 前置 PATH**（可设退出码/stdout、调用写入 `agentapi-calls.log`）+ 临时 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` + **专用测试会话 id**（`TEST_CONVERSATION_ID`）。测试**永不真发**，且能断言"到底调用了几次"。
> - **[P2 已修] 被测源码位置**：首版常量指向 `C:/Users/<user>/...` 的生产桥与生产 `.mailbox` ⇒ 克隆仓库**不能**验证本提交。现在所有套件从**仓库内**取源码：`integrations/bridges/{gemini,claude,codex}`、`integrations/dsh-mailbox-mcp/server.mjs`、`localpost/`（内核闭包）。

## 怎么跑

```powershell
cd <repo>
node integrations/verification/test-gpt-review-fixes.mjs     # 21/21
node integrations/verification/test-checkers-gates.mjs       # 14/14
node integrations/verification/test-gemini-wake-state.mjs    # 9/9
node integrations/verification/test-claude-wake-lock.mjs     # 3/3
node integrations/verification/test-mailbox-mcp-reply.mjs    # 9/9
node integrations/verification/test-codex-check.mjs          # 4/4
# 合计 60/60（全部在临时根、隔离环境；不碰生产、不真发消息）

# 生产只读冒烟：**必须显式开启**（避免克隆者无意触碰生产信箱）
$env:LOCALPOST_SMOKE_PRODUCTION=1; node integrations/verification/smoke-mcp-production.mjs   # 5/5
```
含生产 smoke 合计 **65/65**；内核本体另有 `node scripts/test.mjs`（**383/383 + legacy 45/45**）。

## 各套件覆盖什么

| 脚本 | 覆盖 |
|---|---|
| `test-gpt-review-fixes.mjs` | GPT 两轮 8 个隔离反例（不确定结果不重发、自定义 reply_id、伪造回执、终态优先、**路径穿越**、旧演练不耗额度、上限→冷却、锁原子/失锁、结构化故障字段 + wrapper 转换 + **无 code 不造字段**）+ 身份 fail-closed 开关 |
| `test-checkers-gates.mjs` | 两个 checker（claude/codex）× 四道闸门：合格→提醒、有效等待回执→静默（含**内核式命名 + 已归档**）、上限→冷却→恢复、新信仍提醒、终态优先、`result`/非白名单回归 |
| `test-gemini-wake-state.mjs` | 状态机 + **调用次数断言**：基线/已送达/旧"演练"迁移/真实发送成功(恰好 1 次)/失败计数/重试到 exhausted(不超 3 次)/旧"真送达"迁移；并断言调用参数用的是**测试会话 id** |
| `test-claude-wake-lock.mjs` | 单实例锁：活守望不被接管、死持有者被接管、退出不删他人的锁 |
| `test-mailbox-mcp-reply.mjs` | wrapper 回执/归档走共享内核：终态归档、非终态独立 reply_id 且不归档、身份绑定拒读他人、非法 outcome 被拒、**stdin 关闭前最后一条仍完成** |
| `test-codex-check.mjs` | codex checker 基础判据（白名单 task → block；`result`、非白名单、空箱静默） |
| `smoke-mcp-production.mjs` | **生产只读冒烟**（显式开启才跑）：roster / README / 读自己 / 拒读他人 / stderr 干净；**不写任何信箱内容** |

## 夹具助手（`lib/harness.mjs`）

- `REPO` / `SRC.{wrapper,bridges,kernel,gemini,claude,codex}` —— 全部指向**仓库内**源码
- `makeRoot(tag)` —— 系统 temp 下的临时根
- `fakeAgentapi(root,{exitCode,stdout})` —— 假 `agentapi`：`.cmd`(Windows) + 无扩展名(POSIX)，调用追加到 `<root>/agentapi-calls.log`
- `isolatedEnv(root, api)` —— 假 agentapi 前置 PATH + 临时 DATA 目录（自动建目录）
- `stage(src,root)` / `stageKernel(root)` —— 把被测脚本/内核闭包拷进临时根（脚本用 `import.meta.dirname` 定位自己的 config/state/log，**必须**拷进临时根再跑）

## 与生产的关系

这些脚本验证的是 `integrations/` 下的交付物，**不修改生产位置**；把仓库改动同步到生产位置（或反向回抄）请遵循 `integrations/README.md` 的部署/回退约定，并保持两边逐字节一致（SHA256 比对）。
