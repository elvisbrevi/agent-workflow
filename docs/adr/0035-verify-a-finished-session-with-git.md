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

The single-repository Azure delivery gates the same way: when the session's process
exits, `verifySession` asks git whether the ticket branch is ahead of the HU
integration branch with a clean tree, and the answer is the commit the delivery
pushes. `verifySessionWithGit` is one function both providers call, because the
question is the same and only what follows it differs. With the marker gone from that
path, so is the retry loop it justified — nothing resumes a session toward a marker it
was never asked to print, so a session that exits without a verifiable branch is an
ordinary unit failure and leaves the ticket `En progreso` with its branch in place.

Both workspace modes gate the same way now: GitHub and Azure each verify every
participant repository with git after the session's process exits, and neither
prompt nor gate names `IMPLEMENTATION_READY`. No delivery path carries the marker
anymore; the `terminalMarker` plumbing that remains in the CLI adapters serves
the planning protocol markers only.

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
