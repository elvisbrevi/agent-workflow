# Instructions for agents working in this repository

## Repository map

This repository contains two kinds of artifacts:

- **Skills**: prompt-driven workflows under `<category>/<name>/SKILL.md`.
- **Agents**: executable workflows under `agent/<name>/`.

The repository has one agent: `agent/lazy-workflow/`. Runtime code must stay
inside that directory rather than a skill directory.

## Where to modify things

| Need | Modify |
|---|---|
| Add or change a workflow used by an AI session | The relevant `<category>/<skill>/SKILL.md` and adjacent references |
| Add a new skill | A category directory, `SKILL.md`, optional `agents/openai.yaml`, and README catalog entries |
| Change lazy-workflow CLI parsing or coordination | `agent/lazy-workflow/src/cli/lazy-workflow-cli.ts` |
| Change Azure HU lookup or login polling | `agent/lazy-workflow/src/azure/` |
| Change OpenCode invocation or JSONL decoding | `agent/lazy-workflow/src/opencode/` |
| Change what OpenCode is told for a run | `agent/lazy-workflow/src/prompts/workflow-prompt.ts` and the assets in `agent/lazy-workflow/prompts/` |
| Change a marker or the completion-manifest contract | `agent/lazy-workflow/src/prompts/workflow-contract.ts` (the only definition; prompt assets use `{{PLACEHOLDER}}`) |
| Change what a run is permitted to execute | `agent/lazy-workflow/opencode/authority.json` and `agent/lazy-workflow/src/prompts/authority-profile.ts` |
| Change the executable entrypoint | `agent/lazy-workflow/main.ts` |
| Change installation or symlink behavior | `install.sh` and `tests/install_test.sh` |
| Change user-facing orientation | `README.md` and `agent/lazy-workflow/README.md` |
| Change tracker or domain conventions | `docs/agents/`, `docs/adr/`, or `CONTEXT.md` |

Keep coordination in the CLI layer and external-system details in their
matching adapters. Avoid side effects at module import time.

## Issue tracker and domain rules

- Issues are tracked in GitHub Issues for `elvisbrevi/agent-workflow`; use
  `gh` and follow `docs/agents/issue-tracker.md`.
- Use the canonical labels in `docs/agents/triage-labels.md`.
- Read `CONTEXT.md` and applicable ADRs before changing domain behavior.

## Validation before handoff

Run the focused suite for the changed area and the repository-level checks:

```bash
(cd agent/lazy-workflow && bun test)
bash tests/install_test.sh
git diff --check
```

Do not use real credentials or a live backlog in automated tests.

## Adding another autonomous agent

Adding another agent requires explicit repository-level approval. Give it an
isolated directory, contract, executable entrypoint, tests, installer
discovery coverage, README entry, and a documented authorization boundary.
