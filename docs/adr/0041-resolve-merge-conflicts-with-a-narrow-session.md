---
status: accepted
---

# Resolve merge conflicts with a narrow session

When `gh` reports `mergeStateStatus: DIRTY`, the coordinator merges the base
into the unit's branch itself, leaving the worktree in its conflicted state, and
opens a session with a single instruction: resolve the conflicts, keeping this
branch's changes without discarding the base's, touch no unconflicted file, ask
nothing, commit and push. The result passes the same git verification as any
delivery (ADR-0035) and the merge is retried once. A second conflict is an
ordinary failure.

This keeps a session inside a loop that is otherwise deterministic, so it is
worth saying why. Everything the previous reconciliation subsystem carried — its
own prompt spec, its own checkpoint phase, its `preparePullRequestReconciliation`
and `verifyPullRequestReconciliation` primitives, and its instructions about not
rebasing, resetting or force-pushing — is removed; what remains is three lines
of prompt and a retry. The detection was never the expensive part and was
already deterministic.

A purely deterministic retry was rejected: GitHub reports `DIRTY` precisely when
git has already failed to auto-merge, so merging the base locally hits the same
conflicts.

The instruction says *without discarding the base's changes* for a reason. A
conflict can only arise when someone else landed work on the base while the
session ran, so "keep ours" would silently delete exactly the change that caused
the conflict.

`BLOCKED` is not treated this way. It means branch protection requires a review,
no retry can satisfy it, and the run reports at start-up when it can read that
the base requires one — an automatic merge assumes a base that does not.
