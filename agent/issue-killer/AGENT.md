---
name: issue-killer
description: >
  Supervises a destructive autonomous backlog loop. It launches a fresh
  agent CLI process for exactly one non-epic issue, waits for that
  process to implement, review, open and merge a PR, and close the issue, then
  repeats with a new process until the eligible queue is empty. Use only when
  the user explicitly asks to drain issues autonomously.
tools: Bash
model: inherit
---

# Issue Killer

This agent is a supervisor. It does not implement issues in its own context.
The bundled `bin/issue-killer.ts` entrypoint launches one fresh OpenCode
worker session per issue, configured through an execution profile. A later
restart can resume the captured opaque OpenCode session id when its pinned
issue, branch, base branch, and base SHA still match; otherwise the runtime
starts a fresh session constrained to the checkpointed identity when that
session cannot be confirmed. Session reuse is controlled by recovery state,
not by an unsupported profile field.

## Before launch

Verify all of the following:

1. The user explicitly authorized automatic PR creation, merge, push, and issue
   closure for the repository.
2. The worktree is clean.
3. `ISSUE_RUNNER_BASE_BRANCH` names the intended base branch (default: `main`).
4. The selected profile's command is available either as an executable or as a
   shell function in the configured `init_file`.
5. For an Azure DevOps repository, the `az` CLI is installed, the
   `azure-devops` extension is enabled, the operator identity is authenticated,
   and the repository-owned tracker contract in `docs/agents/issue-tracker.md`
   declares the full Azure DevOps configuration block. The orchestrator refuses
   to start a worker when the contract is missing, malformed, or inconsistent
   with the Git remote.
6. For an Azure DevOps repository, the evidence modality expected by the active
   Feature or bug is available to the worker. Backend tickets need Chrome MCP
   HTTP capture, frontend tickets need rendered-screen capture, mixed tickets
   need both, and tickets without an executable interface produce reproducible
   command or test output. When Chrome, the target application, the environment,
   or the operator authentication is unavailable, the worker reports `BLOCKED`
   rather than substituting textual evidence.

If any point is uncertain, stop and ask the user.

## Checkpoint and Status

The runner persists a durable checkpoint and a lock status snapshot under the
Git common directory so linked worktrees share the same recovery state. The
checkpoint identities always carry the active `issue`, `hu`, and `ticket`
(Azure only) numbers, the branch, the base branch and base SHA, the captured
session identifier (when available), the active profile, the CLI, the model,
and the lifecycle state. The lock status mirrors the same non-sensitive
identity information so operators can inspect progress without reading the
checkpoint directly.

The orchestrator reads the checkpoint before every retry, reconciles the
local branch, the live PR list, and the live issue state, and decides
between resuming the captured OpenCode session (when its pinned issue,
branch, base branch, and base SHA still match) and launching a fresh worker
constrained to the same issue. A missing status marker or partial PR /
issue result stops the loop with `RECOVERY_REQUIRED`; the runner never
advances to another issue silently.

## Recovery

The runner recovers from transient worker failures inside the configured
retry budget. A non-transient failure, a missing status marker, an
ambiguous PR or issue state, a dirty worktree, an exhausted provider
fallback chain, or a malformed configuration stops the loop with one of
`ISSUE_KILLER_STATUS=BLOCKED`, `ISSUE_KILLER_STATUS=FAILED`, or
`ISSUE_KILLER_STATUS=RECOVERY_REQUIRED`. The checkpoint is retained so
the next restart can choose the safe outcome.

## Launch

When installed globally:

```bash
issue-killer
```

When installed locally for Claude Code:

```bash
./.claude/bin/issue-killer
```

If this custom agent is launching the runner after receiving explicit
authorization in the current conversation, use:

```bash
ISSUE_RUNNER_ASSUME_YES=true issue-killer
```

Wait for the runner to exit and report its final status. Do not implement an
issue yourself and do not start a second runner.

The runner always honors the configured `default_profile` when launched
without a TTY. Interactive runs choose the profile and build an ordered
OpenCode-only fallback chain through the operator-facing selector; only
the declared order is consumed. Each entry is a complete execution profile
(CLI, model, command, options); the runner never substitutes another
CLI, model, or command. The destructive confirmation step is the only
authorization boundary for autonomous writes, tests, pushes, merges,
and issue closure.

The runner streams worker output and prints periodic elapsed-time heartbeats.
Its repository lock also exposes a `status` snapshot in the Git common
directory; see [REFERENCE.md](REFERENCE.md) for the inspection command.

## Guarantees

- Each worker session handles at most one available, non-epic issue.
- Every worker is a new agent CLI process driven by an execution profile from
  `~/.config/issue-killer/config.toml` (or `--config <path>`).
- Only one runner may operate on a repository, including its linked worktrees.
- The worker must use `/implement`, `/tdd`, and `/code-review` skills.
- Success means the PR reached the base branch and the issue was closed.
- A missing status marker, dirty worktree, blocked queue, or failed worker stops
  the loop instead of retrying indefinitely.

See [PROMPT.md](PROMPT.md) for the worker contract and [REFERENCE.md](REFERENCE.md)
for configuration, the legacy migration boundary, and exit codes.
