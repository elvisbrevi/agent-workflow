# Issue-Killer V2 Contract (M0 Freeze)

Status: frozen at M0 by issue #77. Later milestones must preserve this surface
or amend it through a new decision; they cannot quietly change it.

This document captures the non-negotiable public behavior of the V2
`issue-killer` (TypeScript + Bun + `@opencode-ai/sdk`) before any V2 runtime
lands. It does not introduce a V2 package, entrypoint, or runtime code; it is a
behavior matrix, a test checklist, and a Bash V1 fixture inventory that later
milestones must satisfy.

## Parent Spec and Authoritative Inputs

The parent specification is GitHub issue #76. This contract only restates the
public contract that issue demands; it does not contradict it. Authoritative
domain language and design live in:

- [`CONTEXT.md`](../../CONTEXT.md) — domain vocabulary
- [`docs/adr/0001-use-execution-profiles-and-tracker-adapters.md`](../adr/0001-use-execution-profiles-and-tracker-adapters.md)
- [`docs/adr/0014-opencode-sdk-sole-runtime.md`](../adr/0014-opencode-sdk-sole-runtime.md)
- [`docs/design/issue-killer.md`](issue-killer.md) — V2 design and source layout
- [`plan-migracion-issue-killer-typescript-bun-opencode.md`](../../plan-migracion-issue-killer-typescript-bun-opencode.md)
  — milestone plan and scope decisions

ADR 0012/0013 were withdrawn; multi-CLI language must not reappear.

## Contract Rules

The frozen contract is constrained by the following non-negotiable rules:

1. V2 is TypeScript executed by Bun. `@opencode-ai/sdk` is the only agent
   runtime integration. No `opencode run --format json` invocations. No Claude
   or Codex runtime adapters.
2. The supervisor owns issue selection. It pins exactly one tracker item before
   any OpenCode session is created. A worker session never selects, inspects,
   or switches issues.
3. A worker outcome is never sufficient to advance the queue. The supervisor
   performs live **completion verification** through the active tracker
   adapter before clearing the checkpoint or starting another issue.
4. Bash V1 is rollback-only during the migration. Its multi-runtime behavior is
   not part of the V2 contract. Security findings from the code review are not
   backported into Bash V1; they are fixed in V2.
5. Skills and their `SKILL.md` files are out of scope for this migration and
   remain unchanged.
6. M0 does not add a package, runtime, entrypoint, installer change, or
   symlink. M0 is documentation and a fixture inventory only.

## Behavior Matrix

