# Issue Killer Design

## Goal

Replace the Claude-MiniMax-specific runner with `issue-killer`, an autonomous supervisor that can execute one issue per isolated worker using Claude, Codex, or OpenCode and can operate against GitHub or Azure DevOps.

The existing safety guarantees remain: one runner per repository, one issue per worker, explicit authorization for destructive actions, bounded retries, durable recovery identity, verified PR merge, and issue closure before advancing the queue.

## Source Layout

`run.sh` is the composition root and queue loop. It loads modules that have no source-time side effects:

- `config/`: strict TOML parsing and the execution-profile catalog behind the stable `issue-killer-config.sh` facade.
- `operator/`: all TTY/stdin interaction for profile selection and destructive or recovery confirmation.
- `state/`: durable checkpoints and repository-wide lock ownership.
- `recovery/`: legacy migration, startup reconciliation, retry policy, and OpenCode fallback transitions.
- `runtime/supervisor.sh`: worker process supervision and progress heartbeats.
- `runtime/*-adapter.sh` and `tracker/*-adapter.sh`: the CLI and tracker seams required by ADR 0001.

The modules communicate through the existing normalized `runtime_*` and `tracker_*` interfaces. Configuration state is temporary and is removed by the composed exit trap on both successful and failed startup.

## Configuration

The default configuration path is `~/.config/issue-killer/config.toml`. `--config <path>` replaces it. Configuration must not contain credentials; each CLI remains responsible for its own authenticated provider configuration.

```toml
default_profile = "claude-minimax"

[profiles.claude-minimax]
label = "Claude | MiniMax M3"
cli = "claude"
command = "claude-minimax"
model = "minimax-m3"
shell = "bash"
init_file = "~/.bashrc"

[profiles.claude-minimax.options]
permission_mode = "bypassPermissions"

[profiles.codex-luna-high]
label = "Codex | GPT-5.6 Luna | high"
cli = "codex"
command = "codex"
model = "gpt-5.6-luna"

[profiles.codex-luna-high.options]
reasoning_effort = "high"
sandbox = "danger-full-access"

[profiles.opencode-minimax]
label = "OpenCode | MiniMax M3"
cli = "opencode"
command = "opencode"
model = "provider/minimax-m3"
fallbacks = ["opencode-gpt"]

[profiles.opencode-minimax.options]
variant = "high"
auto_approve = true

[profiles.opencode-gpt]
label = "OpenCode | GPT"
cli = "opencode"
command = "opencode"
model = "provider/gpt-model"
```

Model identifiers in examples are illustrative. They must match the models exposed by the operator's installed CLI and configured providers.

Common profile fields are validated independently from `[profiles.<name>.options]`. Each CLI adapter owns and validates its allowed options; unknown options are errors rather than ignored values. `command` is either a directly executable command or a validated shell function name loaded through the optional `shell` and `init_file` fields. Arbitrary shell expressions and `eval` are not supported.

## Profile Selection

With a controlling TTY, the runner displays every profile as `label`, CLI, model, and relevant variant/effort, then requires a selection before destructive confirmation. The menu footer always states the active configuration path and that editing it adds or changes profiles.

After selecting an OpenCode profile, the runner repeatedly offers the remaining OpenCode profiles to build an ordered fallback chain. Each selected profile is removed from later choices, and `None` terminates the chain. Non-OpenCode profiles do not show this menu.

Without a TTY, the runner uses `default_profile` and that profile's declared `fallbacks`. Configuration validation rejects a missing default, unknown references, duplicate entries, cycles, and fallbacks that are not OpenCode profiles.

The destructive confirmation displays the selected profile, model, fallback chain, tracker, repository, permission/autonomy mode, and base branch.

## CLI Adapters

Each adapter owns five behaviors:

1. Validate its executable, model, and adapter-specific options.
2. Build a non-interactive, autonomous invocation without unsafe string evaluation.
3. Decode its JSON event stream into normalized progress events and a session identity.
4. Resume a compatible session or launch a fresh worker constrained to the checkpointed issue.
5. Classify explicit provider failures eligible for OpenCode fallback.

