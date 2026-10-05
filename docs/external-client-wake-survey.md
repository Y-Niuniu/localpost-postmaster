# 外部客户端能不能被"信到达"唤醒（T2 只读调研）

2026-10-05 · claude · 只读：没装任何东西，没写桥，没改任何客户端配置。
证据分两类：一是本机命令行和安装目录（`--version`、`--help`、`codex features list`、只读查看安装与配置目录），二是当天拉取的官方文档（链接见文末）。
**所有唤醒路径都没有实测。** 文中凡是"推断"都单独标出。

> **同日修订（用户指出"装了 Antigravity"）**：邮局里的 `gemini` 身份，实际跑在 **Google Antigravity 2.19.1** 上（`~/.gemini/AGENTS.md` 写明"你是 gemini，信箱 `agents/gemini/`"）。
> 初版把它当成 Gemini CLI 来查，结论"不可行"查错了对象，下面已改为 Antigravity 的结论。Gemini CLI 本机确实没装；官方给出了从 Gemini CLI 升级到 Antigravity CLI 的迁移路径。

## 结论

| 客户端（本机版本） | 能否唤醒**正在运行**的会话 | 推荐路径 | 成熟度 | 桥的工作量（粗估，含测试） |
|---|---|---|---|---|
| **Claude Code** 2.1.233 | **可行** | ① 带 `asyncRewake: true` 的命令型 hook：后台守着信箱，有信就以退出码 2 结束，会话即使空闲也立刻被唤醒；② channels：一个 stdio MCP 服务器向会话推 `notifications/claude/channel` | ① 写在正式的 hooks 参考里；② 研究预览，自建通道只能用 `--dangerously-load-development-channels` 加载 | ① 约 1 天；② 约 1–2 天，而且依赖预览开关 |
| **Codex CLI** 0.139.0 | **有条件可行** | app-server：用户改用 `codex --remote <本地端点>` 启动 TUI，桥作为第二个客户端连上同一个 app-server，对用户线程调 `turn/start`（回合进行中则用 `turn/steer`） | 官方标注实验性、不支持生产负载；Windows 下的 unix socket / ws 行为未实测 | 约 2–3 天 |
| **Antigravity** 2.19.1（= 邮局身份 `gemini`） | **可行** | **Sidecars**：Antigravity 托管的后台进程（自动拉起、崩溃重启），有信时调用自带的 `agentapi send-message <会话id> <prompt>`，**给已有会话发消息** | 写在正式文档里（Sidecars 页没有预览标注；更新记录早在 v1.2.7 就有 sidecar）；本机未开启任何 sidecar | 约 1–1.5 天（sidecar 脚本 + 人工确认的会话绑定 + 单实例锁 + 去重 + 测试） |
| Gemini CLI v0.62.0（本机未安装） | 对交互中的会话不可行 | 只有 `gemini --acp` 托管或 `gemini -p --resume` 无头续跑 | 只有文档证据 | 本机没在用，**不建议投入** |

四家都有"回合结束时接着干"的 hook（Claude/Codex 的 `Stop` 返回 block，Antigravity 的 `Stop` 返回 `continue`，Gemini CLI 的 `AfterAgent` 返回 deny），可以在每轮结束时顺手查一次信。但这种方式**唤不醒空闲会话**，只能算兜底。

## 证据

### Claude Code
- **asyncRewake**（hooks 参考的命令型 hook 字段表，以及 "Run hooks in the background → Limitations"）：hook 在后台运行；以退出码 2 结束时立即唤醒 Claude，即使会话空闲，输出作为系统提醒交给模型。限制有三点：
  - 这类 hook 仍受 `timeout` 约束（命令型默认 600 秒，可配置；配置上限文档没写，未验证）；
  - 每次触发都是独立的后台进程，**不去重**；
  - 所以桥要"每轮 `Stop` 重新挂上守望进程"，并且按身份加单实例锁。
- **channels**（channels / channels-reference 两页）：
  - 自建通道 = 本机 stdio MCP 服务器，声明 `experimental['claude/channel']` 能力后发 `notifications/claude/channel`，事件直接注入正在运行的会话；
  - 处于研究预览：开关不出现在 `--help` 里（与本机 2.1.233 的帮助输出一致），自建通道要用开发开关加载；
  - 需要 claude.ai 或 Console 认证；Team/Enterprise 组织需要管理员开启 `channelsEnabled`。
