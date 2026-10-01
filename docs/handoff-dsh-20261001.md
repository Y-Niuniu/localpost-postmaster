# Codex -> dsh: LocalPost infrastructure handoff

User explicitly authorized implementation of the approved proposal and asked dsh
to take over before the five-hour quota runs out. Primary quota was 81% used at
the last checked milestone; handoff is early to leave delivery margin.

Working repository: `C:/AI_ASSIST/work/localpost-codex`.
Branch: `agent/codex-localpost-realtime`; base `536e8c4`.
Approved proposal: `C:/AI_ASSIST/work/LocalPost-实时通信评估与改进方案-20261001.md`.
Read `docs/integration.md` and `docs/runtime-probe.md` rather than repeating the plan.

Implemented: owned exclusive locks, atomic publish and retry-safe replies,
identity/path constraints, valid terminal reply matching, duplicate/conflict
handling, conservative GC, durable receiver/watch/repair scans, publication-bound
routing, crash recovery, and a disabled injectable DSH rc.2 adapter.

Verified before handoff: 59/59 new tests; old plugin 40/40 checks, all exit 0.
The old plugin test was corrected to produce a valid reverse reply and compare
source ledger bytes instead of merely checking that a ledger exists.
`node scripts/test.mjs` is the combined rerunnable command.
DSH adapter tests use fake contracts, NOT the real desktop host.

Not done: no production file replacement, no main merge, no watcher installed,
no autonomous model dispatch enabled. Desktop current-chat focus and durable
same-host delivery are unresolved; keep them disabled and report that honestly.

Next actions for dsh:

1. Review delivery commit and rerun isolated suite; use your own integration
   worktree and follow the unique mailbox README/delivery rules.
2. Inspect retention when multiple distinct terminal replies exist; GC must use
   the latest valid completion time (not any older valid reply) before deletion.
   The current tests cover one terminal plus newer nonterminal, not that edge.
3. Review/migrate sticky old replied ledger records by rebuilding from valid
   envelopes. Update the unique operations README for needs_authorization before
   enabling the new protocol. Do not duplicate rules elsewhere.
4. Back up and integrate modules together; preserve private notify configuration.
   Do not merge/enable blindly. Explicit live-host focus/acceptance proof is still
   required; a fixed chat is not the user's chosen behavior.

Preserve the original codex backlog unchanged:
`dsh-20260929-001`, `dsh-20260930-002`, `dsh-20260930-004`.
Those are older learning tasks, not authorization for this infrastructure work.
New permission remains auto read/analyze/reply only; business implementation
requires human authorization. The infrastructure change itself was authorized.

No credentials included. No native UI, new conversation, cold resume, daemon
startup, or queued automation was executed. Lock screen is okay for local work;
sleep, shutdown, or client exit pauses it.
