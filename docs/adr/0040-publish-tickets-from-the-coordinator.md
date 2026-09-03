---
status: accepted
---

# Publish tickets from the coordinator, in both trackers

A planning session decides how to slice the work and returns the slices —
type, title, body, blocking edges, estimate — behind `PLAN_READY`. The
coordinator creates the items, wires the parent links and the blocking
relations, applies the `ready-for-agent` label on GitHub, and sets every field
it can derive on Azure: the assignee, the month, the remaining work, and the
HU's integration branch. The `/to-tickets` skill keeps the judgment and loses
the publishing.

Azure already worked this way (ADR-0022). GitHub did not: the session published
issues itself with `gh issue create`, and the coordinator then inferred which
ones were its own by reading the highest issue number before the session started
and labelling everything above it. That inference is a race — an issue somebody
opens by hand during a planning run is labelled as the plan's and drained by the
next `code` run — and it existed only because the coordinator was not the one
creating the items. Creating them removes the watermark, `readQueueWatermark`,
`applyReadyForAgentRole`, and the paragraph of prompt that asked the session not
to touch the label. The label now travels in the same call that creates the
issue.

The alternative — letting the session publish in both trackers, for symmetry —
was rejected because it is symmetry in the wrong direction: it would give up
Azure's deterministic publication to match GitHub's inference.

The agent supplies title, description and estimate. Everything else about a
published item is derivable, and therefore not the agent's to state.
