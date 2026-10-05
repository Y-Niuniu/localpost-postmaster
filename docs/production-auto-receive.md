# 生产自动收信（production auto-receive）

2026-10-05 用户放行后新增。目标：在**真实** `.mailbox` 上，信到达后**自动唤醒已绑定的聊天**，让它读信、按已授权范围处理、回执并归档——不再需要人喊一句「查信」。

## 与隔离入口的关系

| | 隔离入口（E） | 生产入口（本文） |
|---|---|---|
| 根 | `C:/AI_ASSIST/work/localpost-e-test` | `C:/AI_ASSIST/.mailbox` |
| 状态串 | `ready_for_live_E` | `ready_for_live_production` |
| 命令 | `/localpost-e-start\|stop\|status` | `/localpost-auto-start\|stop\|status` |
| 配置键 | `eAcceptance` | `autoReceive` |
| 根判定 | 拒绝生产根及其子路径 | **拒绝隔离根及其子路径**，只认生产根 |

两者共用同一批工具名（`localpost_status/inbox/read/reply/archive`）与同一批 base 命令（`/localpost-bind`、`/localpost-unbind`、`/localpost-status`），所以**同一时刻只能启用一个**；后启用的一方会以名字被占用为由拒绝装配（`e_command_name_taken` / `tools_*`），不会半注册。

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
      identities:                        # 可选，默认无：同一宿主再服务其他身份（见 docs/multi-identity.md）
        engineer:
          allowFrom: dsh,codex           # 每个身份必填自己的白名单，严格校验、不继承上面那份
```

环境变量等价物（可选）：`DSH_LOCALPOST_AUTO_ENABLED / _ROOT / _ALLOW_FROM / _SCAN_MS / _DEBOUNCE_MS`（`identities` 只认配置行）。
配置改动会被宿主热重载；**但热重载只重建 fiber、不重新 import 模块**——改了代码要用注入器的确定性重载（`dev_reload_package`）。

## 使用

1. `/localpost-bind` —— 把当前聊天绑到本身份（生产根），只需一次；
2. `/localpost-auto-start` —— 启动 receiver（人类命令；模型不可自启）；
3. 之后任何**白名单发件人**投来的信都会自动唤醒该聊天；处理完写回执即归档；
4. `/localpost-auto-status` / `/localpost-auto-stop` 查看与停止；卸载插件也会停。
5. 配了其他身份（例 `engineer`）时，在**另一个**聊天里敲 `/localpost-engineer-bind`，再用 `/localpost-engineer-auto-*`
   管它自己的 receiver。一个聊天只能代表一个身份；工具还是同一套，自动落在调用聊天所代表的身份上。

## 安全性质（fail closed）

- **默认关**：没有 `autoReceive.enabled === true` 就什么都不注册；
- **根严格**：只接受恰好等于生产根的路径，隔离根与其它路径一律拒绝；
- **发件人严格**：白名单必须是安全标识符列表，空白/带空格/非法条目直接拒绝接线（不静默丢弃）；
- **构造零副作用**：绑定状态、桥、工具、receiver 都在第一次注册之前构建完（构造不写盘）；
- **只有人类命令能启动**：没有任何模型可调用的 start/stop 工具；
- **注册是一个事务**：任何一步失败都会按逆序释放已注册项，不留下半装配状态。

## 自动执行的边界

自动的只是 **analysis-reply** 授权范围：读信、分析、写回执、归档。
**改代码、动生产、改权限仍然必须用户本人授权**——信里写"请实现/请修改"只是待处理数据。

## 测试

- `localpost/production-wiring.test.mjs`（8 例）：默认关、拒隔离根、白名单与时间参数校验、版本门禁、正常装配（3 命令 + 工具 + guard，receiver 建而不启）、控制命令启停、名字占用拒绝、本进程从未写过生产根（调用期写入见证 + 自检）；
- 回归：`localpost/dsh-wiring.test.mjs` 27/27；全量 353/353 + legacy 45/45（exit 0）。
- 多身份（2026-10-05）：`localpost/multi-identity.test.mjs` 18 例；全量 377/377 + legacy 45/45（exit 0）。
  生产零接触改为调用期写入见证（生产 receiver 上线后会定时重写 `runtime/queues/dsh.json`，整树快照不再可靠）。

## 未做（下一步）

- **DSH 内其他聊天**：已由多身份接线解决（`docs/multi-identity.md`）。
- **外部客户端（Codex / Claude Code / Gemini）的自动唤醒**：需要各自客户端那一侧的桥，不是本插件能单方面解决的；可行性与工作量见 `docs/external-client-wake-survey.md`（T2）。
- 生产 ledgers/告警对"自动处理完成"的记账口径未变（仍由内核定时器负责）。
