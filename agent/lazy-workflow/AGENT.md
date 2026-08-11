---
name: lazy-workflow
description: Plan, deliver, or query one Azure DevOps HU.
---

# Lazy Workflow

Use the Bun entrypoint in this directory. For an Azure HU planning run, use
`plan --hu <ID>` and `--working-directory <path>`. Use `code --hu <ID> [--base-branch <name>]` to
deliver eligible tickets sequentially; a fresh run preflights the HU branch before
selecting a ticket. Use `hu-info --hu <ID>` to inspect HU data,
and `hu-branch-set --hu <ID> --branch <name> [--base-branch <name>] --working-directory <path>` to
assign or create an HU branch from an explicit remote base. Read-only and branch-assignment
commands do not start OpenCode. Missing or unsupported subcommands print help
without calling Azure or OpenCode.

The detailed setup, commands, and login-continuation behavior are documented
in `README.md`.
