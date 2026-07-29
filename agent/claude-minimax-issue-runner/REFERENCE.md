# Claude-MiniMax Issue Runner Reference

## Execution model

The runner starts one `claude-minimax` process per iteration with:

```text
--print --no-session-persistence --permission-mode auto
```

The `claude-minimax` process exits after one issue. Only an explicit
`ISSUE_COMPLETED` status starts another process. This replaces the old
host-specific `/clear` loop.

`claude-minimax` may be either an executable or a Bash function. For a function,
the runner starts a clean, non-interactive Bash process and sources `~/.bashrc`
(or `CLAUDE_MINIMAX_RC_FILE`). Dynamic Flyline loading is skipped in this child
shell so prompt initialization cannot interfere with the non-interactive
worker. This matches a common setup where the function injects the MiniMax
Anthropic-compatible endpoint and selected model.

## Configuration

| Environment variable | Default | Effect |
|---|---|---|
| `ISSUE_RUNNER_BASE_BRANCH` | `main` | PR target and integration branch |
| `ISSUE_RUNNER_MAX_ITERATIONS` | `0` | Maximum completed issues; `0` means no limit |
| `ISSUE_RUNNER_PROGRESS_INTERVAL` | `30` | Seconds between progress heartbeats; `0` disables them |
| `ISSUE_RUNNER_ASSUME_YES` | `false` | Skip the initial destructive-action confirmation |
| `CLAUDE_MINIMAX_COMMAND` | `claude-minimax` | Executable or Bash function used for each worker |
| `CLAUDE_MINIMAX_SHELL` | `bash` | Bash executable used to resolve a shell function |
| `CLAUDE_MINIMAX_RC_FILE` | `~/.bashrc` | Initialization file containing the shell function |
| `CLAUDE_MINIMAX_PERMISSION_MODE` | `auto` | Claude Code permission mode |

The runner accepts an optional repository path:

```bash
claude-minimax-issue-runner /path/to/repository
```

## Progress and repository lock

Worker output is streamed as it arrives. While a worker is otherwise silent,
the supervisor prints a heartbeat with its iteration and elapsed time every
`ISSUE_RUNNER_PROGRESS_INTERVAL` seconds.

The runner also creates this lock in the repository's Git common directory:

```text
claude-minimax-issue-runner.lock/
├── owner
└── status
```

For a normal repository, inspect progress from another terminal with:

```bash
cat "$(git rev-parse --git-common-dir)/claude-minimax-issue-runner.lock/status"
```

The status snapshot includes the runner PID, state, iteration, elapsed seconds,
and last update time. The Git common directory makes one lock cover the main
checkout and all linked worktrees. A concurrent runner exits with the owner and
latest status. A lock whose owner process no longer exists is recovered
automatically.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Eligible issue queue is empty |
| `1` | Worker or runner failure |
| `2` | Pending work requires human input |
| `3` | Configured iteration limit reached |

## Safety

This runner intentionally permits workers to commit, push, create and merge
PRs, and close issues. It refuses to start from a dirty worktree and checks the
worktree again before every new worker. It also refuses a second runner for the
same repository. Any missing or unknown worker status stops the loop.