| Surface | Frozen V2 behavior | Observable proof or boundary |
|---|---|---|
| Public worker statuses | The closed set is `ISSUE_COMPLETED`, `QUEUE_EMPTY`, `BLOCKED`, `FAILED`, `RECOVERY_REQUIRED`. | Structured worker outcome and final command status use this closed set. Unknown values are malformed. |
| Structured outcome | The primary result is an object with `status`, `issue`, and a short non-sensitive `summary`. The `issue` is the host-pinned identity; it is never derived from model prose. | The event pump validates the schema and rejects missing, invalid, or contradictory results. |
| Text marker compatibility | `ISSUE_KILLER_STATUS=<status>` is accepted only while Bash V1 exists. Structured output takes precedence; contradictions reject; invalid/missing is malformed. The marker acceptor is removed with Bash retirement at M12. | A marker alone never clears state or advances the queue without live completion verification. |
| Exit `0` | A verified terminal queue result, normally `QUEUE_EMPTY` after all completed work has been verified. | The checkpoint is cleared only after the queue-empty result is verified. |
| Exit `1` | `FAILED`, malformed worker output, or an unrecoverable worker or runner failure. | The checkpoint and diagnostic artifact remain available for inspection. |
| Exit `2` | `BLOCKED`; pending work cannot safely continue without operator input. | No fallback or second issue is started. |
| Exit `3` | The configured completed-issue limit was reached. | The run stops without selecting another issue in that process. |
| Exit `4` | `RECOVERY_REQUIRED`; identity or external state is incomplete, ambiguous, drifted, or the retry budget is exhausted. | Checkpoint and recovery artifact are retained; the queue does not advance. |
| Host-owned selection | The supervisor selects and pins an eligible item before session creation. The worker prompt explicitly forbids inspecting or selecting another item. | Tracker selection and checkpoint identity precede every OpenCode session create call. |
| GitHub eligibility | An item must be open, unassigned, labeled `ready-for-agent`, non-epic by type/label/title, and free of open native dependencies. | Eligibility is read through `gh` using validated JSON. |
| GitHub completion verification | All conditions required: issue closed, exactly one attributable PR, PR merged, and `baseRefName` exactly equals the configured base branch. | Any zero/multiple PRs, open PR, wrong base, or open issue yields `RECOVERY_REQUIRED`. |
| Azure delivery completion | An Azure delivery ticket is complete only after exactly one successful PR is merged into the pinned HU integration branch, required completion evidence is present, cumulative real effort is valid, and the ticket is in the configured completed state. | Partial integration remains `RECOVERY_REQUIRED`. The HU is not closed and the ticket is not promoted automatically to repository mainline. |
| Tracker boundary | GitHub uses `gh`; Azure uses `az boards` for work items and relations and `az repos` for pull requests. Provider commands stay in adapters. | The application consumes normalized tracker ports, not provider-specific stdout. |
| Execution profile | A profile is an indivisible OpenCode runtime plus provider/model pairing. `cli` and `command` are `opencode`; `model` is split once into `providerID/modelID`. | Configuration validation rejects other runtimes, malformed models, credentials, unknown keys, and unsafe values. |
| Fallback chain | Fallbacks contain existing OpenCode profiles only, in declared order, with no duplicates, missing references, or cycles. Only `provider_quota`, `provider_rate_limit`, and `provider_model_unavailable` consume a fallback. | Transport retries happen first. Implementation failures, malformed output, `BLOCKED`, and `FAILED` never consume a fallback. |
| Fallback session | Every eligible fallback starts a fresh OpenCode worker session on the same pinned issue, branch, worktree, base identity, and remaining chain position. No mid-session model switch is assumed safe. | Checkpoint records failed profile, next profile, category, and chain position. |
| OpenCode server | One server exists per supervisor run, binds only to `127.0.0.1`, and uses an ephemeral port (`port: 0` or bounded reserve-and-retry when required by the pinned SDK). | Health/version compatibility is checked before a worker prompt. `EADDRINUSE` retries are bounded. |
| Event pump | Subscribe before prompting, filter by session identity, and drain every matching event in order. Foreign session events are ignored. | Multiple tool/file/retry/status events in one run are all observed; no first-event-only behavior is allowed. |
| Autonomous permission mode | The destructive confirmation is the one authorization boundary. After confirmation the OpenCode instance uses full autonomous permission for the run. An unexpected permission event stops safely rather than being silently approved. | Non-interactive destructive execution with `auto_approve = false` fails before session creation. |
| Opaque session ID | A persisted session ID must match `^[A-Za-z0-9_-]+$` and be at most 128 characters. Revalidate before persistence, resume, lookup, or deletion. | Path traversal, control characters, empty IDs, and overlong IDs fail closed. |
| Checkpoint | The Git common directory contains `issue-killer.checkpoint`, retaining the `key=value` format (optional `format_version=2`). Only allowlisted non-sensitive identity fields are stored. | Prompt text, credentials, headers, complete tools, and complete commands never enter the checkpoint. Legacy V1 fixtures remain readable without loss. |
| Repository lock | The Git common directory contains `issue-killer.lock/owner` and `issue-killer.lock/status`. Ownership uses an exclusive directory, PID, random token, repository, and timestamp. | Linked worktrees share one lock. Release requires a matching token. Stale recovery requires a dead PID and unchanged owner across reread. |
| Status writes | The event pump is the single in-memory status/checkpoint writer. Atomic writes use random temporary names in the same directory, then close and rename. | Temporary names never use `$$`; concurrent heartbeat/status updates cannot overwrite one another. |
| Legacy adoption | `ISSUE_RUNNER_ADOPT_ISSUE` is optional and must contain the explicit positive issue number. Adoption requires TTY confirmation. | The runner never infers an issue from a branch, filename, dirty path, or queue order. Missing identity fails closed. |
| Restart recovery | Recovery reconciles checkpoint identity, branch, base identity, configuration, tracker state, and PR state before resuming. A confirmed session lookup must match directory, issue, branch, base, and profile. | Drift, ambiguity, unavailable tracker state, or missing confirmation yields `RECOVERY_REQUIRED`. |
| Configuration | Default path is `~/.config/issue-killer/config.toml`; `--config <path>` overrides it. `default_profile` and writable `log_dir` are required. Unknown keys, duplicate fallback entries, cycles, missing references, credentials, control newlines/CR/NUL, and trailing token junk are rejected. | Missing flag values produce explicit diagnostics, never unbound-variable errors. |
| Harness execution log | The supervisor event pump writes one redacted JSONL log per queue run under the configured `log_dir`. It records observed commands, file create/edit/delete events, and safe progress metadata. | The model does not author the log, the log is not put in the prompt, raw SDK events are off by default, and no model tokens are consumed by logging. |
| Redaction | Redaction occurs before console or file sinks and handles line secrets plus multiline private-key blocks. | Bearer/API credentials, authorization headers, private-key bodies, full file bodies, and complete commands do not leak. |
| Cancellation | SIGINT/cancellation aborts the session, closes the local server, preserves recoverable state, and releases only owned resources. | Cleanup ordering is deterministic and no second issue starts after cancellation. |
| Public command | The V2 public command remains `issue-killer`; V2 uses the Bun entrypoint only after cutover. | M0 does not add the package, runtime, entrypoint, installer cutover, or symlink change. |

