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
| Add or change a deterministic tool exposed as its own command | `agent/lazy-workflow/src/cli/tool-commands.ts` (the names) and `agent/lazy-workflow/src/cli/deterministic-tools.ts` (the dispatch) |
| Change what the operator sees — the stamped line format, the levels, or the run panel | `agent/lazy-workflow/src/output/reporter.ts` |
| Change what a tool call reports about the artifact it touches | `agent/lazy-workflow/src/output/agent-tool-detail.ts` |
| Change Azure HU lookup or login polling | `agent/lazy-workflow/src/azure/` |
| Change the coding agent seam — its options, authority, session errors, or the normalized result and its JSONL decoding | `agent/lazy-workflow/src/coding-agent/` |
| Change how OpenCode is invoked, streamed, or its sessions closed | `agent/lazy-workflow/src/opencode/` |
| Change how Claude Code is invoked, streamed, or its stream decoded | `agent/lazy-workflow/src/claude-code/` |
| Change which CLI a `--cli` value resolves to | `agent/lazy-workflow/src/coding-agent/create-coding-agent.ts` |
| Change the CLI names, their binaries, or how a checkpoint records its session owner | `agent/lazy-workflow/src/coding-agent/agent-cli.ts` and the checkpoint module of that workflow |
| Change what the coding agent is told for a run | `agent/lazy-workflow/src/prompts/workflow-prompt.ts` and the assets in `agent/lazy-workflow/prompts/` |
| Change how the operator answers a planning interview, or add a channel | `agent/lazy-workflow/src/interaction/` |
| Change a marker or the completion-manifest contract | `agent/lazy-workflow/src/prompts/workflow-contract.ts` (the only definition; prompt assets use `{{PLACEHOLDER}}`) |
| Change what a run is permitted to execute with OpenCode | `agent/lazy-workflow/opencode/authority.json` |
| Change what a run is permitted to execute with Claude Code | `agent/lazy-workflow/claudecode/<profile>.json` |
| Change which profile a run gets, or where each CLI reads its authority | `agent/lazy-workflow/src/prompts/authority-profile.ts` |
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
