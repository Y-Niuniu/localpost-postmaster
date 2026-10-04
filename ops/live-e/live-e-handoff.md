# 隔离 live E 交接（阶段一完成，等待客户端退出）

状态：**准备完成，待执行**（不是已通过）。main = 864b196（= origin/main）。生产自动派发/receiver 仍关闭。

## 路径
- 重建脚本：`C:/AI_ASSIST/work/localpost-six-gates-evidence/rebuild-e-test-root.ps1`
- 启动脚本：`C:/AI_ASSIST/work/localpost-six-gates-evidence/start-isolated-e.ps1`
- 证据目录：`C:/AI_ASSIST/work/localpost-six-gates-evidence/`（重建前证据写为 `e-test-root-before-rebuild-<stamp>.txt`）
- 测试根：`C:/AI_ASSIST/work/localpost-e-test`（当前：agents/dsh/inbox 空、runtime/queues/dsh.json 178B/10:31:55）

## 为什么旧脚本不能用
旧草案以「当前 shell 没有 E 变量」推断「E 已关闭」，**这不是停机证明**，也没有路径/reparse/备份冲突检查。
加固版改为：显式 `-ConfirmHostExited` **且**实测无该 exe 进程；源路径必须恰为 canonical 根；
源与父链若有重解析点即拒绝；备份目标已存在即拒绝；`Move-Item -LiteralPath` 旁移（不删除）；
证据记录完整路径/大小/时间/属性/hash；重建后校验整根为空。

## 用户需要亲自做的（阶段二，我无法在承载自己的宿主里执行）
1. **保存并完全退出桌面 DSH**（确认 exe 进程为 0）。
2. 运行重建 + 启动（同一条，含重建）：
   `pwsh -File C:/AI_ASSIST/work/localpost-six-gates-evidence/start-isolated-e.ps1 -RebuildRoot`
   （只想启动不重建：去掉 `-RebuildRoot`）
3. 启动后确认日志：出现「插件就绪：root=…」与「隔离验收入口已就绪：status=ready_for_live_E」；
   若出现「未启用（allow_from_required / disabled_by_default / version_evidence_missing）」= **仍未开启（fail closed）**，不是故障。
4. 隔离聊天 A：`/localpost-bind` → `/localpost-e-status`（应 running:false）→ `/localpost-e-start` → `/localpost-e-status`（应 running:true）。
5. 隔离聊天 B：`/localpost-e-start`、`/localpost-e-stop`、`/localpost-e-status` **应全部被拒**，且不影响 A。

## 恢复（回滚）
- 测试根：`Remove-Item -LiteralPath C:\AI_ASSIST\work\localpost-e-test -Recurse -Force; Move-Item -LiteralPath <backup> -Destination C:\AI_ASSIST\work\localpost-e-test`
  （备份名在重建时打印，形如 `localpost-e-test.bak-yyyyMMdd-HHmmss`）
- 启动方式：不设 7 个 E 变量、用平常方式启动桌面 DSH 即回到默认关闭；脚本不持久化任何环境变量。

## 仍然有效的边界
生产 `.mailbox` 不参与任何 E 测试；不启用生产自动派发、不改生产 profile；watcher.close 失败时不得凭 running=false 声称句柄已释放，也不得在同一存疑实例重复 start。
## R2 修复（2026-10-04，回应 codex 两项 P1 + 预检缺项）

新增共用门禁库 `e-gates.ps1`，两个脚本改为 dot-source 它：
- **P1-1 子脚本失败不再漏过**：`EGate-InvokeChild` 检查 `$?` 与 `$LASTEXITCODE`，非零即**终止外层**；
  失败后**不注入 E 变量、不调用 Start-Process**；外层并**独立验证后置条件**（`EGate-AssertRootEmpty`），不凭子脚本打印。
- **P1-2 枚举 fail-closed**：`Get-CimInstance Win32_Process -ErrorAction Stop` 完整枚举；按程序名找候选后核对可执行路径；
  **候选路径不可读 => 直接拒绝**（绝不过滤成空集）；新增独立 receiver 检查（node 运行 receiver 且命令行含 canonical 根）。
- **四项预检**：exe / app.asar / **Node** / **profile package.json** / **代码基线（git HEAD 与干净工作区）**，任一漂移即在任何写入与启动前拒绝。
- **重启路径显式区分**：`-RebuildRoot`（首次，重建并写 `.e-acceptance` 标记）与 `-ContinueAcceptance`（续跑，要求标记存在、不重建、不动既有队列）；二者必须显式选择。

### 用法（更新）
```
# 首次验收（重建 + 启动）
pwsh -File <evidence>/start-isolated-e.ps1 -RebuildRoot
# 续跑同一验收（不重建、保留队列；E3/E4 用）
pwsh -File <evidence>/start-isolated-e.ps1 -ContinueAcceptance
```

### 门禁回归（夹具，不碰真实根、不启动真 launcher）
```
pwsh -NoProfile -File <evidence>/e-gates.test.ps1      # 期望 RESULT pass=14 fail=0
```
覆盖：子脚本 exit1/找不到 => 阻断；枚举抛错、候选路径不可读、宿主存在 => 拒绝；receiver 指向该根 => 拒绝；
exe/hash 漂移、文件缺失、非 git 基线 => 拒绝；空根（仅标记）放行、根有其它内容拒绝。
