# 隔离 live E 交接（R3 候选：启动链修复，待 codex 审核后由 DSH 发布）

状态：**候选，未执行**（不是已通过）。基线 main = 864b196（= origin/main）；本候选不改 main 运行代码，也不改固定预检值。生产自动派发 / receiver 仍关闭。
R2 已停用：首次重建路径必然失败（`-ConfirmHostExited` 误绑到 RootPath），且 receiver/错误传播存在 fail-open，见文末「R3 修复」。

## 路径（发布后）
- 启动入口：`C:\AI_ASSIST\work\localpost-six-gates-evidence\start-isolated-e.ps1`。只作用于 canonical 测试根，参数只有 `-RebuildRoot` / `-ContinueAcceptance`
- 单独重建（一般用不到）：同目录 `rebuild-e-test-root.ps1 -ConfirmHostExited`。`start -RebuildRoot` 已在同一进程里调用同一个重建函数
- 门禁库：同目录 `e-gates.ps1`；回归测试：同目录 `e-gates.test.ps1`
- 证据：同目录 `e-test-root-before-rebuild-<stamp>.txt`。首行记 root、backup、entries、stamp；之后每行一个条目，含完整路径、大小、时间、属性、sha256
- 测试根（canonical）：`C:\AI_ASSIST\work\localpost-e-test`。只有 DSH 在受控清理时才会动它；脚本只在用户执行时做旁移，不做删除

## 用户需要亲自做的（阶段二）
1. **保存并完全退出桌面 DSH**：任务管理器里 `DeepSeek Harness` 进程为 0。若手动起过 `receiver-cli.mjs` 等指向测试根的 node 进程，也一并结束。
2. **首次验收**（重建测试根并启动）：在普通 PowerShell 窗口原样执行：
   ```
   pwsh -NoProfile -File C:\AI_ASSIST\work\localpost-six-gates-evidence\start-isolated-e.ps1 -RebuildRoot
   ```
   正常输出依次为：`OK 预检通过` → `OK 停机门禁通过` → `OK 证据：…` → `OK 旁移 -> …localpost-e-test.bak-<stamp>` → `OK 重建完成…` → `OK 重建后置条件通过` → `OK 已启动，PID=…`。
   出现任何一行以 `X ` 开头，表示**已拒绝且没有启动**（退出码 1），原因写在这一行，并且只报 PID，不打印命令行。
3. **续跑同一验收**（E3/E4 需要重启宿主时；不重建、保留队列）：先完全退出 DSH，再原样执行：
   ```
   pwsh -NoProfile -File C:\AI_ASSIST\work\localpost-six-gates-evidence\start-isolated-e.ps1 -ContinueAcceptance
   ```
   两个开关必须二选一，都不给或都给都会被拒绝。续跑会核对以下几项，**不改动根内任何字节**：
   - 测试根是真实目录；
   - 路径是规范 canonical 路径，且祖先链上没有重解析点；
   - 根下有根级普通文件 `.e-acceptance`；
   - 根内任何位置都没有 junction/符号链接（否则验收写入可能被引到根外，例如生产 `.mailbox`）。
4. 启动后确认日志：出现「插件就绪：root=…」与「隔离验收入口已就绪：status=ready_for_live_E」。
   若出现「未启用（allow_from_required / disabled_by_default / version_evidence_missing）」，表示**仍未开启（fail closed）**，不是故障。
5. 隔离聊天 A：依次执行 `/localpost-bind` → `/localpost-e-status`（应 running:false）→ `/localpost-e-start` → `/localpost-e-status`（应 running:true）。
6. 隔离聊天 B：执行 `/localpost-e-start`、`/localpost-e-stop`、`/localpost-e-status`，**应全部被拒**，且不影响 A。

## 恢复（回滚）
看 `X ` 行判断状态：
- `证据枚举失败（原根未动）`、`证据写入失败（原根未动）`、`证据回读条数不符（…原根未动）`、`旁移失败（原根未动）`，以及任何预检/停机门禁拒绝：**测试根没有任何变化**。后几种情况下，证据目录里可能多出一份本次的证据文件，留作记录即可。处理掉原因后重跑。
- `重建未完成：…原根已完整旁移至 <backup>（未删除、未改写）`：原根完整在 `<backup>`。DSH 退出状态下按以下步骤恢复，不删除任何东西：
  ```
  if (Test-Path -LiteralPath C:\AI_ASSIST\work\localpost-e-test) { Rename-Item -LiteralPath C:\AI_ASSIST\work\localpost-e-test -NewName localpost-e-test.failed-<stamp> }
  Move-Item -LiteralPath C:\AI_ASSIST\work\localpost-e-test.bak-<stamp> -Destination C:\AI_ASSIST\work\localpost-e-test
  ```
- 启动器本身失败（`X` 行是启动错误）：如果用的是 `-RebuildRoot`，此时重建已完成，根里只有标记，修好原因后用 `-ContinueAcceptance` 续跑即可，不要再重建；如果用的是 `-ContinueAcceptance`，什么都没变，直接重跑。
- 回到默认关闭：不设 E 变量、用平常方式启动桌面 DSH 即可。脚本只在启动瞬间把 7 个 E 变量写进本进程环境供子进程继承，随即还原（原本不存在的变量会被真正删除）。脚本不持久化任何变量。

