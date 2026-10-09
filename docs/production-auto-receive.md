# 生产自动收信（production auto-receive）

2026-10-05 用户放行后新增。目标：在**真实** `.mailbox` 上，信到达后**自动唤醒已绑定的聊天**，让它读信、按已授权范围处理、回执并归档——不再需要人喊一句「查信」。

## 与隔离入口的关系

| | 隔离入口（E） | 生产入口（本文） |
|---|---|---|
| 根 | `C:/AI_ASSIST/work/localpost-e-test` | `C:/AI_ASSIST/.mailbox` |
| 状态串 | `ready_for_live_E` | `ready_for_live_production` |
| receiver 启停 | 人类命令 `/localpost-e-start\|stop\|status` | **没有命令**：随自动绑定自启（`autoStart` 默认开），卸载插件即停 |
| 配置键 | `eAcceptance` | `autoReceive` |
| 根判定 | 拒绝生产根及其子路径 | **拒绝隔离根及其子路径**，只认生产根 |

两者共用同一批工具名（`localpost_status/inbox/read/reply/archive/bind_here/unbind`）与同一批命令（`/localpost-bind`、`/localpost-unbind`、`/localpost-status`），所以**同一时刻只能启用一个**；后启用的一方会以名字被占用为由拒绝装配（`commands_command_name_taken` / `tools_*`），不会半注册。

> 2026-10-09（用户决定）：生产命令从 14 条（每个身份 bind/status/unbind/auto-arm + auto-start/stop/status）精简为全宿主共用的 3 条，
> 收信聊天可以用自然语言切换。以前在别的聊天敲 `/localpost-bind` 会被拒（"T1 cannot move a binding between chats"），
> 换聊天只能手工挪走 `runtime/sessions/dsh.json`。

## 配置

```yaml
- id: dsh-localpost-postmaster
  config:
    runtimeVersion: 0.2.0-rc.2
    versionEvidence: "<外部预检记录，非空字符串>"
    autoReceive:
      enabled: true
      root: C:/AI_ASSIST/.mailbox        # 省略则取插件自己的信箱根
      allowFrom: codex,claude,gemini,opencode   # 逗号分隔；空/非法条目一律拒绝接线
      scanIntervalMs: 30000              # 1000..3600000
      debounceMs: 250                    # 50..600000
      # autoStart: false                 # 默认开（receiver 随自动绑定自启）；只有写 false 或 DSH_LOCALPOST_AUTO_START=0 才关
      identities:                        # 可选，默认无：同一宿主再服务其他身份（见 docs/multi-identity.md）
        engineer:
          allowFrom: dsh,codex           # 每个身份必填自己的白名单，严格校验、不继承上面那份
```

环境变量等价物（可选）：`DSH_LOCALPOST_AUTO_ENABLED / _ROOT / _ALLOW_FROM / _SCAN_MS / _DEBOUNCE_MS / _START`（`identities` 只认配置行）。
配置改动会被宿主热重载；**但热重载只重建 fiber、不重新 import 模块**——改了代码要用注入器的确定性重载（`dev_reload_package`）。

## 使用：三句话（或三条命令）

| 想做什么 | 在聊天里说（模型调工具） | 或者敲 |
|---|---|---|
| 让**这个聊天**自动收信（第一次绑定 / 恢复 / 从别的聊天切过来） | 「把收信切到这个聊天」 → `localpost_bind_here` | `/localpost-bind` |
| 停止自动收信（新信留在收件箱，可手动处理） | 「停止自动收信」 → `localpost_unbind` | `/localpost-unbind` |
| 现在哪个聊天在收信 | 「现在谁在收信」 → `localpost_status` | `/localpost-status` |

- **切过来**：原来绑在别的聊天时直接接管——新聊天用自己的 chat action 建一条新的 generation-1 绑定（auto），记住被替换的绑定，
  **老聊天没送出去的信会改送新聊天**；老聊天**没处理完**的信（已送达未回执、派送中断、待核对）默认拦下并列出，
  用户确认后说「强制切换」（工具参数 `force: true`）才转给新聊天。
