# 分支归档登记（branch archive registry）

**为什么有这个文件**：本仓库除 `main` 外还有一批 agent 工作分支。2026-10-06 的分支复核结论（codex/GPT）是：
**11 支已完全并入 `main`（`ahead=0`）无需远端 ref** —— 它们的提交历史已随 `main` 保存；
**3 支有独占提交的分支只作"归档备份"，不合入 `main`**。本文件即那份"归档登记"：在此登记的 ref 视为**归档**，
不是待合并的工作分支。

**规矩**：
1. `archive/*` 下的 ref **不合入 `main`**；要取用其中内容，须**重新评审**（它们是当时工作现场的快照，不是生产能力）。
2. `archive/wip-*` 明确表示**未完成的旧基线 WIP**，任何自动化流程都不得把它当交付物。
3. 新增归档：推送 ref 后在本表登记（ref / 源分支 / tip / 独占提交数 / 内容 / 状态 / 判定来源）。

## 一、远端归档 ref（archive/*）

| 远端 ref | 源本地分支 | tip | 独占提交 | 内容 | 状态 / 标注 | 判定来源 |
|---|---|---|---|---|---|---|
| `archive/claude-live-e` | `agent/claude-live-e` | `715e951` | 3 | live-E 隔离验收链与文档（handoff 恢复段措辞修正等） | **归档**（隔离验收分支，未并入 main） | codex 2026-10-05 源码评审：`agent/claude-live-e` = "隔离验收链及文档" |
| `archive/wip-mail-guard` | `agent/claude-mail-guard` | `94d993b` | 3 | `wip(mail-turn): C2 守卫生命周期候选`（按 relay 武装、按因果链释放、卸载收口、子 agent 屏障） | **旧基线 WIP · 未完成 · 非生产** | codex 2026-10-05：旧基线 WIP，不能算生产能力；赶时间时不要未经重新评审直接合并 |
| `archive/dsh-baseline-upgrade` | `agent/dsh-baseline-upgrade` | `9a0d206` | 2 | live-E 隔离验收基线/文档（按 0dfe402 复审单修正安全指引） | **归档**（隔离验收基线/文档，未并入 main） | codex 2026-10-05：`agent/dsh-baseline-upgrade` = "隔离验收基线/文档" |

推送命令（复现用；`<src>` → `<dst>` 为本地分支 → 远端归档 ref）：

```powershell
git push origin refs/heads/agent/claude-live-e:refs/heads/archive/claude-live-e
git push origin refs/heads/agent/claude-mail-guard:refs/heads/archive/wip-mail-guard
git push origin refs/heads/agent/dsh-baseline-upgrade:refs/heads/archive/dsh-baseline-upgrade
```

## 二、已并入 main 的分支（**不建远端 ref**）

下列 11 支的 tip 都是 `main` 的祖先（`git merge-base --is-ancestor <branch> main` 为真、`ahead=0`），
其内容已随 `main` 保存；审查历史可从各自 tip 的提交信息追溯（本地保留即可）：

`agent/claude-auto-t1` `4d3f333` ｜ `agent/claude-bridge-r5` `f15c3aa` ｜ `agent/claude-bridge-r6` `db1c7ef` ｜
`agent/claude-e-wiring-r4` `bcd872b` ｜ `agent/claude-fs-safe-fix` `e357e30` ｜ `agent/claude-multi-identity` `bfa47de` ｜
`agent/claude-receiver-stop` `cb3feed` ｜ `agent/claude-rotation` `f852fc3` ｜ `agent/dsh-e2-fix` `4ef4a6a` ｜
`agent/dsh-test-isolation` `b206aac` ｜ `agent/gemini-t1` `6612aa0`

## 三、边界

- 归档 ref 的存在**不构成**任何功能承诺；`README.md`/`docs/` 中的能力陈述只以 `main` 为准。
- 远端仓库为**私有**；归档内容与 `main` 同源同许可，不含凭据（推送前已做密钥模式扫描）。
