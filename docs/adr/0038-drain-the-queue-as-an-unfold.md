---
status: accepted
---

# Drain the queue as an unfold

A `code` run does not iterate a list of issues. It asks the tracker for the
first eligible unit, delivers it, and asks again, until the answer is that there
is none. The loop is tail recursion over an immutable run state; each unit is
delivered by one composition of deterministic effects — claim, refresh base,
create branch, run the session, verify with git, push, pull request, merge,
close, delete branch.

A snapshot taken once cannot express the queue's own rule. Eligibility requires
that no blocking dependency is open, so merging issue #42 is what makes #47
eligible; a list captured before the run began never contains it, and the drain
would stop with unblocked work untouched. Re-asking each turn is also what the
Azure and GitHub adapters already did — the change is that the coordinator now
calls them in a loop rather than once.

An ordinary failure — a non-zero exit, a branch with no commits, a dirty tree, a
merge conflict, a `BLOCKED` pull request, or a session silent past the idle
timeout on every rung — does not release the unit. On GitHub the claim stays,
and `evaluateEligibility` already rejects assigned issues; on Azure the state
stays `En progreso`. The unit leaves the frontier through the predicate that was
already there, so a failure needs no new state and cannot be selected again in a
loop that re-asks. A person unassigns the issue, or reverts the state, to retry
it. The branch and any commits survive for inspection.

Failing the whole run instead was rejected: one badly written issue in the middle
of a queue would stop the ten behind it, which defeats an unattended drain.

The only state persisted across a crash is the one bit git cannot supply: that a
unit passed its verification (ADR-0035) before the delivery effects finished. The
checkpoint is `{ unit, branch, verified, activeMs }`. Phases, receipts, intents,
the session identifier and the session-owning CLI are all removed — the first
three are derivable from GitHub and git, and the last two are meaningless now
that no session is ever resumed (ADR-0039).
