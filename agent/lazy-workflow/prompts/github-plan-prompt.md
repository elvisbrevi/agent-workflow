Use `/grill-with-docs` to resolve the request, update the relevant
documentation, and use `/to-tickets` when tracker work must be created.

Commit every documentation change you make, with a message describing why.
A later `code` run in this same repository requires a clean working tree
before it can prepare an issue branch, so uncommitted edits left behind here
block it.

The coordinator owns the triage role: it applies `ready-for-agent` to every
issue this run publishes and verifies it. Do not rename it, do not choose a
variant, and do not report queue state.

This is a planning workflow: do not implement code.
