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

An ordinary failure — a non-zero exit, a branch with no commits, a dirty tree, or
a session silent past the idle timeout on every rung — does not release the unit. On GitHub the claim stays,
and `evaluateEligibility` already rejects assigned issues; on Azure the state
stays `En progreso`. The unit leaves the frontier through the predicate that was
already there, so a failure needs no new state and cannot be selected again in a
loop that re-asks. A person unassigns the issue, or reverts the state, to retry
it. The branch and any commits survive for inspection.

Failing the whole run instead was rejected: one badly written issue in the middle
of a queue would stop the ten behind it, which defeats an unattended drain. The
run still exits non-zero when it leaves any unit claimed and undelivered — a
night's drain has to be able to say that something behind it is broken.

A unit that failed *after* verification is the exception, and it does stop the
run: it has already pushed, opened a pull request, or merged, so claiming the next
unit would bury the state an operator has to reconcile under a second delivery.
That is why verification happens in the loop, before any remote effect — what has
touched the remote and what has not are different failures.

The only state persisted across a crash is the one bit git cannot supply: that a
unit passed its verification (ADR-0035) before the delivery effects finished. The
GitHub checkpoint is `{ repository, issue, branch, baseBranch, commit, summary }`,
where a non-null `commit` *is* that bit.

The eight phases, the per-effect receipts, the intent written before each effect,
the session identifier and the CLI that owned it are all gone. The receipts were
redundant: every effect already verifies its own state before acting — `pushCommit`
compares the remote branch against the commit, `createOrReusePullRequest` reuses
the canonical pull request, `mergePullRequest` returns the merge of an
already-merged pull request, `closeIssue` returns on an already-closed issue,
`cleanupBranch` checks both refs before deleting them. A receipt only saved the
call that answers that, at the price of a state machine that could drift from the
remote.

The session identifier and its CLI go because nothing resumes a GitHub session any
more (ADR-0039) — not the fallback chain, and not a later invocation recovering a
checkpoint. That retires the *session-owning CLI*: a run interrupted before its
unit verified abandons that session's work in progress, leaving the issue claimed
and its branch in place, which is what an unverified unit leaves anyway. A
checkpoint written under an older schema is discarded rather than migrated, since
translating it would mean inventing the one answer that matters.
