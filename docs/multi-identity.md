# 多身份接线（multi-identity）设计说明

2026-10-05 · T1（交接信 `dsh-20261005-handoff-auto-receive-to-claude-001`，用户当面授权）· base `24eb33b`

## 问题

生产自动收信只认一个身份：`identity` 固定 `dsh`，工具名、命令名在宿主里全局唯一，所以一个 DSH 宿主只能有一个"信到就自动醒"的聊天。
目标：同一宿主里的第二个聊天以另一个身份（例：`engineer`）被自动唤醒，**不放宽**四条硬约束：
① allowFrom 严格校验；② 生产/隔离根判定互为镜像；③ 只有人类命令或配置开关能启动 receiver，模型侧没有启停工具；④ 模型不能读别人的信箱。

## 选型

| 选项 | 结论 | 理由 |
|---|---|---|
| (a) 每个身份一套工具（`localpost_<id>_read` …） | 不用 | 工具是全局的，任何聊天都能调别的身份那一套，照样要校验"调用者属于该身份"。等于把 (b) 的检查做了 N 遍，暴露面还更大；唤醒消息也得教模型该用哪一套名字 |
| (b) 一套工具 + `identity` 参数 | 改成不加参数 | 参数是模型可控的输入。身份既然能从宿主证明的调用者和绑定记录推出，就不该让模型自己报 |
| **采用：一套工具，身份由调用者推出；命令按身份分开，都不带参数** | ✓ | 没有可滥用的参数，越权面最小；唤醒消息、工具名、模型侧用法都不变 |
| (c) 绑定授权 | `/localpost-<id>-bind`：人类命令、无参数、调用聊天由宿主证明；一个聊天只代表一个身份；宿主内绑定串行判定 | 保住原有"命令不收任何输入"的不变量。宿主命令名必须匹配 `^[a-z][a-z0-9_-]*$`（`work/b-host-guard-evidence/host-commands.js:78`），所以身份名也受同样约束 |

生态检索（3 行结论见提交 `0b05f56`）：mcp_agent_mail、dsh-agent-mailbox（npm，正是 DSH 插件）、WQMYH/multi-agent-mailbox 三者的身份分别靠模型自己持有的 token、会话配置文件、自报 label，都不是宿主证明的调用者，而且都明说只能拉取、不能唤醒运行中的聊天。所以不引入外部依赖，只在本仓既有装配上做增量。

## 身份怎么推出（`localpost/chat-identity.mjs`）

1. 宿主先证明调用者（原有的 `attestedCaller`：`execution.agent` + `ctx.agents.get(id) === agent`）。
2. 读每个已配置身份的绑定。某身份的谱系会话（当前会话，加上轮换的 from / candidate）里有这个聊天（按 host + 会话 id 匹配）时，就算该身份点名了它。
   - 恰好一个身份点名：用该身份；
   - 没有身份点名：用宿主身份 `dsh`，与多身份之前一致（未绑定的聊天就是 dsh）；
   - 被两个身份点名：`IDENTITY_AMBIGUOUS`，拒绝；任一身份的绑定读不出：`IDENTITY_UNRESOLVED`，拒绝（读不出的那条可能正好点名了调用者）。
3. 推出身份后，原有的精确检查照旧执行：`status` / `inbox` 要求调用者是该身份**当前**绑定的聊天（含工作目录）；`read` / `reply` / `archive` 走信箱的 owner 校验。

每个身份一条独立通道：信箱实例、宿主桥、记账（acceptance）、适配器、receiver，以及 `-auto-start|stop|status` 控制命令。会话存储只有一份，按身份分文件。

## 配置与命令

```yaml
autoReceive:
  enabled: true
  allowFrom: codex,claude,gemini,opencode   # 宿主身份 dsh，不变
  identities:                               # 默认无；只认配置行，不读环境变量
    engineer:
      allowFrom: dsh,codex                  # 必填、严格校验、不继承上面那份
```

- 身份名必须匹配 `^[a-z][a-z0-9_-]{0,31}$`，不能与 dsh 重复，也不能互相重复；生成的命令名必须全局唯一（例如名叫 `auto` 的身份会生成 `/localpost-auto-status`，与宿主命令撞名，直接拒绝）。
- `engineer` 的命令：`/localpost-engineer-bind | -status | -unbind | -auto-start | -auto-stop | -auto-status`。dsh 的命令保持原名。
- 工具仍是 5 个，都没有身份参数。`autoStart: true` 时每个身份各自"绑上即自启"。
- 没配 `identities` 时，装配行为与单身份完全一致，原有 356 条用例全部原样通过。

