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
| `ISSUE_RUNNER_RETRY_DELAYS` | `15,30,60` | Comma-separated list of seconds to wait between retry attempts of a transiently failed worker; one retry per delay entry. Set to empty to disable retries entirely. |
| `ISSUE_RUNNER_RETRY_LIMIT` | _unset_ | Override the total number of worker attempts allowed per issue, including the initial attempt. Defaults to `count(delays) + 1`. |
| `ISSUE_RUNNER_TRANSIENT_PATTERNS` | _unset_ | Newline-separated list of POSIX extended regexes matched (case-insensitively) against the worker output to classify a non-zero exit as a transient transport failure. When unset, a conservative default allowlist of `connection closed / reset / refused / aborted`, `read|write timeout`, `timed out`, `ECONNRESET / ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EAI_AGAIN`, `broken pipe`, `unexpected EOF`, `TLS handshake`, `stream closed / hangup / reset`, `network error / unreachable / down`, `server disconnect / hangup / reset`, and `socket hangup` is used. |
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

## Transient retry

The supervisor wraps every worker invocation in a bounded retry loop.
Only worker exits whose output matches an approved transport failure
signature are retried. Anything else — `BLOCKED`, `FAILED`, malformed
status markers, and non-transient process exits — stops the loop
immediately.

Before every retry the supervisor:

1. Reads the persisted checkpoint and the live Git branch so the
   identity context is consistent.
2. Reconciles the local branch, the live PR list, and the live issue
   state. A checkpoint that already reached `pr_merged` or
   `issue_closed` (or an already-merged PR with a closed issue) is
   treated as completed; the supervisor injects a synthetic
   `ISSUE_COMPLETED` status and advances the loop without launching
   another worker.
3. Resumes the captured Claude session when the checkpoint carries one
   and the worktree still matches the recorded branch and base SHA.
   Otherwise the supervisor launches a fresh recovery worker
   constrained to the same issue, with `--no-session-persistence`.
4. Writes `state=recovering`, `recovery_attempt`, `recovery_delay`, and
   `recovery_category` into the lock status snapshot so operators can
   observe the in-flight retry without reading the checkpoint file.

After the configured retry budget is exhausted, the supervisor writes
`state=recovery_required` into the lock status, retains the checkpoint
and the per-iteration output artifact, appends
`CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=RECOVERY_REQUIRED` to the artifact,
prints a diagnostic on stderr pointing to the retained artifact, and
exits with code `4`. It never advances to another issue — the next
runner startup is responsible for picking the work back up.

## Restart recovery and legacy adoption

On startup, a dirty worktree is no longer treated as a generic failure when
there is enough recovery identity to continue safely. The supervisor first
checks the Git common directory for `claude-minimax-issue-runner.checkpoint`.
When the checkpoint is valid and matches the current worktree, the runner
prints the exact issue number, branch, base SHA, last checkpoint state, dirty
files, and recovery strategy. It then reconciles the issue and PR state with
GitHub before any worker is launched.

Recovery only proceeds after explicit TTY confirmation. A declined prompt,
missing TTY, stale base SHA, branch mismatch, missing issue number, ambiguous
PR state, or unavailable tracker state exits with code `4`
(`RECOVERY_REQUIRED`) and leaves the checkpoint and worktree untouched.

If the checkpoint contains a usable Claude session id and the branch/base SHA
still match, the first recovery worker is invoked with `--resume <session_id>`.
Otherwise the runner starts a fresh worker with `--no-session-persistence` and
a prompt constrained to the checkpointed issue. In both cases the worker is
instructed to inspect and complete the existing partial work, never select a
new issue, and never discard, reset, stash, or overwrite dirty files.

For older interrupted work created before checkpoint support existed, use
legacy adoption:

```bash
ISSUE_RUNNER_ADOPT_ISSUE=123 claude-minimax-issue-runner /path/to/repo
```

The issue number is mandatory. The runner never infers it from the branch,
filenames, dirty paths, or queue ordering. Before adoption it displays the
dirty files and proposed recovery identity, reconciles issue/dependency/PR
state, and requires TTY confirmation. Only after confirmation does it create a
synthetic checkpoint with `session_id=unavailable` and launch a fresh recovery
worker constrained to that supplied issue.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Eligible issue queue is empty |
| `1` | Worker or runner failure |
| `2` | Pending work requires human input |
| `3` | Configured iteration limit reached |
| `4` | `RECOVERY_REQUIRED` — transient retries exhausted; checkpoint and output retained for a human operator or the next restart to inspect |

## Safety

This runner intentionally permits workers to commit, push, create and merge
PRs, and close issues. It refuses to start from unexplained dirty work: dirty
state must either match a valid checkpoint or be explicitly adopted with
`ISSUE_RUNNER_ADOPT_ISSUE`. It also checks the worktree before every normal new
worker and refuses a second runner for the same repository. The default
`bypassPermissions` mode is required because non-interactive `--print` workers
cannot answer permission prompts; the runner's TTY confirmations are the
authorization boundary. Any missing or unknown worker status stops the loop.
Transient transport failures are the only category of failure that triggers an
automatic retry, and that retry always respects the configured delay schedule
and retry limit.