## 仍然有效的边界
- 生产 `.mailbox` 不参与任何 E 测试；不启用生产自动派发，不改生产 profile。
- watcher.close 失败时，不得凭 running=false 声称句柄已释放，也不得在同一个存疑实例上重复 start。
- 本候选只在 `ops/live-e/` 内，**不要合入 main**。合入会让 HEAD≠864b196，基线预检会按设计拒绝。若将来要入库，先定基线更新机制，比如把固定值改为运行代码子树的 tree hash，不要靠跳过门禁。

## R3 修复（2026-10-04，回应 codex R2 复审四项 + 必守边界）
1. **启动链真实串接**：start 不再起子脚本，而是在同一进程里调用 `EGate-Rebuild -Context $c -ConfirmHostExited`，开关按命名开关真实绑定；任何失败都以异常终止 start，不构造、不传递 E 变量，也不调用启动器。生产入口只是两三行的薄壳，只构造 canonical 上下文，没有任何路径、探针、启动器参数。夹具接缝只存在于库函数的上下文参数里，而且夹具上下文的根、work、证据目录中，任一位于 `C:\AI_ASSIST\work` 之内、或是它的祖先（例如 `C:\AI_ASSIST`），都会在任何探测或写入之前被拒绝（`EGate-ValidateContext`）。
2. **receiver 识别**：只做一次完整枚举，把原始记录喂给同一个过滤函数，对每个 node* 进程逐条判定：
   - 按参数切分出绝对路径，经 `GetFullPath` 统一处理，覆盖两种斜杠、大小写、引号、`\\?\`、`file:///`、`.`/`..` 点段、尾随分隔符、`--x=PATH`，以及已存在路径的 8.3 短名。指向根或根内的一律拒绝。
   - 文本兜底处理嵌在代码串里的根路径，带边界判断，因此 `localpost-e-test.bak-*`、`localpost-e-test2` 这类前缀相似的兄弟目录不会误报。
   - 真实入口按 `receiver-cli.mjs` 识别：它的 `--root` 缺失、是相对路径或路径链上有重解析点时，因为无法证明不是该根，一律拒绝。只含 "receiver" 字样的其它 node（例如 `receiver.test.mjs`）不算入口。
   - 另外：枚举结果不含本进程即视为不可信，拒绝。
3. **不可读即拒绝**：命令行为 null、空或空白，进程名不可读，DSH 候选的可执行路径不可读，都拒绝。原因只报 PID，不带命令行或环境。
4. **错误传播**：所有做 I/O 的库函数都自设 `$ErrorActionPreference='Stop'`，cmdlet 也显式加 `-ErrorAction Stop`；调用方是 Continue、SilentlyContinue，或者设了 `PSDefaultParameterValues` 都不受影响。重建按下面的顺序执行，每一步失败都非零退出且不启动，状态保持可恢复：
   1. 全部校验；
   2. 停机门禁；
   3. 取证：枚举加 hash，任何错误即拒绝；
   4. 证据 `-NoClobber` 落盘，并回读核对条数；
   5. 同卷 `[IO.Directory]::Move` 旁移：目标已存在或根内有占用句柄即抛错，原根不动，也不会"移入"已有目录；
   6. 新建根与标记，均不带 `-Force`；
   7. 后置条件复核。
5. **其它边界**：
   - 两个开关互斥，且必须二选一；
   - 续跑核对真实目录、规范路径、整条祖先链无重解析点、根级普通文件标记，以及根内任何位置无重解析点（枚举失败同样拒绝）；
   - 重建与续跑都做路径校验：根是 work 的直接子目录，根/work/证据目录的整条祖先链无重解析点，证据目录不在根内，拒绝 `.mailbox`；备份目标与证据目标已存在即拒绝；
   - 空根判定只认根级普通文件 `.e-acceptance`，同名目录或 junction 不算，缺标记也拒绝；
   - 基线检查额外核对仓库根（空 `.git` 目录会让 git 沿用外层仓库的 HEAD）。

### 门禁回归（夹具；不碰 canonical 根、不启动任何真实宿主）
```
pwsh -NoProfile -File C:\AI_ASSIST\work\localpost-six-gates-evidence\e-gates.test.ps1
```
期望末行 `RESULT pass=59 fail=0`。夹具默认放在系统临时目录，可用 `-TempBase <目录>` 指定，但不得放在 `C:\AI_ASSIST\work` 内。canonical 根前后快照的 sha256 会打印在 `CANONICAL-BEFORE/AFTER` 两行，必须一致。

覆盖范围：
- 原 14 项保留编号，断言改为具体原因；
- 真实 start→rebuild 首跑成功：7 项环境、备份字节与原根一致、证据完整；
- rebuild 各步骤的真实故障（真实 ACL、独占句柄、遮蔽 cmdlet 注入非终止错误）：启动 0 次，不注入环境；
- 不可读、正斜杠、反斜杠、短名等十余种写法的 receiver 一律拒绝，且不泄露命令行，同时验证无误报；
- 续跑后队列字节不变；
- 双开关和无开关被拒；
- junction 出现在根、标记或祖先链上被拒；
- 夹具上下文触及 canonical 被拒；
- 生产入口副本配桩库在子进程里运行：只接受规定开关，开关按命名开关传入，库抛错即 exit 1；
- 生产启动器失败时会还原环境。