- **Stop hook**（Stop decision control 一节）：`decision: "block"` 让 Claude 不停下，`reason` 告诉它为什么继续。只在回合结束时生效。
- **无头**：`claude -p --resume <id>`、`--input-format stream-json`（本机 `--help`），以及 Agent SDK。这些是另起一个进程跑一轮，不是唤醒已经开着的界面会话。
- **没有现成的投递口**：`claude agents` 只能派发、列出、查看后台会话，回复只能在 agent view 里交互完成，没有"给某个会话发一条消息"的命令（本机 `claude agents --help` 加 agent-view 文档）。
- **注入文案要写成事实**：hooks 文档提醒，`additionalContext` 应写成事实陈述，写成系统指令口吻可能触发防注入机制。LocalPost 的唤醒文案应写成"信箱里有一封来自 X 的信 <id>"这种形式。
- **未验证**：Claude 桌面版（Code 标签页）里的会话能否使用 channels 开关和 asyncRewake。

### Codex CLI
- 本机 `codex features list`：`hooks` 是 stable 且开启；`steer` 和 `tui_app_server` 都是 removed=true。**推断**：这两个能力已并入默认行为，TUI 本身就基于 app-server。
- app-server 文档：
  - 传输方式有 stdio、`ws://`、`unix://`；TUI 可以用 `codex --remote ws://127.0.0.1:PORT` 或 `unix://` 连到一个独立运行的 app-server；
  - 协议里有 `thread/loaded/list`、`turn/start`、`turn/steer`（往进行中的回合追加用户输入）、`thread/inject_items`；订阅按连接计算，多个客户端可以同时订阅同一个已加载的线程；
  - 官方标注实验性、不支持生产负载；非回环地址的 ws 默认不鉴权，需要配 capability token。
- hooks 文档：`Stop` 返回 `decision: "block"` 时，`reason` 会作为新的续写提示继续执行（回合结束才触发）；事件里还有 `SessionStart`、`UserPromptSubmit` 等。
- `notify` 只在 `agent-turn-complete` 时调用外部程序，是往外发的单向通知，不能用来唤醒（config-advanced 文档）。
- `codex exec resume <id>`：另起进程对已存的会话跑一轮无头回合（本机 `codex exec --help`）。
- **前提**：用户的 TUI 必须用 `--remote` 方式启动，否则桥连不上那个进程内的 app-server，所以需要改变用户的启动习惯。

### Antigravity（邮局身份 `gemini`）
- **本机**：`%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`，版本 2.19.1（Google，Electron 外壳加 `resources\bin\language_server.exe`），正在运行（数据目录里有 lockfile）。数据在 `~/.gemini/antigravity`（8 个会话），配置在 `~/.gemini/config`。
  - `sidecars/` 目录存在但是空的；`config.json` 里只有 `userSettings`，没有 `sidecars` 项，即**一个 sidecar 都没开**；没有 `hooks.json`。
  - `%APPDATA%\Antigravity\bin\agy-node.cmd` 只是把 Antigravity.exe 当 Node 运行的垫片，不是 agent 命令行。`agy`（Antigravity CLI）不在 PATH 上。
- **Sidecars**（docs/sidecars）：
  - 由 Antigravity 发现并托管的后台进程，可设重启策略。配置是 `~/.gemini/config/sidecars/<id>/sidecar.json`，也可以随插件分发。
  - **默认关闭**，必须在 `~/.gemini/config/config.json` 的 `sidecars.<id>.enabled` 里显式打开，所以启动权在人手里。
  - sidecar 的 PATH 里自带 `agentapi`：`new-conversation <prompt>`（需要配置 `projectId`）和 **`send-message <conversation_id> <prompt>`**。另有内置的 cron 调度器（`builtin: "schedule"`）。运行数据和日志在 `~/.gemini/antigravity/sidecar_data/<id>/`。
- **Hooks**（docs/hooks，2.0、CLI、IDE 通用）：
  - 事件有 `PreToolUse`、`PostToolUse`、`PreInvocation`、`PostInvocation`、`Stop`，配置在 `~/.gemini/config/hooks.json` 或工作区的 `.agents/hooks.json`。
  - `Stop` 返回 `decision: "continue"` 会让 agent 不停下，`reason` 作为系统消息注入；没有后台唤醒类字段。
  - hook 收到的输入里带 `conversationId`，可以用来辅助会话绑定。
- **`schedule` 工具**（docs/hooks 的工具清单）：agent 自己可以设定时器或 cron，到点注入一段 Prompt，相当于轮询式自唤醒。但这是**模型可调用**的，不能当成"只有人类能开启"的启动方式。
- **Antigravity CLI**（docs/cli，本机未装）：`agy -p` 无头运行，`--output-format json` 会返回 `conversation_id`；`agy -c` 续接会话。
- **还没确认的**：
  - `send-message` 发到空闲会话时是不是立刻开始一轮；会话正在跑时是排队还是插入；
  - 会话绑定怎样由人确认（要防止模型自己改 `config.json` 或绑定文件，这一层属于"工具边界 ≠ 文件系统边界"）；
  - Windows 下 sidecar 进程环境的具体细节。