## Environment Contract

The following `ISSUE_RUNNER_*` values are retained as V2 operator controls.
Defaults are part of the contract unless an explicit configuration or future
ADR changes them.

| Variable | Default | V2 meaning |
|---|---|---|
| `ISSUE_RUNNER_BASE_BRANCH` | `main` | Exact PR completion-verification target. |
| `ISSUE_RUNNER_MAX_ITERATIONS` | `0` | Maximum completed issues in one process; `0` means no limit. |
| `ISSUE_RUNNER_PROGRESS_INTERVAL` | `30` | Operator heartbeat interval in seconds; `0` disables idle heartbeats. |
| `ISSUE_RUNNER_ASSUME_YES` | `false` | Uses the already-authorized destructive confirmation path; it does not bypass preflight validation. |
| `ISSUE_RUNNER_RETRY_DELAYS` | `15,30,60` | Bounded transport retry delays before a permitted fallback. |
| `ISSUE_RUNNER_RETRY_LIMIT` | unset | Optional total attempt limit, including the initial attempt. |
| `ISSUE_RUNNER_ADOPT_ISSUE` | unset | Explicit legacy recovery issue identity; never inferred. |

`ISSUE_KILLER_CONFIG_PATH` remains the configuration-path override.

The V2 SDK event pump replaces the V1 text-stream switch and provider-specific
text classification controls. `ISSUE_RUNNER_STREAM_OUTPUT`,
`ISSUE_RUNNER_TRANSIENT_PATTERNS`, and `ISSUE_RUNNER_UNRESUMABLE_PATTERNS` are
not V2 runtime controls.

## Mandatory V2 Test Checklist

Each scenario below is derived from the repository code review
(`agent-workflow-code-review.md`) and is mandatory at the public seams before
the corresponding V2 milestone is accepted. The IDs are stable so tests and
backlog items can refer to them.

| ID | Required scenario | Expected invariant |
|---|---|---|
| V2-SEC-01 | GitHub false completion: open issue; zero PRs; multiple PRs; unmerged PR; merged PR to the wrong base. | A worker completion result never clears the checkpoint or advances the queue unless all live GitHub conditions pass. |
| V2-SEC-02 | Session IDs containing `../`, `/`, control characters, empty values, and more than 128 characters. | Invalid IDs are rejected before persist, resume, lookup, or delete. |
| V2-SEC-03 | TOML scalar newline, carriage-return, and NUL injection; trailing junk after strings and arrays; unknown keys; duplicate fallback entries; missing references and cycles. | Configuration fails closed with an actionable diagnostic and does not write injected state. |
| V2-SEC-04 | Concurrent heartbeat and status/checkpoint writes. | One writer and random same-directory temporary names preserve complete atomic snapshots; no `$$` temporary collision. |
| V2-SEC-05 | Installer dry-run with cache/destination snapshots and uninstall with no network, including a missing cache. | Dry-run changes only temporary staging; uninstall removes owned links without repository sync. |
| V2-SEC-06 | One session emits multiple ordered tool/file/status events plus foreign-session events. | Every matching event is processed in order; foreign events are ignored; no first-event-only truncation. |
| V2-SEC-07 | Multiline PEM-like private key, bearer/API credentials, authorization headers, and sensitive command/file details. | Redaction occurs before both console and harness log sinks; private-key body content never leaks. |
| V2-SEC-08 | Missing values for `--config`, `--hu`, and any required repository argument, plus duplicate repository arguments. | The CLI exits with explicit usage errors and never exposes shell unbound-variable noise. |

