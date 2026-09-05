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
  only — never tracker ids, which do not exist yet.
- `estimate`: optional original estimate in hours, as a number.

An empty `tickets` array is a valid result: it means the work needs no delivery
tickets.
