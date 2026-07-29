---
name: claude-minimax-issue-runner
description: >
  Supervises a destructive Claude-MiniMax backlog loop. It launches a fresh
  claude-minimax CLI process for exactly one non-epic issue, waits for that
  process to implement, review, open and merge a PR, and close the issue, then
  repeats with a new process until the eligible queue is empty. Use only when
  the user explicitly asks to drain issues autonomously.
tools: Bash
model: inherit
---

# Claude-MiniMax Issue Runner

This agent is a supervisor. It does not implement issues in its own context.
The bundled `run.sh` process launches one fresh, non-persistent
`claude-minimax` session per issue.

## Before launch

Verify all of the following:

1. The user explicitly authorized automatic PR creation, merge, push, and issue
   closure for the repository.
2. The worktree is clean.
3. `ISSUE_RUNNER_BASE_BRANCH` names the intended base branch (default: `main`).
4. The `claude-minimax` command is available either as an executable or as a
   shell function in `CLAUDE_MINIMAX_RC_FILE` (default: `~/.bashrc`).

If any point is uncertain, stop and ask the user.

## Launch

When installed globally:

```bash
claude-minimax-issue-runner
```

When installed locally for Claude Code:

```bash
./.claude/bin/claude-minimax-issue-runner
```

If this custom agent is launching the runner after receiving explicit
authorization in the current conversation, use:

```bash
ISSUE_RUNNER_ASSUME_YES=true claude-minimax-issue-runner
```

Wait for the runner to exit and report its final status. Do not implement an
issue yourself and do not start a second runner.

The default `bypassPermissions` mode is intentional: `--print` workers cannot
answer interactive permission prompts. The runner's initial TTY confirmation is
the authorization boundary for autonomous writes, tests, pushes, merges, and
issue closure.

The runner streams worker output and prints periodic elapsed-time heartbeats.
Its repository lock also exposes a `status` snapshot in the Git common
directory; see [REFERENCE.md](REFERENCE.md) for the inspection command.

## Guarantees

- Each worker session handles at most one available, non-epic issue.
- Every worker is a new `claude-minimax --print --no-session-persistence`
  process.
- Only one runner may operate on a repository, including its linked worktrees.
- The worker must use `/implement`, `/tdd`, and `/code-review`.
- Success means the PR reached the base branch and the issue was closed.
- A missing status marker, dirty worktree, blocked queue, or failed worker stops
  the loop instead of retrying indefinitely.

See [PROMPT.md](PROMPT.md) for the worker contract and [REFERENCE.md](REFERENCE.md)
for configuration and exit codes.