The following queue, recovery, tracker, and Azure evidence cases are also
contract tests. They must be implemented at ports or black-box seams, not by
asserting private helper structure:

- `ISSUE_COMPLETED` with verified delivery clears the checkpoint and permits
  the next queue decision; an unverified result becomes `RECOVERY_REQUIRED`.
- `QUEUE_EMPTY` clears state only after a live empty-queue check.
- `BLOCKED`, `FAILED`, malformed, cancellation, retry exhaustion, and fallback
  exhaustion never start a second issue.
- Fallback order, fresh-session creation, checkpoint chain position, restart
  drift, and explicit adoption are all preserved.
- GitHub eligibility covers assigned, epic type, epic label, `[Epic]` title,
  open blocker, and eligible cases.
- Azure selection covers HU pinning, direct child scope, ordering, blocked
  predecessors, completed children, evidence, effort, PR target, and partial
  integration recovery.

## Bash V1 Fixture Inventory

These existing Bash tests are the V1 scenario sources for later V2 black-box
parity. They are an inventory, not permission to port provider-specific
command protocols or preserve V1 security defects.

### Queue, state, and recovery

Source: [`tests/issue_killer_test.sh`](../../tests/issue_killer_test.sh)

- Queue and outcome lifecycle: `test_fresh_shell_per_issue`,
  `test_unknown_status_stops_loop`,
  `test_streaming_worker_preserves_non_zero_exit_code`,
  `test_streaming_blocked_retains_artifact_path`,
  `test_streaming_worker_identifies_issue_before_first_mutation`,
  `test_checkpoint_cleared_on_issue_completed`, and
  `test_checkpoint_cleared_on_queue_empty`.
- Worktree and lock safety: `test_dirty_worktree_is_rejected`,
  `test_repository_lock_rejects_second_runner`,
  `test_stale_repository_lock_is_recovered`,
  `test_checkpoint_records_required_fields_atomically`, and
  `test_checkpoint_does_not_persist_secrets_or_full_commands`.
- Retry and restart: `test_transient_disconnect_retries_with_bounded_backoff`,
  `test_non_transient_disconnect_does_not_retry`,
  `test_blocked_outcome_does_not_retry`,
  `test_recovery_required_after_exhausted_retries`,
  `test_recovery_required_does_not_advance_to_next_issue`,
  `test_recovery_reconciles_local_state_before_continuing`,
  `test_restart_recovery_requires_confirmation_before_worker`,
  `test_legacy_adoption_requires_explicit_issue_number`,
  `test_confirmed_restart_recovery_resumes_session_and_clears_checkpoint`,
  `test_confirmed_legacy_adoption_creates_checkpoint_and_launches_fresh_worker`,
  and `test_restart_recovery_does_not_duplicate_closed_issue`.
- Config and operator boundary: `test_default_profile_used_without_tty`,
  `test_missing_default_profile_rejects_non_tty`,
  `test_config_rejects_unknown_top_level_key`,
  `test_config_rejects_unknown_profile_field`,
  `test_destructive_confirmation_lists_profile_identity`, and
  `test_black_box_status_marker_takes_precedence_over_provider_diagnostics`.
- Fallback and scope preservation: `test_black_box_opencode_fallback_validation_rejects_missing_profile`,
  `test_black_box_opencode_fallback_validation_rejects_invalid_chains`,
  `test_black_box_opencode_quota_failure_advances_fallback_with_same_session`,
  `test_black_box_opencode_rate_limit_retries_before_fallback`,
  `test_black_box_opencode_model_unavailable_launches_constrained_fresh_fallback`,
  `test_black_box_opencode_excluded_failures_never_consume_fallbacks`,
  `test_black_box_opencode_fallback_exhaustion_retains_recovery_checkpoint`,
  `test_black_box_opencode_restart_restores_active_fallback_position`, and
  `test_black_box_restart_chain_drift_retains_recovery_required`.

