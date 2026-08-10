---
name: lazy-workflow
description: Plan one Azure DevOps HU or query HU information.
---

# Lazy Workflow

Use the Bun entrypoint in this directory. For an Azure HU planning run, use
`plan --hu <ID>` and `--working-directory <path>`. Use `hu-info --hu <ID>` to
inspect HU data without starting OpenCode. Missing or unsupported subcommands
print help without calling Azure or OpenCode.

The detailed setup, commands, and login-continuation behavior are documented
in `README.md`.
