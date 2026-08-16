---
status: accepted
---

# Run every deterministic tool as a standalone command

Every operation a workflow performs against Azure Boards, GitHub or git without
opening a session is reachable as its own `lazy-workflow` command. Reading the
managed queue, claiming an issue, preparing its branch, publishing its commit,
creating or merging its pull request, closing it, deleting a branch, ensuring an
HU integration branch, transitioning an HU, creating the pull request of a
ticket: each one is now a command that takes its arguments as flags, prints what
its adapter answered as JSON, and exits zero or one.

The Azure `ticket-*` commands already worked this way, and the reason
generalizes. ADR-0020 and ADR-0022 moved every mechanical tracker mutation out of
the coding agent and into the coordinator, precisely because those effects are
deterministic and verifiable. An effect worth taking away from the model is one
worth being able to run, inspect and retry on its own: when a delivery stops
half-way, the operator's question is which step failed and what it answers now,
and that question was previously only answerable by rerunning a whole workflow.

The commands share the workflow's adapters rather than reimplementing them, so a
tool command and the workflow step it mirrors validate identically — the same
branch checks, the same pull-request requirements, the same fail-closed
conflicts. A tool that answered differently from the step it stands for would be
worse than no tool at all.

They open no session. `--cli`, `--model`, `--variant` and `--fallback` are
meaningless to them, and the run header says so by omitting the agent it would
otherwise name. Their adapters are constructed only when one of these commands
runs, so a workflow run pays nothing for them.

A branch may be given short (`issue/201`) or as a full ref
(`refs/heads/issue/201`); the short form is completed, never rejected. A pinned
commit must be the full object name, because every tool that takes one compares
it against a ref, and an abbreviation would fail that comparison as if the
branch had moved.
