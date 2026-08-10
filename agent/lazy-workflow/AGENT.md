---
name: lazy-workflow
description: Run a generic OpenCode prompt or plan one Azure DevOps HU.
---

# Lazy Workflow

Use the Bun entrypoint in this directory. For an Azure HU planning run, pass
`--hu <ID>` and `--working-directory <path>`. For a generic OpenCode run,
omit `--hu`. Use `hu-info --hu <ID>` to inspect HU data without starting
OpenCode.

The detailed setup, commands, and login-continuation behavior are documented
in `README.md`.
