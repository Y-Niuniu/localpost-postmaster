# LocalPost: Local AI Agent Communication and Task Reconciliation

[简体中文](README.zh-CN.md) · [Engineering report / 工程报告](docs/localpost_engineering_report_and_manual.zh-CN.md)

LocalPost is a personal engineering project for coordinating AI agents running in different development tools on the same computer. JSON envelopes and shared directories carry tasks, results and attachments; a reconciliation kernel tracks receipts, overdue tasks and conflicts.

The core uses Node.js built-in modules, with no third-party npm runtime dependencies and no separate network message broker.

## My role and development approach

I defined the requirements and designed the architecture: task and receipt relationships, module responsibilities, and the handling of failures and uncertain delivery. Implementation was developed primarily by AI coding agents under this design direction.

This project demonstrates my work in requirements analysis, system architecture and organising AI-assisted development. It is not presented as independently handwritten implementation.

## What the project does

- Exchanges `task`, `result` and `ping` envelopes, with references to shared attachments.
- Matches receipts to the original task using identifiers, thread context and sender/recipient relationships.
- Distinguishes terminal results from requests awaiting user authorisation.
- Coordinates controlled writes through exclusive file leases and ownership checks.
- Records ownership and completion intent for managed letters, supporting consistent retries.
- Reports partial failures such as a published receipt whose original task could not yet be archived.
- Provides reception queues, retention-aware cleanup, verified backups and optional notifications.

## Architecture

| Component | Responsibility |
|---|---|
| `localpost/fs-safe.mjs` | Path checks, atomic writes, leases and bounded Windows rename retries |
| `localpost/mailbox.mjs` | Controlled delivery, reading, claiming, receipts and archiving |
| `letter-claims.mjs`, `session-binding.mjs`, `rotation.mjs` | Managed ownership, session binding and staged handover |
| `postmaster.mjs`, `receiver.mjs` | Reconciliation, alerts and reception queues |
| `gc.mjs`, `mail-backup.mjs` | Conservative cleanup, snapshot verification and isolated restoration |
| `lib/`, `integrations/` | DeepSeek Harness plugin, MCP interfaces and external-client bridges |

Module names in this table refer to `localpost/` unless another directory is shown.

Published envelopes are treated as immutable evidence by the controlled interfaces; the ledger and alerts are derived views. Uncertain dispatch is retained for reconciliation rather than blindly retried. A host accepting an invocation is distinct from a model completing the task.

## Inspect and test

Node.js 24 is recommended. No `npm install` is required for the core.

```sh
git clone https://github.com/Y-Niuniu/localpost-postmaster.git
cd localpost-postmaster
node scripts/test.mjs
```

The runner uses isolated temporary directories for the core suite and legacy plugin self-tests. Test results must be taken from the actual output; offline tests do not establish production acceptance across all clients.

Cloning or testing does not deploy the project or enable model wakeups.

## Integration and engineering documentation

- [Reviewed Chinese engineering report](docs/localpost_engineering_report_and_manual.zh-CN.md): architecture diagrams, implementation mechanisms and corrected operational guidance; based on a Gemini-generated draft.
- [Integration](docs/integration.md), [session rotation](docs/rotation-decisions.md) and [backups](docs/mail-backup.md).
- [External-client integrations](integrations/README.md) and [verification entry points](integrations/verification/README.md).
- [Historical plugin README](docs/legacy-plugin-readme.md): earlier configuration details, retained as an archive.

Deployment requires an explicitly selected mailbox root, identity, sender allowlist and target session. The repository contains both core and compatibility MCP entry points, with different environment variables and reading/claiming semantics.

## Scope and limitations

LocalPost targets processes sharing a local filesystem. It does not promise cross-host consistency or end-to-end exactly-once execution. Sender fields are not cryptographic authentication; trusted operation depends on filesystem permissions and controlled interfaces.

Client wakeup behaviour depends on the host and version and requires separate verification. Mail content is task data, not authority to modify files or perform external actions. Historical design and deployment records should be read with their dates and applicable versions in mind.