Source: [`tests/issue_killer_migration_test.sh`](../../tests/issue_killer_migration_test.sh)

- Legacy lock/checkpoint scenarios: `test_stale_legacy_lock_is_recovered_before_new_lock`,
  `test_legacy_lock_quarantines_unreadable_owner`,
  `test_legacy_lock_rejects_live_owner`,
  `test_legacy_checkpoint_migrates_atomically_once`,
  `test_legacy_checkpoint_with_ambiguous_profile_mapping_fails_closed`,
  `test_legacy_checkpoint_with_partial_fields_fails_closed`,
  `test_migration_does_not_run_when_legacy_state_absent`,
  `test_migrated_checkpoint_with_closed_issue_discards_and_advances_queue`,
  and `test_migrated_checkpoint_reconciles_tracker_state_before_launch`.

### Tracker and delivery

- GitHub adapter source: [`tests/github_tracker_adapter_test.sh`](../../tests/github_tracker_adapter_test.sh).
  It is the source for eligibility filtering, epic exclusion, claim/close
  delegation, and normalized PR state. M4 must add the V2 completion matrix
  cases in `V2-SEC-01`; the current single merged-PR fixture is not sufficient
  completion verification.
- Azure adapter source: [`tests/azure_devops_tracker_adapter_test.sh`](../../tests/azure_devops_tracker_adapter_test.sh).
  It covers repository-owned mapping preflight, identity, eligible work-item
  filtering, open predecessor exclusion, claim, PR normalization, and guarded
  close behavior.
- HU selection source: [`tests/azure_hu_selection_test.sh`](../../tests/azure_hu_selection_test.sh).
  It covers deterministic HU selection, direct-child-only scope, epic and
  assigned exclusions, blocked children, pinned recovery, and prompt pinning.
- HU branch source: [`tests/azure_hu_branch_test.sh`](../../tests/azure_hu_branch_test.sh).
  It covers feature/hotfix/refactor category inference, safe branch naming,
  origin selection, and existing branch reuse.
- HU runner source: [`tests/azure_hu_runner_test.sh`](../../tests/azure_hu_runner_test.sh).
  It covers malformed HU arguments, pre-worker safety, and the full scoped
  runner boundary.
- HU drainage source: [`tests/azure_hu_drainage_test.sh`](../../tests/azure_hu_drainage_test.sh).
  It covers one child per worker, verified advancement, live re-evaluation,
  empty and blocked scopes, HU non-closure, no mainline PR, and stale-ticket
  recovery.
- HU lifecycle source: [`tests/hu_progress_test.sh`](../../tests/hu_progress_test.sh).
  It freezes the canonical phase set and sanitization of credentials, PEM
  blocks, attachments, payloads, and status/checkpoint mirrors.
- Azure seam source: [`tests/azure_hu_seam_test.sh`](../../tests/azure_hu_seam_test.sh).
  It verifies the operator guide, destructive authorization, status protocol,
  evidence prerequisites, and installer catalog surface.
- Azure sandbox source: [`tests/azure_dev_sandbox_test.sh`](../../tests/azure_dev_sandbox_test.sh).
  It is opt-in only and covers missing prerequisites, production-shaped target
  refusal, and explicit skipped-live-step manifests.

### Installer and catalog

Source: [`tests/install_test.sh`](../../tests/install_test.sh)

This suite is the installer/catalog regression source for later milestones. It
covers no-TTY diagnostics, explicit piped mode, global/local destination
round-trips, managed-link reconciliation, and preservation of the Azure guide.
M0 does not change installer behavior.

## M0 Scope Boundary

M0 is documentation and fixture inventory only. It must not:

- add `package.json`, `bun.lock`, `tsconfig.json`, `bin/`, `src/`, or a V2
  runtime entrypoint;
- alter Bash V1 runtime behavior or backport code-review security fixes;
- change the public installer, symlink, skills, tracker state, or issue queue;
- reintroduce withdrawn multi-runtime language into the V2 domain model.

The next implementation milestone may add the SDK spike (M1) only after this
contract is reviewed and accepted.
