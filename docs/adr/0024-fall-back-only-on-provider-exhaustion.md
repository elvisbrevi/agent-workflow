---
status: accepted
---

# Fall back only on provider exhaustion

A run may declare an ordered fallback chain with a repeatable
`--fallback <cli>:<model>:<variant>`, and descends it when the active rung stops
producing. There are two such causes: provider exhaustion — usage or rate limit,
quota, billing, or authentication — and a session silent past the idle timeout.
These are the failures where retrying the same rung cannot succeed, so continuing
requires a different one. A stuck agent and an exhausted quota mean the same
thing to the loop, and ADR-0039 records why the second cause was added.

A session that merely fails its task never descends. Escalating a failed
implementation to the next rung would spend the reserve on a prompt that is
already wrong and would hide the defect behind a model change, which is the
opposite of what a fallback is for. The chain exists to survive an exhausted
account, not to shop for a model that agrees with a broken run.

No rung is ever resumed. Every descent opens a fresh session with the same
prompt and a verified progress section (ADR-0039), so a descent within one CLI
and a descent across two behave identically.

The chain is declared on the invocation that already declares `--cli`,
`--model`, and `--variant`, rather than in a configuration file. A file would
save repetition, at the price of a second source of truth with its own
precedence rules against the flags; the ordered flag keeps the whole resolution
visible in the command that produced it. Every rung's binary is checked for
presence when arguments are parsed, so a missing CLI is reported before any
work starts instead of at the moment the primary runs out. Authentication is
not checked ahead of time — each CLI reports its own.

A descent is sticky for the unit of work in progress and no further. The next
unit — the next issue in the managed queue, the next ticket — starts again at
the primary rung. Usage limits lapse on their own, so a chain that never climbed
back would strand a run on its reserve for hours after the primary recovered;
the accepted cost is one exhausted attempt per unit while the limit persists.

When every rung is spent for the unit in progress, the reaction depends on which
cause spent it. Exhausted by quota, the run waits and retries at a fixed interval
up to a bounded total, then fails closed with the checkpoint preserved. Exhausted
by silence, the unit fails ordinarily and the drain continues with the next one:
quota returns on its own, but a prompt that hung three CLIs will hang the fourth
attempt too. The retry starts over at the head of the chain rather
than at the primary alone: the rungs are exhausted independently and recover
independently, so the unit continues on whichever one has its quota back first. Waiting is what the failure calls for, because the
resource returns by itself. The bound is what keeps it honest: a failure
misclassified as exhaustion — a stale credential, a revoked key — must surface
as an operator-visible stop rather than an agent that waits forever.
