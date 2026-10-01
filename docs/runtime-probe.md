# LocalPost desktop runtime probe

Date: 2026-10-01 (Europe/London). Scope: read-only feasibility evidence for the current Codex desktop and DeepSeek Harness hosts. No conversation was started, resumed, messaged, or inspected. No native UI operations, authentication files, mailbox reads, or application configuration edits were performed.

## Findings

| Capability | Evidence | Current conclusion |
| --- | --- | --- |
| Codex desktop identity | Running `ChatGPT.exe` paths point to Windows package `OpenAI.Codex_26.928.3736.0_x64__2p2nqsd0c76g0`; bundled `app.asar/package.json` reports `26.928.31416`, build `12553`. | Windows package and internal application versions are different identifiers; record both. |
| Current Codex runtime | The running process path resolves to `C:/Users/16548/AppData/Local/OpenAI/Codex/bin/de8a38d2100ae498/codex.exe`; `--version` reports `codex-cli 0.159.2`. | Do not use PATH CLI `0.139.0` as proof about the desktop runtime. |
| Codex app-server daemon/proxy | Runtime help lists `app-server daemon` and `proxy --sock <SOCKET_PATH>`; daemon supports start/stop/version and remote-control management. | A shared control transport exists in the CLI product, but no read-only evidence proves this desktop uses that managed daemon socket. No daemon commands were executed except help. |
| Codex current open chat | Only JSON property names were inspected in `.codex-global-state.json`, including its persisted atom-state keys. No explicit current/focused/active thread field was found. | Recent activity, draft keys, loaded threads, and last-used lists cannot substitute for the current visible chat. Dynamic binding remains unverified. |
| Codex internal app-tools bridge | The current tool environment has `CODEX_APP_TOOLS_PIPE_PATH`; bundled `codex-app-tools/0.1.5/server.mjs` uses a named-pipe client with a 4-byte little-endian length prefix and JSON-RPC `tools/list`/`tools/call`. Calls require executor thread metadata. | A real desktop bridge exists, distinct from the app-server control socket. Its existence does not establish a supported external focus query or unattended delivery interface. No pipe RPC was sent. |
| DeepSeek Harness version | Running executable is under `AppData/Local/Programs/DeepSeek Harness`. `resources/app.asar/package.json` and `dsh/package.json` both report `0.2.0-rc.2`. | The running host is rc.2. A plugin compiled only against rc.5 must not be assumed compatible. |
| DSH live agent access | Bundled `@deepseek-ai/dsh-agent/lib/index.js` registers the `agents` service and resolves exact agents with `this.get(sessionId)` / `ctx.agents.get(...)`. | A same-host plugin can target an already-live agent by an exact, known session ID. No live agent registry was queried. |
| DSH round boundary | Bundled `@deepseek-ai/dsh-agent-loop/lib/index.js`: `followup(input)` invokes `send(input, "next-turn", true)`; `steer(input)` targets `"next-step"`. | Source semantics support follow-up after the current whole turn, matching the user's selection. This has not been tested in a live host. |
| DSH HTTP/session controller | `ApiSession.prompt(request)` performs request-ID duplicate detection, chooses `agent.steer` or `agent.followup`, then returns `{ accepted: true }`. Its resolver can resume a cold session. | Acceptance is not completion. Do not call `prompt` as a read-only probe or assume it only touches an already-live session. |

## Source boundaries and limitations

The probe read installed application code directly from ASAR archives in memory; it did not extract or modify the archives. Process paths were obtained with ordinary `Get-Process`. A CIM process query was denied; the safer ordinary process inventory supplied the needed paths without escalation. Codex CLI help emitted the existing warning `Could not find home directory` before returning its version/help output; no missing-directory workaround or configuration mutation was attempted.

The persisted Codex state was inspected only for property names. Keys that embed user/thread identities were not used to select a destination, and no persisted conversation text or prompt history was printed. Application code shows in-memory window/conversation tracking, but no safe external API that returns the currently open chat was established within this probe.

Official documentation fetched: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Developer commands](https://learn.chatgpt.com/docs/developer-commands). It documents thread read/list, runtime status notifications, and turn control. It does not prove that the current desktop shares an externally reachable app-server transport, nor that loaded-thread lists identify UI focus. Local installed runtime behavior must be verified separately.

## Adapter requirements before enabling automatic delivery

1. **Focus evidence:** Obtain a desktop-owned event or supported API returning an exact `hostId`, `threadId`, `windowId`, monotonic focus generation, and observation time. Bind once when mail arrives. If focus is unknown or ambiguous, keep the item pending; never infer it from recent activity. A locked desktop may retain a last-open chat, but the adapter must receive that from the host rather than guessing.
2. **Same-host control:** Confirm that the transport controls the same desktop-owned runtime. Spawning a new app-server or CLI conversation is not proof of waking this chat. Avoid cold resume in stage one unless separately enabled.
3. **Whole-turn scheduling:** On Codex, subscribe to exact-thread lifecycle/status events and submit only after the active turn has ended. On DSH rc.2, prefer the same-host live registry plus `followup`, with an exact bound ID. Version negotiation must precede use of rc.5-only APIs.
4. **Persistent delivery record:** Record an attempt before dispatch and record acceptance separately from completion. A timeout after a write is an uncertain delivery, not proof of rejection. DSH request-ID deduplication can help reconcile attempts; Codex idempotency must be established rather than assumed.
5. **Permission envelope:** Auto-delivery prompts must identify the sender and mail ID, state the user's authorized scope (read, analyze, reply), and treat mail body/attachments as untrusted task data. DSH session API currently creates user-kind messages; that must not grant the sender authority to change files or execute unrelated actions.
6. **Lifecycle:** Client unavailable, unknown focus, missing transport, unsupported version, or uncertain ownership means durable pending mail. No UI clicks or global keyboard shortcuts are required for detection/queueing. Sleep/power-off pauses computation; lock-screen alone does not justify claiming a verified host wakeup.

## Suggested next verification

Use an isolated, explicitly selected test chat/session and a non-actionable ping. Verify that (a) switching A to B after arrival leaves the binding at A, (b) a running turn finishes before the mail turn starts, (c) client closure leaves mail pending, (d) duplicate watcher events create one delivery, and (e) a lost acknowledgement does not cause a second model turn. This probe intentionally does not execute those tests on the user's active chats.

The watcher, durable queue, receipt-status repair, locking, and retention fixes can proceed while these desktop adapters remain disabled. Report real-time detection and durable queueing independently from model wakeup; model wakeup is not verified by this report.