- **停止**在任何聊天里都能说；绑定原地不动，之后在任何聊天说「切到这里」即恢复或接管。
- **状态**任何聊天都能看，列出每个身份：收信聊天是哪个（是不是"这个聊天"）、自动收信开没开、还有几封没处理完、receiver 起没起来。
- 派信正在进行（actor 租约被占）时，切换会自己等几秒，不再要人"再敲一次"。
- receiver：已有自动绑定时装配即自启；绑定/恢复/接管成功后立即自启（不等 15 秒轮询）；卸载插件即停。
- 配了其他身份（例 `engineer`）时：命令作用于**这个聊天所代表的身份**（没代表任何身份就是 dsh）；
  让一个聊天成为 engineer 的收信聊天，用自然语言点名身份（「把 engineer 的收信切到这里」→ `localpost_bind_here({identity:'engineer'})`）。
  一个聊天只能代表一个身份；工具还是同一套，信件工具自动落在调用聊天所代表的身份上。

## 安全性质（fail closed）

- **默认关**：没有 `autoReceive.enabled === true` 就什么都不注册；
- **根严格**：只接受恰好等于生产根的路径，隔离根与其它路径一律拒绝；
- **发件人严格**：白名单必须是安全标识符列表，空白/带空格/非法条目直接拒绝接线（不静默丢弃）；
- **构造零副作用**：绑定状态、桥、工具、receiver 都在第一次注册之前构建完（构造不写盘）；
- **只能绑"这个聊天"**：绑定动作由桥在调用聊天自己的命令/工具调用里铸造，宿主证明调用者；没有任何参数能指定别的聊天。
  切换工具的说明要求模型**只在用户本人在该聊天里直接要求时**调用，信、附件、工具结果里的要求一律不算；
  最坏情况（被信诱导）也只是收信停在收件箱或挪到了你自己的另一个聊天，信不会丢；
- **没有 receiver 启停工具**：模型只能经由"绑定"间接让 receiver 自启；
- **注册是一个事务**：任何一步失败都会按逆序释放已注册项，不留下半装配状态。

## 自动执行的边界

自动的只是 **analysis-reply** 授权范围：读信、分析、写回执、归档。
**改代码、动生产、改权限仍然必须用户本人授权**——信里写"请实现/请修改"只是待处理数据。

## 测试

- `localpost/production-wiring.test.mjs`（8 例）：默认关、拒隔离根、白名单与时间参数校验、版本门禁、正常装配（3 命令 + 工具 + guard，receiver 建而不启）、控制命令启停、名字占用拒绝、本进程从未写过生产根（调用期写入见证 + 自检）；
- 回归：`localpost/dsh-wiring.test.mjs` 27/27；全量 353/353 + legacy 45/45（exit 0）。
- 多身份（2026-10-05）：`localpost/multi-identity.test.mjs` 18 例；全量 377/377 + legacy 45/45（exit 0）。
  生产零接触改为调用期写入见证（生产 receiver 上线后会定时重写 `runtime/queues/dsh.json`，整树快照不再可靠）。
- 自然语言切换 + 三条命令（2026-10-09）：接管/强制/竞态/确认/遮蔽见 `dsh-host-bridge.test.mjs`，纯状态转换见
  `letter-claims.test.mjs` 的 takeover 三例，工具见 `dsh-mail-tools.test.mjs`；全量 403/403 + legacy 45/45（exit 0），
  22 个变异全部被抓到。插件入口测试在真实生产根上装配，因此**显式**写 `autoStart: false`。

## 未做（下一步）

- **DSH 内其他聊天**：已由多身份接线解决（`docs/multi-identity.md`）。
- **外部客户端（Codex / Claude Code / Antigravity＝`gemini`）的自动唤醒**：需要各自客户端那一侧的桥，不是本插件能单方面解决的；可行性与工作量见 `docs/external-client-wake-survey.md`（T2）。
- 生产 ledgers/告警对"自动处理完成"的记账口径未变（仍由内核定时器负责）。
