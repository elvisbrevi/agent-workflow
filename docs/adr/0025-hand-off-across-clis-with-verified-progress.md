---
status: accepted
---

# Hand off across CLIs with verified progress

When a fallback rung names the same CLI as the exhausted one, the run resumes
the existing session with the new model and variant, which is the override path
the agent already supports. When the rung names a different CLI there is no
session to resume, because a session lives inside the CLI that created it. That
run continues through a cross-CLI handoff: a fresh session in the new CLI whose
prompt is the coordinator's own prompt for the same fixed work, plus a section
describing the progress already on disk.

The handoff prompt is rebuilt rather than summarized. The coordinator already
owns every fact the first session was given — the fixed issue or ticket, the
branch, the completion-manifest path, the marker contract, the authority profile
— so the second session starts from the same instructions and the same authority
instead of a paraphrase of them. A prompt that only said "this work is already
in progress, review where it stopped" would leave the new session to rediscover
the branch, the manifest, and the contract, and to plausibly re-implement what
already landed.

The progress section is assembled from what can be verified: the checkpoint
phase, the branch, the last commit, the uncommitted worktree state, and the
completion manifest when one exists. It is not assembled from the outgoing
session's own text. ADR-0020 already refused provider prose as a control plane
for queue outcomes, and the same holds here — a model's account of what it did
may name work that never reached the tree. Asking the outgoing session to write
its own handoff would produce the richest summary of all and is exactly what an
exhausted account cannot do.

Because the handoff changes which CLI owns the session, it rewrites the CLI
recorded in the checkpoint with the same write that records the new session, so
a later recovery resumes against the binary that actually holds the work.
