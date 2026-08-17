---
name: lazy-workflow
description: Run GitHub workflows by default or plan, deliver, and query an Azure DevOps HU.
---

# Lazy Workflow

Use the Bun entrypoint in this directory. Without `--hu`, `plan` runs the
default GitHub-only prompt once, while `code` delivers each eligible GitHub
issue in its own fresh OpenCode session, then re-selects the next eligible issue
in the same run until the queue is empty or blocked. The coordinator emits the
completion markers only after each verified delivery. Neither uses Azure tools.
For an Azure HU planning run, use
`plan --hu <ID>` and `--working-directory <path>`. Use `code --hu <ID> [--base-branch <name>]` to
deliver eligible tickets sequentially; a fresh run preflights the HU branch before
selecting a ticket. Use `hu-info --hu <ID>` to inspect HU data,
and `hu-branch-set --hu <ID> --branch <name> [--base-branch <name>] --working-directory <path>` to
assign or create an HU branch from an explicit remote base. Read-only and branch-assignment
commands do not start OpenCode. Missing or unsupported subcommands print help
without calling Azure or OpenCode.

The detailed setup, commands, and login-continuation behavior are documented
in `README.md`.

Azure delivery keeps OpenCode semantic: it implements, validates, reviews,
commits, and produces the completion manifest with `ticket-manifest-set` rather
than by writing that JSON itself. The coordinator owns branches,
pull requests, Azure fields, evidence, effort, completion gates, recovery, and
cleanup. `IMPLEMENTATION_READY` is the only Azure model-completion marker.

Azure planning is semantic in the same way: OpenCode decides how to slice the
User Story and returns a delivery plan behind `PLAN_READY`, and the coordinator
creates and links the work items.

Planning answers its own clarifying questions by default. With
`--interview <off|http|terminal|file>` it stops instead, states the decisions it
cannot settle alone, and the coordinator carries them to the operator and
resumes that same session with the answers. An expired round takes the answers
the session recommended, so an unattended run behaves exactly as it always did.

Each run also carries an agent authority profile whose permission deny rules
OpenCode enforces, so the boundary does not rest on prompt prose.
