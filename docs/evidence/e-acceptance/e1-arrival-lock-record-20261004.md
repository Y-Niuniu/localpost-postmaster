# E1 记录：到达锁定 A、切 B 不改目标（2026-10-04）

## 判定
- **E1 判定点（到达锁定 + B 不能抢夺）：PASS**
  - 受控投递 mcptest-e1-1 时，到达记录 pin 到当时的绑定聊天 A，且两次复检均未变。
  - 在聊天 B 执行 /localpost-bind 被拒绝：『LocalPost: this identity is bound to another chat. T1 cannot move a binding between chats (that needs its own protocol).』
- **E1 附带观测（非判定点）：环境事件——隔离 receiver 在测试中途停止**，须记录且不得算作通过。

## 证据 1：受控投递（非直接写 inbox 冒充）
```
DELIVER={"id":"mcptest-e1-1","delivered_to":"C:\\AI_ASSIST\\work\\localpost-e-test\\agents\\dsh\\inbox\\mcptest-e1-1.json","idempotent":false,"warnings":[]}
```
投递脚本：docs/evidence/e1-deliver-mcptest-e1-1.mjs（用发件方 codex 的 mailbox 实例 deliver，arrival route 由收件方 dsh 的当前绑定决定）。

## 证据 2：到达记录 pin 住 A（两次复检一致）
```
runtime/arrivals/dsh/mcptest-e1-1.json
  arrivedAt = 2026-10-04T15:19:44.155Z
  digest    = 3235b7ab4a7704fc1367171acac12edc2228c3be3c2d8883db79c3267198d219
  route     = { identity: dsh, hostId: local, threadId: session-e53beab1-69db-4b92-a7ac-d2f652b34221, generation: 1 }
```
复检时刻（本地 16:22 前后）仍为同一 threadId/generation —— 期间 B 尝试过 bind 并被拒。

## 证据 3：绑定与信件状态
```
runtime/sessions/dsh.json : mode=auto generation=1 session=session-e53beab1-… host=local cwd=C:\AI_ASSIST  claims=0
agents/dsh/inbox/mcptest-e1-1.json : 存在（未被归档）；archive 无此信
```

## 证据 4（环境事件，非判定点）
```
runtime/queues/dsh.json : enabledAt=2026-10-04T15:05:14.189Z  updatedAt=2026-10-04T15:18:44.214Z  entries=0 errors=0
队列更新时刻：16:08:44 → 16:18:44（约 10 分钟一跳，非 30 秒）
聊天 A 的 /localpost-e-status = {"running":false,"dispatchEnabled":true,"owned":true,"disposed":false,…}
```
**解读（待 codex 裁定）**：`disposed:false` 表示当前 wiring **未被销毁**，但 `running:false` 表示 receiver 不在跑；队列最后一次写入（16:18:44）与它停止的时刻吻合。最可能原因是**插件被重新 apply**：新 wiring 的 running 从 false 起步，旧实例 dispose 时按设计停掉自己启动的 receiver（这是**正确行为**，不是缺陷）。
**影响**：E1 的两个判定点不受影响（到达路由与绑定都不依赖 receiver 在跑）；但 E2（整轮后受理）必须在 receiver 重新 start 之后才能继续。

## 未做
未伪造任何用户命令 / 故障注入 / 『没有第二次唤醒』证据；未改状态文件；未重建测试根；生产 receiver 与自动派发仍关闭。