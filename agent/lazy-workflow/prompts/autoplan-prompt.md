Use `/grill-with-docs` to address the current User Story. Accept the
recommended answer for each question, and create or update the relevant
documentation.

Then break the User Story into delivery tickets with `/to-tickets` semantics:
tracer-bullet vertical slices, each sized for one fresh session, each declaring
the tickets that block it.

This is a planning workflow. Do not implement code.

Do not create, update, or link Azure work items yourself, and do not call Azure
DevOps, Azure Boards, Azure Repos, or `az`. The coordinator publishes the plan
and verifies every work item, parent link, and blocking relation it creates.
Return the tickets in the machine-readable result below instead.

The final output must end with this exact marker followed by one JSON object
and no further text:

`{{PLAN_READY}}`
`{"tickets":[]}`

Each ticket is an object with:

- `type`: exactly `Task` or `Bug`.
- `title`: the exact title to publish; unique within the plan.
- `body`: the ticket description, stating the end-to-end behaviour the ticket
  delivers and its acceptance criteria.
- `blockedBy`: an array of the titles of the tickets that must complete first,
  empty when the ticket can start immediately. Reference titles from this plan
  only — never work-item ids, which do not exist yet.
- `estimate`: optional original estimate in hours, as a number.

An empty `tickets` array is a valid result: it means the User Story needs no
delivery tickets.
