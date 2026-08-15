---
status: accepted
---

# Publish Azure planning tickets outside OpenCode

An Azure HU planning run returns its plan and the coordinator publishes it.
OpenCode decides how to slice the User Story into tracer-bullet tickets and what
each one delivers — that is judgment — then emits a `PLAN_READY` marker followed
by one JSON object describing the tickets, their bodies, their optional
estimates, and the titles that block them. It creates, updates, and links no
Azure work items, and calls no Azure CLI.

This extends ADR-0020 from delivery to planning. Delivery already forbade
OpenCode every Azure call while planning still instructed it to create the HU's
children through prose recipes, which left the one remaining place where a
model performed mechanical tracker mutation. Creating a work item, attaching it
to its parent, and recording a blocking relation are deterministic effects with
verifiable outcomes, so they belong to the coordinator under the same contract
as the rest of the `ticket-*` commands: validate the relationship, perform only
the missing effect, reread Azure, and fail closed on conflict.

`ticket-create` is idempotent by HU, work-item type, and exact title, so
republishing a plan reuses the existing work items rather than duplicating them;
two children sharing that identity are a conflict, not a choice. Field reference
names are never inferred from display labels (ADR-0006), so anything beyond the
system fields must be named explicitly.

The coordinator validates the whole plan before creating anything: duplicate
titles, unknown blockers, self-blocking tickets, and blocking cycles are
rejected up front, so a malformed plan produces no partial work. Publication
then runs in dependency order, every blocker before what it unlocks, which is
what lets the second pass name real work-item ids when it records the blocking
relations. An empty ticket list is a valid plan and publishes nothing.

This mirrors the shape `architecture-review-sag` already used, where findings
are returned for the coordinator to publish and verify in the source tracker.
