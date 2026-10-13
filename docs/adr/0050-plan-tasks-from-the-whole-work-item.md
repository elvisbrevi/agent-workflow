---
status: accepted
---

# Plan Tasks from the whole work item

A plan of Bug #24663 showed two gaps at once. The Bug had a new comment asking
for a second correction; the session could not read it, because a planning
session is denied every `az` call (ADR-0022) and the coordinator handed it only
the Bug's fields. It then returned its one slice as a `Bug`, and publication
hung a new Bug under the Bug it was planning. Nobody had asked for a new work
item: the plan form has no such option.

**The session plans from the whole work item.** `hu-info`, and so every plan,
now carries the work item's discussion — every comment, oldest first, read to
the last page of Azure's comments API — and a Bug's own `Repro Steps` and
`System Info`, where a Bug states what is wrong when its description is empty.
The session still reads no tracker: what it needs travels in the snapshot the
coordinator already gives it, as a GitHub epic plan's comments already did.

**A plan publishes Tasks, and only Tasks.** The type is no longer part of the
plan contract. Whatever the work item is — a User Story, a Product Backlog Item
or a Bug HU — its plan hangs Tasks from it, which is what `code --hu` drains. A
`type` a session still writes is dropped when the plan is read, so an older
prompt or a stubborn model cannot bring the Bug back. ADR-0040 already said the
agent supplies title, description and estimate; the type was the exception, and
it no longer is.

Creating a new Bug or HU stays possible, and stays explicit: `ticket-create
--type Bug` is a deterministic tool an operator runs on purpose. A plan option
for it would be its own decision.

Separately, the window now reads a run's result for a person: the session's
closing text as formatted prose, the published tickets with their ids, type,
estimate and description, and the cost of the session. The JSON documents stay
one click away under **Resultado técnico**.

Rejected: letting the session read Azure during planning, which would widen
the planning authority to answer a question the coordinator can answer with
one read; and validating the type per parent — Tasks under a Bug, Tasks or Bugs
under a story — which keeps a decision in the session's hands that the operator
never delegated.
