# verification —— 外部集成（wrapper 与三个唤醒桥）的验证套件

把 `integrations/` 里那批**不在 Git 里**的交付物（wrapper + 三个桥）的验收脚本收进仓库，使"59/59、63/63"这类结论**能从仓库复现**，而不是只存在于工作台（`C:/AI_ASSIST/work/scripts/`）。
起因：codex/GPT 源码评审连续多轮要求"保存确切源码快照/哈希**和测试证据**"，并指出"只凭通过数宣称所有边界通过"的风险。

## 怎么跑

```powershell
cd <repo>
node integrations/verification/test-gpt-review-fixes.mjs     # 21/21
node integrations/verification/test-checkers-gates.mjs       # 14/14
node integrations/verification/test-gemini-wake-state.mjs    # 7/7
node integrations/verification/test-claude-wake-lock.mjs     # 3/3
node integrations/verification/test-mailbox-mcp-reply.mjs    # 9/9
node integrations/verification/smoke-mcp-production.mjs      # 5/5（生产**只读**冒烟）
node integrations/verification/test-codex-check.mjs          # 4/4
```
合计 **63/63**；内核本体另有 `node scripts/test.mjs`（**383/383 + legacy 45/45**）。

## 各套件覆盖什么

| 脚本 | 覆盖 |
|---|---|
| `test-gpt-review-fixes.mjs` | GPT 两轮 8 个隔离反例（不确定结果不重发、自定义 reply_id、伪造回执、终态优先、**路径穿越**、旧演练不耗额度、上限→冷却、锁原子/失锁、结构化故障字段 + wrapper 转换 + **无 code 不造字段**）+ 身份 fail-closed 开关 |
| `test-checkers-gates.mjs` | 两个 checker（claude/codex）× 四道闸门：合格→提醒、有效等待回执→静默（含**内核式命名 + 已归档**）、上限→冷却→恢复、新信仍提醒、终态优先、`result`/非白名单回归 |
| `test-gemini-wake-state.mjs` | 状态机：基线 / 已送达不重发 / 旧"演练"迁移（含计数不占正式额度）/ 失败重试到上限 exhausted / 演练不消耗 / 旧"真送达"迁移 |
| `test-claude-wake-lock.mjs` | 单实例锁：活守望不被接管、死持有者被接管、退出不删他人的锁 |
| `test-mailbox-mcp-reply.mjs` | wrapper 回执/归档走共享内核：终态归档、非终态独立 reply_id 且不归档、身份绑定拒读他人、非法 outcome 被拒、**stdin 关闭前最后一条仍完成** |
| `smoke-mcp-production.mjs` | **生产信箱只读冒烟**：roster / README / 读自己 / 拒读他人 / stderr 干净（不写任何信箱内容） |
| `test-codex-check.mjs` | codex checker 的基础判据（白名单 task → block；`result`、非白名单、空箱静默） |

## 运行前提（重要）

- 这些脚本最初在**本机**写成，内含**绝对路径**（`C:/AI_ASSIST/...`、`C:/Users/16548/...`）。换机器需先改路径常量；脚本会在临时根（`C:/AI_ASSIST/work/tmp_*`）建夹具，跑完自删。
- 夹具**必须把被测脚本拷进临时根再跑**（脚本用 `import.meta.dirname` 定位自己的 config/state/log；原地运行会读真实配置、扫生产信箱）。脚本里已按此实现。
- Gemini 夹具用 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 把状态/日志限定到临时根，**避免碰宿主 sidecar 数据目录**。
- 测试**不发送真实唤醒**（`agentapi` 在夹具环境不存在），也**不写生产信箱**；`smoke-mcp-production.mjs` 是唯一接触生产路径的脚本，且全为只读调用。

## 与生产的关系

这些脚本验证的是 `integrations/` 下的交付物；它们**不修改**生产位置。把脚本改动同步到生产位置、或把生产位置回抄进仓库，请遵循 `integrations/README.md` 的部署/回退约定，并保持两边逐字节一致（可用 SHA256 比对）。
