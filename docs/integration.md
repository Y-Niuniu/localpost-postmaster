# Staged LocalPost integration

This branch is a delivery artifact, not a production deployment. dsh is the sole
main integrator. Keep the authoritative mailbox operations in
`C:/AI_ASSIST/.mailbox/README.md`; do not copy its rules into agent instructions.

## Files and migration

- `localpost/postmaster.mjs`: replacement kernel, alongside `fs-safe.mjs`.
- `localpost/gc.mjs` + `localpost-gc.ps1`: safe collector; preview by default;
  apply requires an explicit switch. Existing scheduled calls without that switch
  stop deleting. Use the tested bundled pwsh rather than changing machine policy.
- `localpost/mailbox.mjs` + `mcp-server.mjs`: common publisher and seven MCP tools.
  Set `MAILBOX_ROOT` and bind `MAILBOX_IDENTITY=codex` (or dsh per process).
  Unbound identity is administrator mode, unsuitable for auto-processing.
- `localpost/receiver.mjs` + `receiver-cli.mjs`: watch + 30-second repair scans and
  metadata-only durable queues in `runtime/queues`. Empty polling calls no model.
- `localpost/dsh-adapter.mjs`: injectable rc.2 contract, disabled without verified
  focus and durable idempotent acceptance. Fake tests are not live-host evidence.

Deploy the modules together, back up current production files first, preserve
private notification configuration, stop writers during migration, run isolated
tests, then run the new kernel in dry-run before replacing production. Existing
ledger replied statuses are intentionally monotonic: review/rebuild the ledger
from envelopes to eliminate historical false completions before auto enablement.
Update the unique README's nonterminal-result instructions in the same migration.

`node scripts/test.mjs` runs new module tests and the older 40-check plugin test.
All test temp directories are inside this worktree. No npm install is needed.

## Reception-only usage (explicit enablement)

```
node localpost/receiver-cli.mjs status --root C:/AI_ASSIST/.mailbox --agent codex
node localpost/receiver-cli.mjs receive --root C:/AI_ASSIST/.mailbox --agent codex --allow-from dsh --enable
```

The receive command above is a deployment instruction, not a command already run.
Its first initialization snapshots historical IDs under the common publish lock;
pre-existing letters are retained and skipped. New legacy direct-file messages
without a trusted publication-time focus are durable `unbound` entries, not routed
using scan-time focus. A trusted publisher supplies the route out of band; the
envelope cannot declare authority or a desktop destination.

Accepted runtime work stays submitted until a matching explicit result exists.
Uncertain dispatch is never blindly retried; a matching result may reconcile it.
Result messages cannot be replied to with another result. Analysis-only automatic
permission does not authorize code/file implementation.

## Remaining live-host prerequisites

Codex current visible chat and same-desktop control transport have NOT been
verified. DSH followup semantics are source-verified but not exercised live.
Neither focus nor cross-crash durable acceptance is supplied by this branch.
Do not enable dispatch by setting capability flags without implementing and
testing those boundaries. Do not silently substitute a fixed/recent chat.

Live acceptance must demonstrate A-to-B switching, next-whole-turn scheduling,
closed-client retention, duplicate hints, and lost acknowledgements in a harmless
test chat. Native daemon startup, cold resume, automation, and production model
calls are not part of this delivery.

Path checks catch ordinary traversal/junction escapes and receiver root changes;
they are not an OS-level defense against a malicious local process replacing
directories between validation and I/O. Trusted root ACLs remain necessary.
Malformed/abandoned recovery gates require explicit inspection, not blind removal.
