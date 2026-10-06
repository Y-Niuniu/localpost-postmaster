# docs/evidence —— 从 `work\` 入仓的验收/验收证据

**为什么在这里**：这些文件原先散在 `C:\AI_ASSIST\work\`（工作区，随时可清），但**仓库文档/代码注释引用了它们**
⇒ 一旦 `work\` 被清，引用就断。2026-10-06 工作区清理（claude 审计 + 交接，用户授权）时**逐字节拷入仓库**，
并改掉所有指向 `work/` 的引用。拷贝后 `work\e2-contract\` 与 `work\localpost-six-gates-evidence\` **即可删除**
（其余文件在别处另有逐字节副本，见交接文档）。

## docs/contracts/

| 文件 | 说明 | 谁引用 |
|---|---|---|
| `host-producer-kind-contract.md` | **宿主准入契约**：解释型消息只在生产者自有 source kind 下持久化（含 §0 与 §3 item 3 的原文） | `localpost/dsh-adapter.mjs:12`、`localpost/dsh-adapter.test.mjs:81`（注释逐字引用） |
| `verify-source-kind.mjs` | 该契约的**校验脚本**（原 `work/e2-contract/`） | 契约文档本身 |

## docs/evidence/

| 文件 | 说明 | 谁引用 |
|---|---|---|
| `step4-tags.txt` | six-gates 第 4 步（打标签）的核对命令与输出 | `docs/releases.md` |
| `step2-backup-drill.txt` | 2026-10-02 **首次备份演练**结果 | `docs/mail-backup.md` |
| `asar.mjs` | 自建最小 asar 读取器（读本机实际安装的 DSH 代码，用于能力报告） | `docs/host-capability-report.md` |
| `claude-rotation-worktree-suite.txt` | rotation 分支的 worktree 测试输出 | six-gates 流水 |
| `trusted-base-bump-20261005.md` | 可信基线提升记录（含 tree 相等性/祖先关系/4 个哈希比对证据） | six-gates 流水 |
| `e-gates.ps1` | E 验收的闸门脚本 | six-gates 流水 |
| `PROGRESS-localpost-six-gates.md` | six-gates 总进度记录 | six-gates 流水 |

## docs/evidence/e-acceptance/

`docs/live-acceptance-plan.md` 约定的"E 验收证据落盘处"（原先写 `work/.../e-acceptance/`，但该目录从未建，
证据是以平铺文件形式存在 `work/localpost-six-gates-evidence/` 里的）。本次按文档约定**在仓库里建出该目录**并归位：

- `e1-arrival-lock-record-20261004.md` —— E1 到达锁记录
- `e1-deliver-mcptest-e1-1.mjs` / `e1b-deliver-mcptest-e1b-1.mjs` —— E1/E1b 投递探针（`mcptest-` 前缀，不进生产账本）
- `e2-blocker-producer-owned-source-kind-20261004.md` —— E2 阻塞项分析（生产者自有 source kind）
- `codex-e2-live-368-record.md` + `codex-e2-live-368-observe.mjs` + `codex-e2-live-368-probe.mjs` —— E2 实测记录与观察脚本

## 边界

- 这些是**证据**，不是可执行交付物；`verify-source-kind.mjs`/`asar.mjs`/`e-gates.ps1` 依赖本机环境（DSH 安装路径等），
  跨机使用需自行调整。
- 引用改动只改路径（`work/...` → `docs/...`），**未改任何判断或数据**；拷贝已逐字节校验。
