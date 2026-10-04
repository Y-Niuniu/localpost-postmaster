# 隔离 live E 交接（R3 已发布；R3.1 候选：把运行基线升级为已审 3684e84，待 codex 复审后发布）

状态：**R3 已发布**；R3.1 基线升级候选**待复审、未部署、未整合**。基线：旧 = `864b19612ad4da0d86209612b73d6cf758c15d66`（已批准、当前运行门禁固定值）→ 新 = `3684e84e908801f3088ddaad37d3939b4eb3990e`（codex 已复审通过的技术修复）。生产自动派发 / receiver 仍关闭。
R2 已停用：首次重建路径必然失败（`-ConfirmHostExited` 误绑到 RootPath），且 receiver/错误传播存在 fail-open，见文末「R3 修复」。

## 路径（发布后）
- 启动入口：`C:\AI_ASSIST\work\localpost-six-gates-evidence\start-isolated-e.ps1`。只作用于 canonical 测试根，参数只有 `-RebuildRoot` / `-ContinueAcceptance`
- 单独重建（一般用不到）：同目录 `rebuild-e-test-root.ps1 -ConfirmHostExited`。`start -RebuildRoot` 已在同一进程里调用同一个重建函数
- 门禁库：同目录 `e-gates.ps1`；回归测试：同目录 `e-gates.test.ps1`
- 证据：同目录 `e-test-root-before-rebuild-<stamp>.txt`。首行记 root、backup、entries、stamp；之后每行一个条目，含完整路径、大小、时间、属性、sha256
- 测试根（canonical）：`C:\AI_ASSIST\work\localpost-e-test`。只有 DSH 在受控清理时才会动它；脚本只在用户执行时做旁移，不做删除

## 基线升级（R3.1 候选，2026-10-04；收到基线发布审定后才可部署）

R3 发布后，运行门禁固定 `main` = 旧基线，而两处消息契约修复在 `3684e84`。直接把运行修复合 main 会让 HEAD 漂移、`-RebuildRoot/-ContinueAcceptance` 按设计拒绝；因此**先升级固定基线**，再 ff 整合。

- **旧基线（正在运行的固定值）**：`864b19612ad4da0d86209612b73d6cf758c15d66`（已批准）。
- **新基线（本候选固定值）**：`3684e84e908801f3088ddaad37d3939b4eb3990e`。入口只认这一个提交：旧基线、中间提交、或任何“当前 HEAD”都会被 `EGate-AssertBaseline` 以 `代码基线漂移` 拒绝。
- **运行修复的两个提交**（仓库 `tools/dsh-localpost-postmaster`）：
  - `e6ec5bd`：派发消息改用宿主 v4 生产者自有 source kind（`plugin:localpost`）+ 宿主边界自检；
  - `3684e84`：投递消息补身份（`id` = UUID、`role:'user'`），关闭读回路径 `lacks an identified message` / `message "undefined" is already pending` 两处缺口；
  - `3684e84` 的父提交就是 `e6ec5bd`；相对旧基线的唯一增量是 3 个文件：`localpost/dsh-adapter.mjs`、`localpost/dsh-adapter.test.mjs`、`localpost/fixtures/fake-dsh-host.mjs`。
- **整合方式**：`git -C tools/dsh-localpost-postmaster merge --ff-only 3684e84e908801f3088ddaad37d3939b4eb3990e`。若 main 已不等于旧基线，或 ff 不成立（分叉、夹带其它提交），**停止并回报**；不得改用“当前 HEAD”充当预期值。
- **整合前检查**：`rev-parse refs/heads/main` = 旧基线，且 `status --porcelain` 为空；不满足即停止。
- **整合后检查**：`rev-parse HEAD` = 新基线；`status --porcelain` 为空；`git diff --stat 864b196 3684e84` 仍只有上述 3 个文件。

### 发布文件清单（R3 已发布版本 → R3.1 候选）

