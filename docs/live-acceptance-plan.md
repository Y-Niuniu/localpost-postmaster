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

## 接线状态（2026-10-04，R4 修订）

**状态：代码就绪（`ready_for_live_E`），待 codex 复审；真机 E1–E6 尚未执行。** `ready_for_live_E` 只表示入口代码可以开始真机验收，
**不表示 E 已通过**，也不是启用生产派发的许可。

宿主桥与邮件工具已接到真实 DSH 插件入口（`lib/index.js`），但**默认关闭**：只有显式开启、`root` 恰为隔离根
`C:/AI_ASSIST/work/localpost-e-test/`、运行时为受支持版本且有外部预检记录、`allowFrom` 合法时，才会注册命令与工具。
生产根 `C:/AI_ASSIST/.mailbox` **及其任何子路径一律拒绝**（`production_root_refused`）。

接线点：`lib/index.js` 内 `ctx.effect(...)`（标签 `dsh-localpost-postmaster: isolated E entry`），
逻辑在 `localpost/dsh-wiring.mjs`；插件由 profile 以 `link:C:/AI_ASSIST/tools/dsh-localpost-postmaster` 加载。

### 注册是一个事务（全有或全无）

1. 先做全部无副作用的校验：开关、根、版本与预检记录、`allowFrom`、两个计时参数、`commands.find` 可用。
2. 再构造全部对象，**包括 receiver**（只构造、不启动）；构造失败返回 `build_failed`，此时什么都没注册。
3. 用 `commands.find` 预检三条 E 命令名：已被占用返回 `e_command_name_taken`，查找本身抛错返回 `e_lookup_failed`，都在任何注册之前。
4. 依次注册基础三命令、邮件工具（含 shadow guard）、三条 E 命令。任一步失败都会**逆序释放已注册的全部**，
   返回结构化拒绝（`commands_*` / `tools_*` / `registration_failed`），宿主侧最终零残留，之后可以重试。
5. 每个 wiring 只释放自己注册的东西；旧实例的 dispose 不会碰后继实例。

### 隔离启动 / 停止（不改 profile，避免重复行）

本插件的装配来自 profile 的 `package.json`（`link:` 依赖 + bundles 列表），**不在 `cordis.patch.yml` 里**。
因此**不要**为了开关去加 patch row（会与 bundle 行重复）。改用环境变量显式开启，共 **7 个变量**：

```
DSH_LOCALPOST_E_ENABLED=1
DSH_LOCALPOST_E_ROOT=C:/AI_ASSIST/work/localpost-e-test
DSH_LOCALPOST_E_RUNTIME=0.2.0-rc.2
DSH_LOCALPOST_E_EVIDENCE=precheck:desktop app.asar package.json 0.2.0-rc.2 + sha256:<外部预检哈希>
DSH_LOCALPOST_E_ALLOW_FROM=codex            # 必填。逗号分隔，不得有空格或空项；每项都须是安全标识符
DSH_LOCALPOST_E_SCAN_MS=30000               # 可选：整数 1000..3600000
DSH_LOCALPOST_E_DEBOUNCE_MS=250             # 可选：整数 50..600000
```

`allowFrom` 不做任何清洗：`codex, dsh`（带空格）、`codex,,dsh`（空项）、`../x` 这类值会整体拒绝（`allow_from_invalid`），
不会被悄悄过滤掉。安全标识符 = 字母或数字开头，其余只含 `A-Z a-z 0-9 _ . -`。

1. **启动**：7 个变量齐备（后两个可省）后启动宿主；日志出现
   `隔离验收入口已就绪：status=ready_for_live_E`，此时注册 6 条人类命令（基础 3 条 + E 3 条）、5 个工具与 1 个 guard。
2. **停止**：把 `DSH_LOCALPOST_E_ENABLED` 置 0 或删掉这 7 个变量，然后重启宿主；日志出现
   `隔离验收入口未启用（disabled_by_default）`。
3. **row config 方式**（可选）：如果确实要用 `eAcceptance` 行配置，需要在插件装配层改配置 ——
   **那属于改生产 profile**，须先取得用户授权（回 `needs_authorization`），不得自行修改。

### 版本来源（不是模型可随意伪造的）

- 运行时门禁 = **能力探测**（`tools.register/get/guard` + `agents.get` + `commands.register/find`），
  版本字符串只是配置；`versionEvidence` 必填，用来记录**外部预检**。
- 外部预检事实（codex 直接读桌面版 `app.asar` 核对）：`@deepseek-ai/dsh-desktop 0.2.0-rc.2`、
  `dsh-desktop-runtime 0.2.0-rc.2`、`dsh-base 0.2.0-rc.2`；PATH 里的 `dsh --version = 0.1.5-rc.1`
  **是另一个旧 npm CLI，不代表运行中的桌面版**（不得据此改兼容、也不得升级 DSH）。

### 真机 E 的 receiver 控制（人类命令，不是工具）

隔离 receiver 由 wiring **单例拥有**，**只能**通过三条无参数、`recordInput:false` 的人类命令操作：

    /localpost-e-start    启动隔离 receiver（扫描隔离根）
    /localpost-e-stop     停止（关闭 watcher 与 interval）
    /localpost-e-status   查看 running / dispatchEnabled / lastError / lastStartError / lastStopError / shutdownError

每条命令执行前依次检查：

1. **遮蔽**：宿主为这个 agent 实际解析到的定义（`commands.find(invocation.agent, name)`）必须正是本 wiring 注册的那一个。
   被 scoped 命令遮蔽或查找出错时一律拒绝，不启动也不停止 receiver。
