---
name: lazy-workflow
description: Run GitHub workflows by default or plan, deliver, and query an Azure DevOps HU.
---

# Lazy Workflow

Use the Bun entrypoint in this directory. Without `--hu`, `plan` runs the
default GitHub-only prompt once, while `code` selects and delivers exactly one
eligible GitHub issue per fresh OpenCode session. The coordinator emits the
completion markers only after verified delivery; the next session refreshes the
queue. Neither uses Azure tools.
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
commits, and writes the completion manifest. The coordinator owns branches,
pull requests, Azure fields, evidence, effort, completion gates, recovery, and
cleanup. `IMPLEMENTATION_READY` is the only Azure model-completion marker.
