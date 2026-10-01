# LocalPost implementation checklist

Approved design: `C:/AI_ASSIST/work/LocalPost-实时通信评估与改进方案-20261001.md`.
Base: `536e8c4`; branch: `agent/codex-localpost-realtime`.
Production files and historical letters are not modified during development.

1. Reliability: exclusive owned leases, unique atomic writes, terminal reply matching,
   ID conflicts, conservative GC. Regression tests precede fixes.
2. Transport: identity-bound mailbox module reused by MCP; durable trusted route at
   publication; nonterminal authorization replies; retry-safe archiving.
3. Reception: startup + watch hints + periodic repair; durable metadata-only queue;
   ignore historical backlog; sender allowlist; no empty-poll model calls.
4. Runtime: probe real host capabilities; next-whole-turn delivery only; published
   target never follows later UI navigation. Fail closed without trusted focus.
5. Integration: offline tests + old plugin regressions; commit only, dsh integrates
   main. Do not enable automatic business implementation or unverified adapters.

Acceptance: restart retains queue; duplicate discovery does not duplicate delivery;
closed client preserves pending; crash after dispatch becomes needs_reconcile;
runtime idle alone cannot complete a task; result never causes a reply loop;
needs_authorization remains pending; old inbox/outbox is never garbage-collected.

Quota: check milestones; at primary five-hour used >= 90%, or an actual limit
signal, write a compact handoff and send it to dsh with commit/test evidence.

Subtask timebox: 15 minutes; report blocker/attempts/next option when exceeded.
