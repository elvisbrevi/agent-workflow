# Claude-MiniMax Issue Runner Reference

## Execution model

The runner starts one `claude-minimax` process per iteration with:

```text
--print --no-session-persistence --permission-mode bypassPermissions
```

The `claude-minimax` process exits after one issue. Only an explicit
`ISSUE_COMPLETED` status starts another process. This replaces the old
host-specific `/clear` loop.

`claude-minimax` may be either an executable or an interactive Bash function.
The latter matches a common setup where `~/.bashrc` injects the MiniMax
Anthropic-compatible endpoint and selected model behind the customized command.

## Configuration

| Environment variable | Default | Effect |
|---|---|---|
| `ISSUE_RUNNER_BASE_BRANCH` | `main` | PR target and integration branch |
| `ISSUE_RUNNER_MAX_ITERATIONS` | `0` | Maximum completed issues; `0` means no limit |
| `ISSUE_RUNNER_ASSUME_YES` | `false` | Skip the initial destructive-action confirmation |
| `CLAUDE_MINIMAX_COMMAND` | `claude-minimax` | Executable or Bash function used for each worker |
| `CLAUDE_MINIMAX_SHELL` | `bash` | Interactive shell used to resolve a shell function |
| `CLAUDE_MINIMAX_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode |

The runner accepts an optional repository path:

```bash
claude-minimax-issue-runner /path/to/repository
```

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
worktree again before every new worker. Any missing or unknown worker status
stops the loop.