2. **调用者**：由宿主证明（`agents.get(id) === invocation.agent`，工作目录为绝对路径）。
3. **权限**：
   - `start`：只有已绑定的测试聊天，且绑定处于 active + 自动模式；
   - `stop` / `status`：已绑定的测试聊天（任何绑定状态）**或启动这个 receiver 的聊天**。
     所以即使绑定被改成手动、被冻结、被删除，receiver 也总能停下来；卸载插件也会停掉它。

它们**不是模型可调用的工具**；插件加载与热重载都**不会**自动启动。

- 重复、并发的 start 只会构造一个 receiver、底层只启动一次。
- start 失败不会报告 running，并会关闭半启动的 watcher；之后可以安全地 stop 或卸载。
- 卸载（Cordis rc.2 会等待 effect disposer 返回的 Promise）：先停 receiver，**无论停止是否成功都释放全部注册**；
  停止失败的原因记在 `status().shutdownError`，并由插件入口写入错误日志，不会出现「卸了一半」。
- **`receiver.stop()` 本身（2026-10-04 加固）**：
  - 先断掉新的调度：停止标记生效，interval 和 debounce 两个定时器都清掉；
  - 再关闭 watcher：先丢弃引用，所以重复 stop 不会再碰它；
  - 然后等待正在跑的扫描结束；
  - 最后，如果关闭 watcher 失败，才把这个错误抛出来。

  中途有一步失败，其余步骤照样完成，错误也不会被吞掉。start 和 stop 在 receiver 内部串行执行：
  stop 撞上还没走完的 start 时，会排在它后面，把它打开的东西拆掉；并发的 start 只会打开一个 watcher。
- `/localpost-e-stop` 失败时：
  - 错误返回给调用者，并记进 `status().lastStopError`；
  - `running` 以 receiver 自己报告的为准：清理都做完了，只是关闭 watcher 失败时，它已经不再运行。
- start 失败后的清理如果也失败，两条错误会合成一个 `AggregateError` 一起报出，并分别记进 `lastStartError` 和 `lastStopError`。

### 隔离启动 runbook（desktop rc.2；只写步骤，**不执行**、不改快捷方式或 profile）

1. **环境变量必须在宿主启动前注入**：已运行的进程拿不到另一个 shell 事后设置的变量；
   若宿主已在运行，再次启动可能只把请求交给已有实例（单实例行为，**未验证**）。所以要先完全退出桌面版。
2. 在一个新的 PowerShell 窗口里设好变量，再从同一个窗口启动（命令草案，不要在生产会话里执行）：

   ```powershell
   $env:DSH_LOCALPOST_E_ENABLED = '1'
   $env:DSH_LOCALPOST_E_ROOT = 'C:/AI_ASSIST/work/localpost-e-test'
   $env:DSH_LOCALPOST_E_RUNTIME = '0.2.0-rc.2'
   $env:DSH_LOCALPOST_E_EVIDENCE = 'precheck:desktop app.asar package.json 0.2.0-rc.2 + sha256:<外部预检哈希>'
   $env:DSH_LOCALPOST_E_ALLOW_FROM = 'codex'
   $env:DSH_LOCALPOST_E_SCAN_MS = '30000'
   $env:DSH_LOCALPOST_E_DEBOUNCE_MS = '250'
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
   ```

   安装路径取自本机实测（`C:\Users\16548\AppData\Local\Programs\DeepSeek Harness\`，见 `docs/host-capability-report.md` §一）。
3. **确认命中当前 profile**：启动后插件日志出现「隔离验收入口已就绪：status=ready_for_live_E」。
   若出现「未启用（allow_from_required / allow_from_invalid / disabled_by_default / version_evidence_missing …）」，
   说明变量没进到该进程或取值不合法 —— 此时**仍是关闭状态**（fail closed），不是故障。
4. **确认没有自动启动**：在已绑定的测试聊天里执行 /localpost-e-status，应显示 `running:false`（加载不等于启动）。
5. **停止**：/localpost-e-stop（或退出该宿主进程）；卸载或重启后 receiver 不残留。
6. 全程**不改生产 profile**；生产 `.mailbox`、生产 receiver 与自动派发始终不参与。

### 测试与隔离根

- 单元测试**不读写**隔离根：每个用例用 `.localpost-tmp/dsh-wiring/` 下的唯一临时根加 fake receiver
  （通过 `isolatedRoot` 与 `receiverFactory` 注入；插件入口两者都不传，生产固定用 canonical 根与真实 receiver）。
  最后一个用例断言 canonical 根的目录与文件字节在测试前后完全一致。
- 隔离根里目前残留 R3 测试的产物：`agents/dsh/inbox/`（空目录）、`runtime/queues/dsh.json`（178 字节，2026-10-04 10:31）。
  **不要在代码或测试里删除**；真机 E 开始前由 dsh 按受控清单清空并重建这个**测试根**（只动测试根，不碰生产 `.mailbox`）。

### 尚未发生（不要误读）

- **E1–E6 真机验收尚未执行**；本状态只表示入口代码可执行。
- **生产自动派发、生产 receiver、真实宿主投递仍然全部关闭**。
- receiver 由 wiring 单例拥有、以**未启动**的形式存在；启动它属于真机 E 的单独授权步骤。
- 残余风险：`runtimeVersion` 目前由配置声明（不是宿主自证），真正的门禁是能力探测；接线后插件加载时会多引入若干模块。
