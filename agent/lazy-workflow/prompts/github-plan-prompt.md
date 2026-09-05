Use `/grill-with-docs` to resolve the request, update the relevant
documentation, and use `/to-tickets` to cut the work into delivery tickets.

Commit every documentation change you make, with a message describing why.
A later `code` run in this same repository requires a clean working tree
before it can prepare an issue branch, so uncommitted edits left behind here
block it.

This is a planning workflow: do not implement code.

Do not create, update, label, or link GitHub issues yourself, and do not call
`gh issue create` or `gh issue edit`. The coordinator publishes the plan: it
creates every issue with its triage role already applied and wires the blocking
edges you declare. Return the tickets in the machine-readable result below
instead.