| 文件 | 来源 | 发布版 SHA256（现地核对） | 候选版 SHA256 |
|---|---|---|---|
| `e-gates.ps1` | R3 发布；候选只改固定 `main`（864b196 → 3684e84），其余逐字节不变 | `925fb08b166f79f6785005b06f4a648706c61868006b6e52085bd5105d84cf5e` | `a7eb351480864ba00b9feefd023e05c9de71ae031b7db0f2cb97ad10a548c688` |
| `e-gates.test.ps1` | R3 发布（commit 95554a0）；候选更新 8c、新增 4g/4h（59 → 61 项） | `29166a62bc3848bfab43ea0f582c598754d3fbd4a8b0315699ea0b7836309e05` | `bb7e05981065e2f52bd0d05b410b33cbde102ae2aa15ff05cf97bbfd3a5a175d` |
| `rebuild-e-test-root.ps1` | R3 发布；候选未改 | `908f48d390f371ea4429746fc3bf0214208617fcd3372677dc5582320d163ac0` | `908f48d390f371ea4429746fc3bf0214208617fcd3372677dc5582320d163ac0` |
| `start-isolated-e.ps1` | R3 发布；候选未改 | `99d71f0a14c438f220ad4ebf3551df28ae475f8a3f2bf9b2241311b6ec716b57` | `99d71f0a14c438f220ad4ebf3551df28ae475f8a3f2bf9b2241311b6ec716b57` |
| `live-e-handoff.md` | R3 发布；候选改写基线/整合/回滚与清单 | `16776e81ff294426b1f43b9f637d1df46745fa440eb753866092cea0020b85a7` | 本文件不能自引用自身 SHA256：部署前用 `Get-FileHash` 现算，并与候选 commit 的 blob 一致（`git show <候选commit>:ops/live-e/live-e-handoff.md`） |

### 部署与回滚次序（审定后执行；宿主已完全退出时）

1. **备份**：五文件复制到 `localpost-six-gates-evidence/baseline-upgrade-backup-<stamp>/`，逐字节核对 SHA256 = 上表发布版。
2. **部署候选**：候选 commit 的 `ops/live-e/` 五文件复制回 `localpost-six-gates-evidence/`，核对 SHA256 = 上表候选版。
3. **ff 整合**：`git -C tools/dsh-localpost-postmaster merge --ff-only 3684e84e908801f3088ddaad37d3939b4eb3990e`。
4. **验证**：先跑 `pwsh -NoProfile -File e-gates.test.ps1`（末行 `RESULT pass=61 fail=0`），再按“阶段二”用 `-RebuildRoot`（首跑）或 `-ContinueAcceptance`（续跑）启动；预检应报 `OK 预检通过`。
   > 步骤 2/3 必须在同一个维护窗口（宿主已完全退出）内连续完成。若先部署候选、后整合，两者之间的窗口里门禁会因 HEAD 仍等于旧基线而**按设计拒绝启动**（fail closed，无副作用）；要完全避开这个窗口，也可以先 ff 整合、再部署候选——两种顺序对门禁安全性等价。
5. **回滚（任一步失败，逆序）**：
   1. main 已 ff 时：`git -C tools/dsh-localpost-postmaster reset --hard 864b19612ad4da0d86209612b73d6cf758c15d66`（或 `git update-ref refs/heads/main <旧基线>`）；
   2. 用备份目录的五文件覆盖 `localpost-six-gates-evidence/` 对应文件，核对 SHA256 = 发布版清单；
   3. 测试根按下面“恢复（回滚）”一节处理（旁移的备份原样移回，不删除任何东西）。
   回滚不需要改 profile、不需要重新 bind；生产自动派发始终关闭。

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
- **历史批次约束（R3 当时，仅存档）**：R3 发布时要求“候选只在 `ops/live-e/` 内，**不要合入 main**”——因为当时 HEAD≠864b196 会让基线预检按设计拒绝，且尚无经审的基线更新流程。该约束**只属于 R3 批次**，不适用于 R3.1：R3.1 已按“先升级固定基线（864b196 → 已审 3684e84）、备份 → 部署候选 → `--ff-only` 整合 → 验证”的受控流程执行。硬约束不变：**不得跳过门禁、不得接受任意 HEAD、不得忽略 git 脏状态**；若将来再入库，仍先定基线更新机制（例如把固定值改为运行代码子树的 tree hash）。

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
期望末行 `RESULT pass=61 fail=0`（R3 的 59 项 + 基线升级新增 4g/4h 两项）。夹具默认放在系统临时目录，可用 `-TempBase <目录>` 指定，但不得放在 `C:\AI_ASSIST\work` 内。canonical 根前后快照的 sha256 会打印在 `CANONICAL-BEFORE/AFTER` 两行，必须一致。

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
- 生产启动器失败时会还原环境；
- **基线升级（4g/4h）**：用 `clone --shared` 得到的**真实独立夹具仓库**（只读源仓库，不碰 main）验证——检出已审 `3684e84` 时以 canonical 固定值放行；真实检出旧基线 `864b196`、中间提交 `e6ec5bd`、以及未跟踪文件造成的脏工作区，全部拒绝；并断言源仓库的 `refs/heads/main` 与工作区前后逐字节不变。
