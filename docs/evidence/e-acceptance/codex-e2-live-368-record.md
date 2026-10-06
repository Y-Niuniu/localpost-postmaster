# 3684e84 新批次：聊天权限与收信回执证据

记录日期：2026-10-04（以下时刻均为 UTC）。仅隔离测试根，不是生产放行。

## 判定

- 聊天权限：用户截图显示 B 的 start/stop/status 全部拒绝；用户贴出 A running=true，root 为 canonical 测试根。磁盘绑定仍为 A、active/auto、analysis-reply。
- 真实收信回执链：新测试信成功投递；约 0.32 秒后提交；23.4 秒后收到 DSH completed 回执。队列 completed，claims done，attempts=1，原信归档。
- E2 空闲聊天的真实注入→阅读→回执→归档链：宿主事件和用户追加截图已核实；完整安全验收仍不放行，因自动回合访问了生产路径/全局对账工具。忙碌回合整轮后处理尚未测。
- E1 到达锁定：本次 arrival 确认目标 A；来信到达后切换/重绑定拒绝仍未在本批次测试。
- E3–E6：本批次尚未执行；生产自动派发仍不放行。

## 本次事实

- runtime HEAD：3684e84e908801f3088ddaad37d3939b4eb3990e；投递脚本即时验证工作区干净。
- 测试根：C:/AI_ASSIST/work/localpost-e-test。
- A：session-16854214-d220-4ecc-8e57-65fa5df3fbcd；host=local；cwd=C:\AI_ASSIST；generation=1。
- B：用户截图中的未绑定聊天“会话请求”；准确 session ID 未取得。
- ID：mcptest-e2-368-9bf8f0ac-5626-4c59-86cb-c6792a49e11a；新 ID，不复用历史测试信。
- arrival：2026-10-04T19:10:50.998Z；route.threadId=A。
- submitted：2026-10-04T19:10:51.318Z。
- result：2026-10-04T19:11:14.391Z；outcome=completed；正文“收到隔离 E2 测试信”。
- claim done：2026-10-04T19:11:14.397Z；attempts=1；transfers=0。
- queue：completed；errors=[]；resultId 指向本信 result。
- 原信在 agents/dsh/archive；结果已由 codex 受控 API 归档到 agents/codex/archive，不发送 result-on-result。

## 原始证据路径（均为测试根内）

- runtime/arrivals/dsh/mcptest-e2-368-9bf8f0ac-5626-4c59-86cb-c6792a49e11a.json
- runtime/queues/dsh.json
- runtime/sessions/dsh.json
- agents/dsh/archive/mcptest-e2-368-9bf8f0ac-5626-4c59-86cb-c6792a49e11a.json
- agents/codex/archive/mcptest-e2-368-9bf8f0ac-5626-4c59-86cb-c6792a49e11a.result.json

## 执行与取证限制

首次沙箱执行在获取写租约时 busy 超时，未见信封/arrival/claim 落盘，也未见根级锁文件；同一脚本经显式执行权限成功，不改门禁、不删锁。最符合执行权限差异；并非已经证明生产锁算法存在故障。

初版观察器仅解压第一帧，因此 ID 命中数为 0。追加核验改为按 info.engine.bytesWritten 遍历全部压缩帧：104161 压缩字节全部消费、55 帧、解压 312323 字节、103 行；本次 ID 命中 12 行。这个取证工具问题不是运行邮局的问题。

## 用户第二张截图与宿主事件复核

- 截图文件：C:/Users/16548/AppData/Local/Temp/codex-clipboard-61bd8d45-ec1c-43de-af16-f2c1899dab17.png；聊天标题“本地邮局测试”。截图展示原生 localpost_read/localpost_reply 成功，与磁盘回执一致。
- seq49 agent/inbox/spliced：target=next-turn；seq53 user/message：同一消息 UUID 6d78163f-31c4-49cc-9d73-36932fd0df21、role=user、source.kind=plugin:localpost、source.form=relay。
- seq57 localpost_read 成功；seq87 localpost_reply 成功并报告原信归档；seq101 turn/end。
- 起初 NOT_BOUND：seq30/32，19:01:23，早于用户 binding.since=19:01:41；来信处理时 seq59（19:10:53）返回 active 对应的 mode=auto/generation=1/A/claims=1。这不是新出现的绑定竞态或故障。
- 第一次人类回合结束：seq38，19:01:25.825；信到达后第二轮开始：seq50，19:10:51.287。这只证明空闲 A 被自动唤醒，不证明忙碌回合不会被插队。

## 阻塞项：自动回合混入生产路径与全局工具

- seq64 使用 glob 枚举 .mailbox/agents/dsh/inbox；seq66 试图用通用 read 去生产 .mailbox 读取本测试 ID，seq67 为 not found。测试信实际在隔离根，模型回退到了规则文件中的默认生产路径。
- seq94 调用 localpost_check({dry_run:true,verbose:true})；截图自行承认看到其他 agent 的全局账本元数据。此次不是写入证据，但超出“仅测试根收信回执”的范围。
- lib/index.js:319–359：全局 localpost_check 直接 manualCheck(args)，没有依据本次 relay/root/caller 限制；dry_run 默认 false，执行路径 config.root 默认生产根。因此不能把本次模型自选 dry_run 当成权限隔离保证。未实际调用 false 验证，禁止在生产测试这种副作用。
- dsh-adapter.mjs 的 relay 只提供 agent/id，未明确当前隔离根；dsh-mail-tools.mjs 的原生 read 只返回部分信封字段，模型因寻找完整字段而自行访问生产路径。根因仍需 DSH 最小复现与修补方案验证，不预先承诺仅改提示词能保证安全。
- 建议暂停继续投信；由用户在 A 执行 /localpost-e-stop，并回传完整 running=false。不得重建根、删除证据、重投旧信或自动部署。后续修补先给方案/回归证据，重点确保隔离 relay 不回退生产路径、不能调用会触及生产的工具；普通人工任务不应被无差别禁用。

使用 mailbox 技能约束身份/收件/归档；verification-before-completion 技能使完整 E2 保持待验，避免把队列状态当成整机通过；diagnose 技能用于投递权限差异排查。未修改运行代码或生产配置。
