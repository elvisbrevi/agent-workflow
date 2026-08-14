---
status: accepted
---

# Coordinate GitHub delivery outside OpenCode

GitHub `code` runs use a repository-owned coordinator for queue discovery,
stable oldest-first selection, verified claiming, branch and pull-request
effects, issue closure, parent reconciliation, recovery, and terminal queue
outcomes. OpenCode receives one fixed issue and returns an
`IMPLEMENTATION_READY` manifest after implementation, validation, review, and
local commit preparation; it cannot select work, mutate remote GitHub state,
or declare `TICKET_COMPLETED` or `QUEUE_EMPTY`. This supersedes the
prompt-driven queue drain in ADR-0018 because provider text is not a reliable
control plane and partial remote delivery requires deterministic recovery.

Selection orders eligible issues by creation time and then issue number,
claims the selected issue, and rereads it before work starts. A
repository-scoped checkpoint fixes the issue and delivery phase until every
effect is reconciled. After a child closes, native parents close recursively
only when they have at least one native sub-issue, every direct sub-issue is
closed, and no native dependency remains open. The coordinator distinguishes
`TICKET_COMPLETED`, `QUEUE_EMPTY`, `QUEUE_BLOCKED`, and
`RECONCILIATION_REQUIRED`; unrelated `needs-triage` issues are outside the
managed queue, while any open child prevents parent closure.
