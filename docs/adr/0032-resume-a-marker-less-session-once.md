---
status: accepted
---

# Resume a marker-less session once

A coding session that returns without `IMPLEMENTATION_READY` is resumed once, on
the same rung, before the run fails closed. The resume carries the marker prompt
the recovery path already uses, and wherever the run owns a checkpoint the
session identifier is written to it before the attempt starts, so a run that dies
inside the resume still names the session that holds the work. The
pull-request reconciliation session is the exception, and only because it has no
checkpoint of its own: its caller records the session when the outcome comes
back, exactly as it did before.

This is what the operator was already doing by hand. A session that stopped to
ask a question, or that ended its turn one step short of its manifest, left the
run stopped with a preserved checkpoint whose only pending action was "resume
this session" — and the operator's next invocation did exactly that, with the
same CLI, the same model, and the same prompt. Nothing in that second invocation
required a person: it re-read a checkpoint the run had just written and resumed a
session the run had just closed over. Making the coordinator do it removes an
interruption that carried no decision.

One attempt, not a loop. A second resume that still returns without the marker is
a defect the operator has to see — an unbuildable task, a session refusing the
work, a contract the prompt cannot satisfy — and hiding it behind further retries
spends the reserve on a run that is not going to converge. The failure that
follows is the one that was reported before: same message, same preserved
checkpoint, same reconciliation.

It is not a fallback descent. The rung does not change: the attempt runs on the
CLI, model and variant the session in course already had, which after a descent
is the descended rung and not the one the command declared. ADR-0024 stands
untouched — the chain is still walked only on provider exhaustion — and where a
site wires that chain, the extra attempt is routed through it like any other, so
a rung that exhausts during the attempt descends exactly as it would have on the
first. Two sites wire no chain at all today, the GitHub workspace delivery and
the reconciliation session; there the extra attempt has nothing to descend to,
which is the behaviour those sites already had.

Every coordinated delivery grants the same single resume: the Azure workspace
delivery, the GitHub delivery loop, GitHub recovery with and without a live
session, the GitHub workspace delivery and its own checkpoint recovery, and the
pull-request reconciliation session. A recovery resume is not the attempt this
ADR grants — it is the interrupted session continuing — so a recovery that comes
back without the marker still gets one. A reconciliation that converges on its
resumed attempt now finishes inside the invocation that opened it, so the
pending-reconciliation verification only runs where it belongs: on a run that
really was interrupted between invocations.

The single-repository Azure `code` loop is untouched. It already retries its own
session on a fixed interval rather than failing closed, which is a stronger
policy than this one and predates it; it keeps that behaviour until there is a
reason to make the two agree.
