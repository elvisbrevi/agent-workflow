---
status: accepted
---

# Verify a finished session with git

A delivery session is finished when its process exits, and it succeeded when git
says so: exit code zero, the fixed branch ahead of its base, and a clean
worktree. Nothing the session writes is consulted.

The GitHub delivery path is where this landed first, and there `IMPLEMENTATION_READY`
is gone: no prompt asks for it, no gate reads it, and the marker resume it justified
(`resumeWithoutMarker`) is gone with it. What still prints `TICKET_COMPLETED`,
`QUEUE_EMPTY`, `QUEUE_BLOCKED` and `WORKFLOW_STEP_FINISHED` is the coordinator's own
stdout, for whatever reads a run's output — those were never a session's to emit, and
retiring them is a separate change to that output contract.

Azure delivery, the workspace paths and the `terminalMarker` plumbing in the CLI
adapters still carry the marker, and the idle nudge still re-injects it in OpenCode.
That is deliberate sequencing, not an oversight: Azure has its own slice, and until it
runs the two providers gate differently. A reader comparing this ADR against
`lazy-workflow-cli.ts` will find both mechanisms, and the Azure one is the older.

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