Claude uses print mode and Claude stream JSON; Codex uses `exec` and JSONL; OpenCode uses `run --format json`. Tool names and event schemas are normalized before checkpoint/progress logic sees them. The orchestration layer uses the generic final marker `ISSUE_KILLER_STATUS` with `ISSUE_COMPLETED`, `QUEUE_EMPTY`, `BLOCKED`, `FAILED`, or `RECOVERY_REQUIRED`.

Session resumption is capability-based. A checkpoint may be resumed only by the same CLI adapter on the recorded branch and base SHA. OpenCode may change to the next profile in its chain while continuing the same session when supported; otherwise it launches a fresh recovery worker constrained to the same issue and existing worktree.

## Fallback Behavior

Existing bounded transport retries run before profile fallback. OpenCode advances its chain only after the adapter identifies an explicit quota/subscription exhaustion, persistent provider rate limit, or unavailable model. Generic non-zero exits, malformed output, `BLOCKED`, `FAILED`, context-window exhaustion, and implementation failures never rotate profiles automatically.

Before fallback, the supervisor persists the failed profile, next profile, remaining chain, issue, branch, base SHA, and last safe state. It then reconciles tracker and PR state to avoid duplicate side effects. Exhausting the chain produces `RECOVERY_REQUIRED`; it never advances to another issue.

## Tracker Adapters

The runner detects the tracker from the Git remote and validates it against `docs/agents/issue-tracker.md`.

- GitHub uses `gh` for issue discovery, dependency checks, assignment, PR creation/reconciliation/merge, and issue closure.
- Azure DevOps uses `az boards` for work items and relations and `az repos pr` for pull requests. Organization, project, repository, area/iteration defaults, work-item types, open/closed states, and role mappings come from the repository's tracker documentation.

An ambiguous remote, conflicting documentation, missing CLI/authentication, or incomplete Azure mapping fails before worker launch with instructions to run `setup-elvis-brevi-skills`. Tracker selection is not stored in a machine-level execution profile.

Both adapters expose equivalent normalized operations: list eligible non-epic work, check blockers, read/claim an item, find a PR by source branch, verify merge state, close the item, and reconcile recovery state.

## Checkpoints And Locks

New state lives in the Git common directory as `issue-killer.lock/` and `issue-killer.checkpoint`. In addition to current lifecycle fields, checkpoints record the tracker, selected profile, CLI, model, fallback chain, active fallback position, and adapter session identity. Credentials, prompts, complete commands, and tool inputs remain excluded.

On first startup after renaming, `issue-killer`:

1. Refuses to start if the legacy `claude-minimax-issue-runner.lock` has a live owner.
2. Recovers or removes a stale legacy lock using the existing ownership checks.
3. Migrates a valid legacy checkpoint atomically to the new name and records the matching Claude profile.
4. Stops with `RECOVERY_REQUIRED` if the legacy state cannot be mapped unambiguously.

No permanent `claude-minimax-issue-runner` command alias remains.

## Installation And Documentation

The source directory, agent definition, command, tests, status marker, environment variables, logs, locks, checkpoints, and user-facing text adopt the `issue-killer` name. The installer removes old agent/runner symlinks while preserving repository recovery state for the new runner to inspect.

The README includes the full sample TOML, configuration path, profile menu behavior, supported CLI/tracker matrix, non-interactive behavior, fallback rules, migration notes, and commands for validating available models in each CLI.

## Acceptance Criteria

- A TTY launch lists configured profiles and prints the configuration file path; selection controls the invoked CLI and model.
- A non-TTY launch uses the configured default profile and fails clearly when it is absent or invalid.
- Claude, Codex, and OpenCode fixtures verify argument translation, event normalization, status extraction, session handling, and safe permissions.
- OpenCode fallback preserves issue identity and order, activates only for approved provider failures, and stops safely when exhausted.
- GitHub and Azure DevOps fixtures verify queue selection, blocker detection, PR reconciliation/merge verification, and item closure.
- Recovery persists and enforces profile, fallback, tracker, branch, and issue identity without storing secrets.
- An active legacy runner blocks the renamed runner; a valid legacy checkpoint migrates once without a permanent command alias.
- Installer and runner regression suites pass on Bash 3.2 and the project's supported modern Bash version.