### Gemini CLI（本机未安装，仅作对照）
- 以下全部来自 google-gemini/gemini-cli 仓库 docs（最新发布 v0.62.0，2026-09-29）。
- hooks 有 11 个事件（BeforeTool/AfterTool/BeforeAgent/AfterAgent/BeforeModel/BeforeToolSelection/AfterModel/SessionStart/SessionEnd/Notification/PreCompress），**都没有后台唤醒能力**。`AfterAgent` 返回 deny 加 reason 会"驳回本次回答并重试"，借它注入信件属于语义滥用，有吞掉正常回答的风险，不建议用。
- ACP 模式（`gemini --acp`）：stdio JSON-RPC，提供 `loadSession`、`prompt`、`cancel`，由客户端（也就是桥）托管会话，和用户自己的终端会话不是同一个进程。
- 无头 `gemini -p` 加 `--resume`（最新一个 / 序号 / UUID）；通知是实验性的 OSC 9 单向提醒。

## 将来做桥时必须保住的四条硬约束（对应 LocalPost）

1. **只有人类能开启**：几条可行路径都需要用户在客户端侧显式开启（写 hooks 配置、加 channels 开关、用 `--remote` 启动、在 Antigravity 的 `config.json` 里打开 sidecar），模型自己打不开。前提是模型改不了这些配置文件，这一点要由各客户端的沙箱或权限来保证，属于"工具边界 ≠ 文件系统边界"。
2. **单消费者**：hook 每次触发都是新进程且不去重；channel 每个会话各起一个服务器；Antigravity 的 sidecar 虽然只有一个，但会被自动重启。所以桥必须按身份持有租约（可复用 `fs-safe` 的 `acquireLease`），只有持有者推送，并记账"哪封信已经投过"，防止重启后重复投；还要与 DSH 侧的 receiver 互斥（同一身份不能两边都消费）。
3. **allowFrom**：桥侧照搬 receiver 的严格白名单；channels 自带发件人白名单的概念，可以对齐。
4. **身份**：外部客户端没有 DSH 那种宿主证明的调用者。身份只能由"启动参数里写死的身份 + 一个会话进程"来定；信件内容仍是不可信数据，授权范围仍是 analysis-reply。

## 建议（超出本次授权，等用户决定）

优先做两条官方正式文档里就有的路径：
- **Antigravity 的 sidecar 桥**：`agentapi send-message` 本来就是"给已有会话发消息"的接口，进程由宿主托管、自动重启，约 1–1.5 天；
- **Claude Code 的 asyncRewake 桥**：约 1 天，但需要每轮重新挂上守望进程。

之后再评估 Codex 的 app-server 桥（实验性，约 2–3 天）。Gemini CLI 本机没在用，不投入。
每个桥开工前都要单独过一次生态检索门禁，并用测试覆盖上面四条约束。

## 来源（2026-10-05 拉取）

- Claude Code：<https://code.claude.com/docs/en/hooks>（asyncRewake、Stop decision control、Run hooks in the background）· <https://code.claude.com/docs/en/channels> · <https://code.claude.com/docs/en/channels-reference> · <https://code.claude.com/docs/en/agent-view>
- Codex：<https://developers.openai.com/codex/app-server> · <https://developers.openai.com/codex/hooks> · <https://developers.openai.com/codex/config-advanced>（notify）
- Antigravity：<https://antigravity.google/docs/sidecars> · <https://antigravity.google/docs/hooks> · <https://antigravity.google/docs/cli/headless> · <https://antigravity.google/docs/cli/conversations> · <https://antigravity.google/docs/cli/gcli-migration> · <https://antigravity.google/docs/changelog>（v2.19.1，2026-09-30）· 目录 <https://antigravity.google/llms.txt>
- Gemini CLI：<https://github.com/google-gemini/gemini-cli/tree/main/docs>（`hooks/reference.md`、`cli/acp-mode.md`、`cli/headless.md`、`cli/session-management.md`、`cli/notifications.md`）
- 本机：`codex --version`（0.139.0）、`codex --help`、`codex exec --help`、`codex app-server --help`、`codex remote-control --help`、`codex features list`、`claude --version`（2.1.233）、`claude --help`、`claude agents --help`；Antigravity：`Antigravity.exe` 文件版本信息（2.19.1）、安装目录与 `~/.gemini/config` 的只读目录列表、`config.json` 顶层键（没读配置内容）、`~/.gemini/AGENTS.md` 中的身份行
