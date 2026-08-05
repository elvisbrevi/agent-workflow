# Instructions for agents working in this repository

## Repository map

This repository contains two different kinds of artifacts:

- **Skills**: prompt-driven workflows. Each skill lives at
  `<category>/<name>/SKILL.md`; supporting templates and references stay next
  to that file.
- **Agents**: executable supervisors that launch fresh worker sessions. They
  live under `agent/<name>/` and have an `AGENT.md` plus an entrypoint such as
  `run.sh`.

The current agent is `agent/issue-killer/`. Future agents must use their own
directory and must not place runtime code inside a skill directory.

## Where to modify things

| Need | Modify |
|---|---|
| Add or change a workflow used by an AI session | The relevant `<category>/<skill>/SKILL.md` and its adjacent references |
| Add a new skill | A new category directory, `SKILL.md`, optional `agents/openai.yaml`, and README catalog entries |
| Change issue-killer CLI arguments or the main loop | `agent/issue-killer/run.sh` |
| Change TOML parsing or config path resolution | `agent/issue-killer/config/toml-parser.sh` |
| Change profile lookup, validation, or fallback graph rules | `agent/issue-killer/config/profile-catalog.sh` |
| Preserve the public config-loading facade | `agent/issue-killer/config/issue-killer-config.sh` |
| Change profile menus, confirmations, or TTY input | `agent/issue-killer/operator/session.sh` |
| Change lock ownership or status snapshots | `agent/issue-killer/state/repository-lock.sh` |
| Change checkpoint format or persistence | `agent/issue-killer/state/checkpoint.sh` |
| Change startup recovery or legacy migration | `agent/issue-killer/recovery/startup.sh` or `legacy-migration.sh` |
| Change transient retry classification/backoff | `agent/issue-killer/recovery/retry.sh` |
| Change worker lifecycle, streaming, or heartbeats | `agent/issue-killer/runtime/supervisor.sh` |
| Change provider invocation/event decoding | The matching `runtime/<provider>-adapter.sh` |
| Change GitHub/Azure behavior | The matching `tracker/*-adapter.sh`; keep `selector.sh` generic |
| Extend the Azure delivery HU progress lifecycle | `tracker/hu-progress.sh`; preserve the canonical phase set |
| Change the worker's task contract | `agent/issue-killer/PROMPT.md` |
| Change agent metadata or authorization requirements | `agent/issue-killer/AGENT.md` |
| Change operational configuration and recovery reference | `agent/issue-killer/REFERENCE.md` |
| Change installation, destinations, or symlink behavior | `install.sh` and installer tests |
| Change user-facing orientation | `README.md` |
| Change tracker/domain conventions | `docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md`, or `CONTEXT.md` |

Do not duplicate orchestration logic across modules. `run.sh` is the
composition root; sourced modules should define functions and avoid mutating
repository, tracker, worker, or operator state at source time.

## Issue tracker and domain rules

- Issues are tracked in GitHub Issues for `elvisbrevi/agent-workflow`; use
  `gh` and follow `docs/agents/issue-tracker.md`.
- Use the canonical triage labels in `docs/agents/triage-labels.md`.
- Read `CONTEXT.md` and applicable ADRs before changing domain behavior. Use
  the vocabulary defined there.

## issue-killer invariants

- A worker handles at most one issue. Only an explicit `ISSUE_COMPLETED`
  marker may advance the queue.
- The agent is destructive: pushing, creating/merging PRs, and closing issues
  require explicit authorization and a clean-worktree check.
- Tracker and runtime adapters expose normalized interfaces. Provider-specific
  command flags and event formats stay inside their adapter.
- Configuration must remain credential-free and fail closed on malformed,
  unknown, cyclic, or unsafe values.
- Locks and checkpoints use the Git common directory so linked worktrees share
  ownership and recovery state. Never infer a recovery issue from a branch or
  filesystem artifact; use `ISSUE_RUNNER_ADOPT_ISSUE` explicitly.
- Preserve Bash 3.2 compatibility unless the support policy is deliberately
  changed and all affected tests are updated.
- Keep the generic status protocol unchanged unless every adapter, recovery
  path, and test fixture is updated together:
  `ISSUE_COMPLETED`, `QUEUE_EMPTY`, `BLOCKED`, `FAILED`,
  `RECOVERY_REQUIRED`.

## Validation before handoff

Run the focused suite for the changed area and the complete issue-killer
suite. For runner changes, validate both the host Bash and the supported
modern Bash when available:

```bash
bash -n agent/issue-killer/run.sh agent/issue-killer/**/*.sh
bash tests/issue_killer_test.sh
bash tests/issue_killer_migration_test.sh
bash tests/azure_devops_tracker_adapter_test.sh
bash tests/azure_hu_selection_test.sh
bash tests/azure_hu_runner_test.sh
bash tests/azure_hu_branch_test.sh
bash tests/azure_hu_drainage_test.sh
bash tests/hu_progress_test.sh
bash tests/azure_dev_sandbox_test.sh
bash tests/github_tracker_adapter_test.sh
bash tests/install_test.sh
git diff --check
```

When changing a provider or shell boundary, also run the corresponding focused
adapter tests and check that no credentials, prompts, or complete commands are
persisted in checkpoints or status output.

## Adding another autonomous agent

Create `agent/<name>/AGENT.md`, a prompt/contract document, a reference document,
an executable entrypoint, focused tests, and installer discovery coverage.
Keep its locks, checkpoints, environment variables, and status namespace
isolated from `issue-killer`. Then update the agent catalog in `README.md` and
document its destructive actions and authorization boundary before publishing.
