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
deliver eligible tickets sequentially; a fresh run prepares the HU branch before
selecting a ticket, from `--base-branch` or from `master`/`main` when it is absent. Use `hu-info --hu <ID>` to inspect HU data,
and `hu-branch-set --hu <ID> --branch <name> [--base-branch <name>] --working-directory <path>` to
assign or create an HU branch from an explicit remote base. Read-only and branch-assignment
commands do not start OpenCode. Missing or unsupported subcommands print help
without calling Azure or OpenCode.

The detailed setup, commands, and login-continuation behavior are documented
in `README.md`.

Azure delivery keeps OpenCode semantic: it implements, validates, reviews,
commits, and leaves the session's summary as the ticket's completion-evidence.
The coordinator owns branches, pull requests, Azure fields, effort, completion
gates, recovery, and cleanup. `IMPLEMENTATION_READY` is the only Azure
model-completion marker.

Planning is semantic in the same way, and in both trackers: the session decides
how to slice the work and returns the slices behind `PLAN_READY`, and the
coordinator creates and links the items — Azure work items, or GitHub issues
already carrying the `ready-for-agent` label.

Planning answers its own clarifying questions by default. With
`--interview <off|http|terminal|file>` it stops instead, states the decisions it
cannot settle alone, and the coordinator carries them to the operator and
resumes that same session with the answers. An expired round takes the answers
the session recommended, so an unattended run behaves exactly as it always did.

Any command may end by powering the machine down: `--off '<sudo password>'`
(also `-off`) shuts down when the run finishes, whatever its outcome, except
when it died on an argument error. `--off-delay` sets the cancellable grace
period, and `LAZY_WORKFLOW_OFF_PASSWORD` supplies the password without leaving
it in `ps` or the shell history.

Each run also carries an agent authority profile whose permission deny rules
OpenCode enforces, so the boundary does not rest on prompt prose.
