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

## Recovery checkpoint

The runner persists a durable checkpoint for every worker attempt next to the
repository lock, so a future restart can recover the selected issue and the
last safe state without relying on the failed process's memory:

```text
claude-minimax-issue-runner.checkpoint
```

Inspect the checkpoint from another terminal with:

```bash
cat "$(git rev-parse --git-common-dir)/claude-minimax-issue-runner.checkpoint"
```

The file uses the same Git common directory as the lock, so it covers the main
checkout and all linked worktrees.

### Fields

| Field | Meaning |
|---|---|
| `pid` | Runner PID that wrote the checkpoint |
| `iteration` | Worker attempt number (starts at 1) |
| `issue` | Identified issue number, or `unknown` until the worker inspects it |
| `branch` | Current branch the worker is on |
| `base_branch` | Configured base branch for PRs |
| `base_sha` | SHA of the base branch when the checkpoint was written |
| `session_id` | Captured Claude session identity, or `unavailable` |
| `state` | Lifecycle state of the attempt (see below) |
| `updated_at` | Timestamp of the last checkpoint write |

### Lifecycle states

The checkpoint state advances as the worker emits recognizable events. The
runner records the issue identity as soon as the assistant calls
`gh issue view N`, before any edit, push, PR creation, or merge:

| State | Reached when |
|---|---|
| `starting` | The attempt has been recorded but the worker has not yet identified its issue |
| `issue_selected` | The worker inspected `gh issue view N` and the issue number was captured |
| `mutating` | The worker edited, committed, or ran tests |
| `branch_pushed` | The worker pushed the feature branch |
| `pr_created` | The worker created the pull request |
| `pr_merged` | The worker merged or closed the pull request |
| `issue_closed` | The worker closed the issue |
| `blocked` | The worker reported `BLOCKED` |
| `failed` | The worker reported `FAILED` or exited with a non-zero status |
| `malformed` | The worker exited cleanly but emitted no recognized status marker |

### Privacy boundary

The checkpoint never persists prompts, credentials, bearer tokens, full shell
commands, or any complete tool inputs. It only records the identity
information needed to resume or report on the attempt. Sensitive fields in the
stream renderer continue to be redacted before reaching operator output, and
the side-channel issue file (`${OUTPUT_FILE}.issue`) carries only the bare
issue number back to the supervisor.

The same non-sensitive identity fields (`issue`, `branch`, `base_branch`,
`state`) are mirrored into the lock `status` file so operators can inspect
progress without reading the checkpoint directly.

### Retention

- `ISSUE_COMPLETED` removes the checkpoint.
- `QUEUE_EMPTY` removes the checkpoint (verified empty queue).
- `BLOCKED`, `FAILED`, non-zero worker exits, and unknown statuses retain the
  checkpoint with the last safe state so the next restart can decide
  whether recovery is safe.

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
