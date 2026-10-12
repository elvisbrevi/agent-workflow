---
status: accepted
---

# Move the HU when its last ticket is delivered, in one repository too

Only the multi-repository delivery moved an HU once no delivery child of it was
left open — a story to `Desarrollo Terminado`, a Bug HU to `En revisión`
(ADR-0047). A single-repository `code --hu` closed every ticket and left the HU
where it was, so the same HU ended differently depending on how many
repositories delivered it. The operator wants both to end the same way, which
amends the last sentence of ADR-0047's Bug section.

Single-repository delivery now runs the same step at the same point: after a
ticket reaches `Done` and before its branch is cleaned up, the coordinator reads
the HU, and if no direct delivery child is open it moves the HU to its
developed state with the state and revision it read as guards, then reads it
back. One method serves both shapes, so they cannot drift apart again.

The recovery of an interrupted delivery runs it too, outside the completion
receipt: a run stopped between the ticket's `Done` and the HU's move still makes
the move on the next invocation. The step is idempotent — an HU already in its
developed state is left alone — so running it again costs one read.

It never undoes a delivered ticket. An HU that cannot be read, moved or verified
is reported as an HU transition failure and the run carries on to clean up and
select the next ticket, as the workspace delivery already did. Only a delivery
moves an HU: a drain that finds no ticket at all does not, because an HU that
was never planned also has no open delivery child.