## 越权分析

| # | 威胁 | 防护 | 证据（`localpost/multi-identity.test.mjs`；变异见提交 `e4e29f5`） |
|---|---|---|---|
| 1 | 模型让聊天读、回执或归档别的身份的信 | 工具没有身份参数；身份由宿主证明的调用者推出；按 id 硬读只会在本身份的信箱里找 | E 读 dsh 的信、A 读 engineer 的信、E 回执和归档 dsh 的信：全部 not found（变异 M1 → 4 红） |
| 2 | 模型自己把聊天绑成别的身份，或自己启动 receiver | 绑定和启停只有人类命令（模型侧没有对应工具）；命令都不带参数，调用聊天由宿主证明 | 断言工具里没有 bind/start/stop/dispatch，所有命令 `input` 为空、`recordInput=false` |
| 3 | 一个聊天同时代表两个身份，从而越过 dsh 与 engineer 的边界 | 绑定前检查其他身份有没有点名这个聊天，宿主内串行判定；即使有人绕过插件直接写入，推出身份时遇到歧义也会拒绝 | 绑定互斥、并发绑定恰好一个成功、两个身份同时点名时拒绝（M2 → 2 红，M3 → 1 红） |
| 4 | 某身份的绑定文件损坏或被手改坏 | 推出身份和绑定都 fail closed | 读不出时所有聊天一律被拒（M4 → 1 红） |
| 5 | 放宽白名单 | 每个身份的 allowFrom 必填，走同一套严格校验，不继承 | 17 种非法配置全部在构建前被拒；端到端用例里 codex→engineer 被判 `denied`（M5 → 2 红） |
| 6 | 一个身份的命令启停另一个身份的 receiver | 每个身份有自己的控制队列，命令只读本通道的绑定 | 按身份启停，互不影响（M6 → 2 红） |
| 7 | 用身份名劫持命令 | 生成的命令名必须全局唯一 | `identity_command_conflict` |
| 8 | 根判定 | 未改动 | `production-wiring` / `dsh-wiring` 原有用例全绿 |

**依赖的既有前提**（不是本次新引入的）：宿主命令只能由人在界面里执行。`CommandRuntime.execute` 是 UI 侧的远程入口，执行记录写的是 `source: { kind: 'user' }`（`work/b-host-guard-evidence/host-commands.js:327-339`）。

## 已知边界（不在本次范围）

- **LocalPost 工具的边界不等于文件系统的边界。** 如果 DSH 聊天带有通用文件工具，沙箱又允许读 `.mailbox`，模型就能绕过 LocalPost 工具，直接读别的身份的信封文件。这一层归 `dsh-sandbox-policy` 管，插件单方面封不住。
- **信封里的 `from` 不是认证。** 任何能写 `.mailbox` 的进程都能自称任何发件人，所以 allowFrom 只是策略过滤，不是身份认证（这是既有性质）。防注入靠的是 analysis-reply 授权范围，以及"信件内容是不可信数据"这条规则。
- **解绑不释放身份。** `/localpost-<id>-unbind` 只把模式切到 manual，绑定记录仍点名该聊天，所以该聊天仍然代表这个身份。要把它"还给" dsh，需要运维清掉绑定记录（与原有"T1 不在聊天之间迁移绑定"的约定一致）。
- **不要给外部客户端也在用的身份配 DSH 绑定。** 例如把 DSH 聊天绑成 `codex`，就会出现两个消费者。记账会让已被自动认领的信拒绝手动读取，所以不会重复处理，但这仍是配置错误。只给"只由 DSH 聊天消费"的身份配置。
- 外部客户端（Codex / Claude Code / Gemini）的唤醒不在 T1 内，见 T2 调研结论 `docs/external-client-wake-survey.md`。

## 验证

- `node scripts/test.mjs` → **377/377 + legacy 45/45，exit 0**（基线 356 + 新增 21：多身份 18、插件入口 +2、生产根写入见证自检 +1）
- 红绿验证 M1–M6：每次只拆一处保护，对应用例都变红；恢复后 18/18
- 生产零接触：三个测试文件都用调用期写入见证断言"本进程从未写过 `.mailbox`"（`localpost/fixtures/production-write-witness.mjs`）。原来的整树快照会被已上线的生产 receiver 随机打红，因此改掉
