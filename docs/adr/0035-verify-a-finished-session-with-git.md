---
status: accepted
---

# Verify a finished session with git

A delivery session is finished when its process exits, and it succeeded when git
says so: exit code zero, the fixed branch ahead of its base, and a clean
worktree. Nothing the session writes is consulted. The terminal protocol markers
— `IMPLEMENTATION_READY`, `TICKET_COMPLETED`, `QUEUE_EMPTY`, `QUEUE_BLOCKED`,
`WORKFLOW_STEP_FINISHED`, `RECONCILIATION_REQUIRED` — are removed along with the
`terminalMarker` plumbing in every CLI adapter, the marker resume prompt, and the
idle nudge that existed to re-inject one.

The markers were a control plane made of provider text, which ADR-0020 had
already rejected for queue outcomes. They survived for completion because the
coordinator had no other way to distinguish "the agent implemented the issue"
from "the agent exited". Git supplies that distinction directly and cannot be
persuaded: an agent that asked a question, refused, or explored without
committing leaves a branch with no commits over its base, and an agent that
committed part of its work leaves a dirty tree. Both are failures, decided by
two commands rather than by a line of text a model chose to print.

Exit code alone was rejected for the same reason the markers existed. It answers
whether the process ended, not whether work landed, and a fast deterministic loop
that pushed and merged on exit code alone would open empty pull requests and
merge them.

In a multi-repository workspace the rule is per repository: every participant
clean, at least one ahead of its base. A repository a transversal delivery did
not need is a repository with nothing to prove.
