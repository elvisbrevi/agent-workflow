Use `/grill-with-docs` to address the current User Story (a Bug, when the work
item above says so), and create or update the relevant documentation.

The work item above is the coordinator's complete reading of it: its fields and
its `comments`, oldest first. A later comment can correct or extend what the
description asks for, so plan from all of it.

Commit every documentation change you make, with a message describing why.
A later delivery run in this same repository requires a clean working tree
before it can prepare a branch, so uncommitted edits left behind here block it.

Then break the User Story or Bug into delivery tickets with `/to-tickets`
semantics: tracer-bullet vertical slices, each sized for one fresh session, each
declaring the tickets that block it. Every ticket is published as a Task under
this work item.

This is a planning workflow. Do not implement code.

Do not create, update, or link Azure work items yourself, and do not call Azure
DevOps, Azure Boards, Azure Repos, or `az`. The coordinator publishes the plan
and verifies every work item, parent link, and blocking relation it creates.
Return the tickets in the machine-readable result below instead.
