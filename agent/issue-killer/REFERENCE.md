# Issue Killer Reference

## Execution model

The runner starts one worker process per iteration, driven by the selected
execution profile. For a Claude profile the worker is invoked with:

```text
--print --permission-mode bypassPermissions
```

The worker exits after one issue. Only an explicit `ISSUE_COMPLETED` status
starts another process. This replaces the old host-specific `/clear` loop.

Session persistence is the default for a Claude fresh-worker launch
(ADR #12): omitting `--no-session-persistence` lets Claude write the
session transcript to its configured directory, so a later restart has
a real conversation to resume rather than an identifier that points at
nothing. An operator who needs an ephemeral, non-resumable session can
opt out by setting `disable_session_persistence = true` on the Claude
profile; the runner translates that opt-out into `--no-session-persistence`
on every fresh launch. The resume path always omits the flag, so the two
launch modes stay consistent about persistence.

The profile's `command` field is either an executable or a Bash function. For a
function, the runner starts a clean, non-interactive Bash process and sources
the operator-provided `init_file` (typically `~/.bashrc`). Dynamic Flyline
loading is skipped in this child shell so prompt initialization cannot
interfere with the non-interactive worker. This matches a common setup where
the function injects provider endpoint overrides and a selected model.

## Tracker selection

The supervisor selects the tracker adapter from the repository's Git remote
and validates it against `docs/agents/issue-tracker.md` before launching a
worker. GitHub repositories use `gh`; Azure DevOps repositories use
`az boards` and `az repos` with the `azure-devops` extension. Azure requires
repository-owned organization, project, repository, work-item type, state,
predecessor, ready, claim, and closure mappings.

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
| `ISSUE_RUNNER_UNRESUMABLE_PATTERNS` | _unset_ | Newline-separated list of POSIX extended regexes matched (case-insensitively) against the worker output to classify a non-zero exit after a `--resume` rejection as an unresumable session. Only consulted when the orchestrator actually attempted a resume. When unset, the default allowlist is `no conversation found` and `session id ... not found`, matching the Claude CLI rejection and its sibling-CLI equivalents. |
| `ISSUE_KILLER_CONFIG_PATH` | `~/.config/issue-killer/config.toml` | TOML configuration read on startup. Override with `--config <path>`. |
| `ISSUE_RUNNER_ADOPT_ISSUE` | _unset_ | Adopt a dirty worktree as a specific issue number when no checkpoint exists. Requires explicit TTY confirmation. |

The runner accepts an optional repository path, `--config`, and Azure-only HU
selection:

```bash
issue-killer --config /path/to.toml --hu 123 /path/to/repository
```

`--hu` accepts only a positive numeric Azure delivery HU ID. The Azure tracker
contract must declare `delivery_hu_work_item_types` and
`delivery_ticket_work_item_types` together. An omitted `--hu` discovers the
oldest prepared HU by creation time and ID, then pins the first unblocked direct
child Task or Bug by the same ordering. A selected HU with no pending children
ends safely without launching a worker; a scope whose pending children are all
blocked reports `BLOCKED`. The pinned `hu` and `ticket` identities are included
in checkpoints and lock status, never prompts or credentials.

The full operator-facing workflow — explicit and automatic HU selection,
first-run origin choice, branch naming, ticket sequencing, evidence
requirements, field mappings, Real Effort, recovery, and the prohibition on
HU closure or mainline promotion — is documented in
[`docs/agents/azure-hu-operator-guide.md`](../../docs/agents/azure-hu-operator-guide.md).
That guide is the source of truth for operator decisions; the tracker
adapter contracts and the per-module reference below describe the
implementation that enforces those decisions.

## Supported runtime / tracker matrix

|                | GitHub (`gh`) | Azure DevOps (`az boards` + `az repos`) |
|----------------|---------------|------------------------------------------|
| Claude (`--print` + stream-json) | Supported     | Supported                                 |
| Codex (`exec` + JSONL)           | Supported     | Supported                                 |
| OpenCode (`run` + JSON events)   | Supported with provider fallback chain | Supported with provider fallback chain |

`azure-devops` requires the repository's tracker document to declare the
matching organization, project, repository, work-item types, states, and role
mappings. Missing fields fail closed before the first worker is launched.

## Progress and repository lock

The runner invokes each worker with the configured CLI's stream output format
and parses the resulting event stream in real time. It renders concise,
iteration-aware human-readable progress lines as the worker inspects the
repository, edits files, runs tests, reviews changes, or creates, merges, and
closes a PR. Assistant tool inputs, prompts, tokens, bearer credentials, and
raw JSON protocol noise are kept out of the operator terminal — only the
redacted summary reaches the operator. The raw stream is still persisted to
the per-iteration output artifact, which is the same path reported by the
`BLOCKED` and `FAILED` diagnostics.

Worker output is streamed as it arrives. The heartbeat with the current
iteration and elapsed time is suppressed while the renderer is still
producing semantic progress events; the supervisor only falls back to a
heartbeat when no stream event has arrived for `ISSUE_RUNNER_PROGRESS_INTERVAL`
seconds.

The renderer maps CLI stream events to operator-visible progress text. The
exact mapping is owned by the selected runtime adapter; the canonical
categories include: `Inspecting repository or tracker state`,
`Editing <file path>`, `Running tests or verification`, `Creating pull
request`, `Merging or closing pull request`, `Closing issue`,
`Pushing branch`, `Committing changes`, `Merging or rebasing branch`,
`Running shell command`, `Planning the next worker step`, and
`Worker finished (see <artifact> for full output)`.

### Azure delivery HU lifecycle (issue #41)

The Azure delivery HU flow exposes its own lifecycle through the
tracker-neutral `hu-progress.sh` module. The module owns the canonical
phase set (`hu-selected`, `ticket-selected`, `hu-branch-prepared`,
`ticket-branch-created`, `evidence-captured`, `evidence-recorded`,
`effort-recorded`, `ticket-integrated`, `ticket-done`, `recovery-clause`,
`recovery-resumed`) and emits a single operator-visible progress line
through the same renderer pipeline as the runtime adapter. The Azure
tracker adapter invokes the helper when the HU is selected, the ticket
branch is opened, evidence is captured or recorded, real effort is set,
the PR is integrated into the HU integration branch, and the ticket is
moved to the configured closed state. The orchestrator invokes the helper
when a transport recovery resumes an existing session or launches a
fresh worker. Every emission sanitizes the detail string so
credentials, raw browser JSON, base64 payloads, attachment paths, and
complete commands never reach the operator terminal or the lock status.

The same HU phase taxonomy is observable through the lock status side
channel. While the lock is held, the lock status carries the latest
known `hu_phase`, the `ticket_branch` (when the helper knew it), the
evidence URL (sanitized), and the recorded real effort in hours. The
checkpoint additionally persists a `hu_phase=` line and the same
support fields so a later restart can resume the visible phase without
re-deriving it from the worker artifact.

## Requirements

`jq` is required when `ISSUE_RUNNER_STREAM_OUTPUT=true` (the default). The
runner uses it to parse the streaming JSON events into semantic progress
without printing the raw protocol.

Setting `ISSUE_RUNNER_STREAM_OUTPUT=false` restores the legacy behavior:
workers are invoked without stream output, every line is forwarded verbatim
through a `tee`, and the elapsed-time heartbeat is the only progress signal
operators see. `jq` is not required in that mode.

## Azure prerequisites

An Azure DevOps run requires the following prerequisites on the operator
workstation and on the worker:

- The `az` CLI is installed and the `azure-devops` extension is enabled.
- The operator identity matches the `claim_identity` declared in the
  repository tracker contract. Mismatches fail closed before any worker
  launches.
- The repository remote matches the declared organization, project, and
  repository. The orchestrator refuses to start a worker when the remote
  resolves to a different project.
- For the documented evidence modality, the Chrome MCP server is available
  to the worker. Backend tickets produce Chrome HTTP capture, frontend
  tickets produce rendered-screen capture, mixed tickets produce both,
  and tickets without an executable interface produce reproducible
  command or test output. When Chrome, the target application, the
  environment, or operator authentication is unavailable, the worker
  reports `BLOCKED` instead of substituting a textual note.
- The destructive confirmation step is the only authorization boundary for
  the first-run origin choice (`master` or `develop`) when the HU
  integration branch does not yet exist. A non-interactive first run
  stops safely rather than choosing an origin automatically.

The runner also creates this lock in the repository's Git common directory:

```text
issue-killer.lock/
├── owner
└── status
```

For a normal repository, inspect progress from another terminal with:

```bash
cat "$(git rev-parse --git-common-dir)/issue-killer.lock/status"
```

The status snapshot includes the runner PID, state, iteration, elapsed
seconds, and last update time. The Git common directory makes one lock cover
the main checkout and all linked worktrees. A concurrent runner exits with
the owner and latest status. A lock whose owner process no longer exists is
recovered automatically.

## Recovery checkpoint

The runner persists a durable checkpoint for every worker attempt next to
the repository lock, so a future restart can recover the selected issue,
profile identity, and the last safe state without relying on the failed
process's memory:

```text
issue-killer.checkpoint
```

Inspect the checkpoint from another terminal with:

```bash
cat "$(git rev-parse --git-common-dir)/issue-killer.checkpoint"
```

The file uses the same Git common directory as the lock, so it covers the
main checkout and all linked worktrees.

### Fields

| Field | Meaning |
|---|---|
| `pid` | Runner PID that wrote the checkpoint |
| `iteration` | Worker attempt number (starts at 1) |
| `issue` | Identified issue number; for scoped Azure execution this is the active ticket, or `unknown` until selection |
| `hu` | Pinned Azure delivery HU identifier (Azure HU execution only) |
| `ticket` | Active direct-child Azure delivery ticket identifier (Azure HU execution only) |
| `branch` | Current branch the worker is on |
| `base_branch` | Configured base branch for PRs |
| `base_sha` | SHA of the base branch when the checkpoint was written |
| `session_id` | Captured Claude session identity, or `unavailable` |
| `profile` | Selected execution profile name, when available |
| `cli` | Profile CLI (`claude`, `codex`, or `opencode`), when available |
| `model` | Profile model identifier, when available |
| `command` | Profile command name, when available |
| `state` | Lifecycle state of the attempt (see below) |
| `updated_at` | Timestamp of the last checkpoint write |

### Lifecycle states

The checkpoint state advances as the worker emits recognizable events. The
runner records the work identity as soon as the assistant reads it through
the active tracker (`gh issue view N` or `az boards work-item show --id N`),
before any edit, push, PR creation, or merge.

| State | Reached when |
|---|---|
| `starting` | The attempt has been recorded but the worker has not yet identified its issue |
| `issue_selected` | The worker inspected the active tracker and the issue/work-item number was captured |
| `mutating` | The worker edited, committed, or ran tests |
| `branch_pushed` | The worker pushed the feature branch |
| `pr_created` | The worker created the pull request |
| `pr_merged` | The worker merged or closed the pull request |
| `issue_closed` | The worker closed the issue |
| `blocked` | The worker reported `BLOCKED` |
| `failed` | The worker reported `FAILED` or exited with a non-zero status |
| `malformed` | The worker exited cleanly but emitted no recognized status marker |
| `recovery_required` | Transient retries exhausted; operator attention needed |
| `lock_lost` | Repository lock ownership was lost; checkpoint is diagnostic only and cannot be resumed |

### Privacy boundary

The checkpoint never persists prompts, credentials, bearer tokens, full
shell commands, or any complete tool inputs. It only records the identity
information needed to resume or report on the attempt. Sensitive fields in
the stream renderer continue to be redacted before reaching operator output,
and the side-channel issue file (`${OUTPUT_FILE}.issue`) carries only the
bare issue number back to the supervisor.

The same non-sensitive identity fields (`issue`, `hu`, `ticket`, `branch`,
`base_branch`, and `state`) are mirrored into the lock `status` file so
operators can inspect progress without reading the checkpoint directly.

### Retention

- `ISSUE_COMPLETED` removes the checkpoint.
- `QUEUE_EMPTY` removes the checkpoint (verified empty queue).
- `BLOCKED`, `FAILED`, non-zero worker exits, and unknown statuses retain
  the checkpoint with the last safe state so the next restart can decide
  whether recovery is safe.

## Transient retry

The supervisor wraps every worker invocation in a bounded retry loop. Only
worker exits whose output matches an approved transport failure signature
are retried. Anything else — `BLOCKED`, `FAILED`, malformed status markers,
context-window exhaustion, and non-transient process exits — stops the loop
immediately.

Before every retry the supervisor:

1. Reads the persisted checkpoint and the live Git branch so the identity
   context is consistent.
2. Reconciles the local branch, the live PR list, and the live issue state.
   A checkpoint that already reached `pr_merged` or `issue_closed` (or an
   already-merged PR with a closed issue) is treated as completed; the
   supervisor injects a synthetic `ISSUE_COMPLETED` status and advances the
   loop without launching another worker.
3. Confirms an OpenCode session with `session.get()` when the checkpoint carries one, the worktree still matches the recorded issue, branch, base branch, and base SHA. A fallback continues the same resumable session with the next profile's model. If confirmation fails, the runtime starts a fresh OpenCode session constrained to the checkpointed issue; local branch, base, tracker, or primary-chain configuration drift stops with `RECOVERY_REQUIRED`.
4. Writes `state=recovering`, `recovery_attempt`, `recovery_delay`, and
   `recovery_category` into the lock status snapshot so operators can
   observe the in-flight retry without reading the checkpoint file.

After the configured retry budget is exhausted, the supervisor writes
`state=recovery_required` into the lock status, retains the checkpoint and
the per-iteration output artifact, appends
`ISSUE_KILLER_STATUS=RECOVERY_REQUIRED` to the artifact, prints a diagnostic
on stderr pointing to the retained artifact, and exits with code `4`. It
never advances to another issue — the next runner startup is responsible
for picking the work back up.

## OpenCode fallback

When the selected profile uses OpenCode, the operator may declare an ordered
fallback chain. The supervisor advances only on explicit provider quota
exhaustion, persistent rate limits, or model unavailability — never on
generic network errors, malformed output, `BLOCKED`, `FAILED`, or context
overflow. Each fallback is persisted as `fallback_in_progress`; a chain that
lacks a remaining profile produces `RECOVERY_REQUIRED`.

## OpenCode fallback chains

The fallback chain is OpenCode-only and ordered. The supervisor advances only
on `provider_quota`, `provider_rate_limit`, or `provider_model_unavailable`.
Transport failures are retried using the bounded delay schedule before any
fallback is considered; generic implementation failures, malformed output,
`BLOCKED`, `FAILED`, and context overflow never consume a fallback.

Each fallback persists the failed profile, category, next profile, and
remaining chain in the checkpoint. A resumable session is confirmed with
`session.get()` and reused with the next profile's model. If that session is
missing or its pinned issue, branch, base branch, or base SHA does not match,
OpenCode starts a fresh session constrained to the checkpointed issue. An
exhausted or malformed chain produces `RECOVERY_REQUIRED` without advancing.

Restart recovery restores the active profile and remaining chain at the
persisted position. Config, branch, base, or tracker drift remains
`RECOVERY_REQUIRED`; legacy or ambiguous checkpoints require explicit
`ISSUE_RUNNER_ADOPT_ISSUE` and never infer an issue from files or branches.

### Legacy binary migration


A live lock or checkpoint produced by the historical
`claude-minimax-issue-runner` binary blocks startup. The supervisor detects
the legacy namespace, refuses to acquire its own lock, and either
quarantines unreadable state or atomically migrates a valid legacy
checkpoint into the canonical `issue-killer.checkpoint` namespace. The
migration is one-way; once the new checkpoint is in place the canonical
runner never depends on the historical names again.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Eligible issue queue is empty |
| `1` | Worker or runner failure |
| `2` | Pending work requires human input |
| `3` | Configured iteration limit reached |
| `4` | `RECOVERY_REQUIRED` — transient retries exhausted or repository lock ownership was lost; checkpoint and output retained for a human operator or the next restart to inspect |

## Safety

This runner intentionally permits workers to commit, push, create and merge
PRs, and close issues. It refuses to start from unexplained dirty work:
dirty state must either match a valid checkpoint or be explicitly adopted
with `ISSUE_RUNNER_ADOPT_ISSUE`. It also checks the worktree before every
normal new worker and refuses a second runner for the same repository. The
default `bypassPermissions` mode is required because non-interactive
`--print` workers cannot answer permission prompts; the runner's TTY
confirmations are the authorization boundary. Any missing or unknown worker
status stops the loop. Transient transport failures are the only category
of failure that triggers an automatic retry, and that retry always respects
the configured delay schedule and retry limit.
