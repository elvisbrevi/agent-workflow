# Claude-MiniMax Issue Runner Reference

## Execution model

The runner starts one `claude-minimax` process per iteration with:

```text
--print --no-session-persistence --permission-mode bypassPermissions
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
| `ISSUE_RUNNER_STREAM_OUTPUT` | `true` | Invoke the worker with `--output-format stream-json` and render semantic progress; set to `false` to keep the legacy text output and `tee` behavior |
| `CLAUDE_MINIMAX_COMMAND` | `claude-minimax` | Executable or Bash function used for each worker |
| `CLAUDE_MINIMAX_SHELL` | `bash` | Bash executable used to resolve a shell function |
| `CLAUDE_MINIMAX_RC_FILE` | `~/.bashrc` | Initialization file containing the shell function |
| `CLAUDE_MINIMAX_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode; override to impose interactive restrictions |

The runner accepts an optional repository path:

```bash
claude-minimax-issue-runner /path/to/repository
```

## Progress and repository lock

The runner invokes each worker with Claude's `stream-json` output format
(`--output-format stream-json`) and parses the resulting event stream in real
time. It renders concise, iteration-aware human-readable progress lines as
the assistant inspects the repository, edits files, runs tests, reviews
changes, or creates, merges, and closes a PR. Assistant tool inputs, prompts,
tokens, bearer credentials, and raw JSON protocol noise are kept out of the
operator terminal — only the redacted summary reaches the operator. The raw
stream is still persisted to the per-iteration output artifact, which is the
same path reported by the `BLOCKED` and `FAILED` diagnostics.

Worker output is streamed as it arrives. The heartbeat with the current
iteration and elapsed time is suppressed while the renderer is still
producing semantic progress events; the supervisor only falls back to a
heartbeat when no stream event has arrived for `ISSUE_RUNNER_PROGRESS_INTERVAL`
seconds.

The renderer maps the following CLI stream events to operator-visible
progress text:

| Stream event | Operator output |
|---|---|
| assistant tool_use `Read` / `Glob` / `Grep` / `WebFetch` / `WebSearch` / `NotebookRead` / `LS` | `Inspecting repository or tracker state` |
| assistant tool_use `Edit` / `Write` / `MultiEdit` / `NotebookEdit` | `Editing <file path>` (or `Editing files` when no path is provided) |
| assistant tool_use `Bash` running tests or verification commands | `Running tests or verification` |
| assistant tool_use `Bash` creating a PR | `Creating pull request` |
| assistant tool_use `Bash` merging or closing a PR | `Merging or closing pull request` |
| assistant tool_use `Bash` closing an issue | `Closing issue` |
| assistant tool_use `Bash` pushing, committing, or rebasing | `Pushing branch` / `Committing changes` / `Merging or rebasing branch` |
| assistant tool_use `Bash` for anything else | `Running shell command` |
| assistant tool_use `TodoWrite` / `Task` | `Planning the next worker step` |
| `result` (assistant final response) | `Worker finished (see <artifact> for full output)` plus the final text written verbatim to the artifact so the status marker stays extractable |

## Requirements

`jq` is required when `ISSUE_RUNNER_STREAM_OUTPUT=true` (the default). The
runner uses it to parse the streaming JSON events into semantic progress
without printing the raw protocol.

Setting `ISSUE_RUNNER_STREAM_OUTPUT=false` restores the legacy behavior:
workers are invoked without `--output-format stream-json`, every line is
forwarded verbatim through a `tee`, and the elapsed-time heartbeat is the
only progress signal operators see. `jq` is not required in that mode.

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
same repository. The default `bypassPermissions` mode is required because
non-interactive `--print` workers cannot answer permission prompts; the runner's
TTY confirmation is the authorization boundary. Any missing or unknown worker
status stops the loop.
