# Instructions for agents working in this repository

## Repository map

This repository contains two kinds of artifacts:

- **Skills**: prompt-driven workflows under `<category>/<name>/SKILL.md`.
- **Agents**: executable workflows under `agent/<name>/`.

The repository has one agent: `agent/lazy-workflow/`. Runtime code must stay
inside that directory rather than a skill directory. Its desktop GUI,
`agent/lazy-workflow/gui/`, is a front end for that agent, not another one: it
renders `lz catalog` and runs `lz`, and holds no workflow logic.

## Where to modify things

| Need | Modify |
|---|---|
| Add or change a workflow used by an AI session | The relevant `<category>/<skill>/SKILL.md` and adjacent references |
| Add a new skill | A category directory, `SKILL.md`, optional `agents/openai.yaml`, and README catalog entries |
| Change lazy-workflow CLI parsing or coordination | `agent/lazy-workflow/src/cli/lazy-workflow-cli.ts` |
| Add or remove a boundary the CLI receives by constructor | `agent/lazy-workflow/src/cli/lazy-workflow-cli.ts` and `agent/lazy-workflow/test/_helpers/create-cli.ts` (the only place that knows their order) |
| Add or change a deterministic tool exposed as its own command | `agent/lazy-workflow/src/cli/tool-commands.ts` (the names), `agent/lazy-workflow/src/cli/deterministic-tools.ts` (the dispatch), and its entry in `agent/lazy-workflow/src/cli/command-catalog.ts` |
| Change what `lz catalog` describes — a command's flags, their kinds, defaults, requirements, or its effect | `agent/lazy-workflow/src/cli/command-catalog.ts` (the data) and `command-catalog-schema.ts` (the shape the GUI reads); `test/command-catalog.test.ts` pins both to the parser |
| Change the desktop GUI's views, forms, or how a form becomes a command line | `agent/lazy-workflow/gui/src/` (`src/lib/` is pure and tested from `agent/lazy-workflow/test/gui-logic.test.ts`) |
| Change how the GUI spawns or cancels `lz`, the environment it gives a run, or how it reads the run log | `agent/lazy-workflow/gui/src-tauri/src/` |
| Change the GUI settings file (`gui.json`) | `gui/src-tauri/src/settings.rs`, `gui/src/lib/backend.ts`, `utility/lz/scripts/gui-settings.ts` and `utility/lz/GUI.md`; `test/gui-settings-script.test.ts` pins the helper to the Rust fields |
| Change what the operator sees — the stamped line format, the levels, or the run panel | `agent/lazy-workflow/src/output/reporter.ts` |
| Change the run log's record contract, its path resolution, or its rotation | `agent/lazy-workflow/src/output/run-log.ts` |
| Change what a tool call reports about the artifact it touches | `agent/lazy-workflow/src/output/agent-tool-detail.ts` |
| Change Azure HU lookup or login polling | `agent/lazy-workflow/src/azure/` |
| Change GitHub queue selection, plan publication, delivery, the repository lock, or parent reconciliation | `agent/lazy-workflow/src/github/` |
| Change how SAG norms are resolved, or what infra-sag and deploy-sag verify | `agent/lazy-workflow/src/sag/` |
| Change how a multi-repository workspace is scoped, or how its checkpoint is read and written | `agent/lazy-workflow/src/workspace/` |
| Change how a delivered ticket branch is cleaned up | `agent/lazy-workflow/src/git/` |
| Change the tracker-neutral `pr-*` contract or which tracker an `origin` names | `agent/lazy-workflow/src/pull-request/` (each tracker's adapter stays in `src/github/` or `src/azure/`) |
| Change the coding agent seam — its options, authority, session errors, or the normalized result and its JSONL decoding | `agent/lazy-workflow/src/coding-agent/` |
| Change how OpenCode is invoked, streamed, or its sessions closed | `agent/lazy-workflow/src/opencode/` |
| Change how Claude Code is invoked, streamed, or its stream decoded | `agent/lazy-workflow/src/claude-code/` |
| Change how Codex is invoked, streamed, or its stream decoded | `agent/lazy-workflow/src/codex/` |
| Change which CLI a `--cli` value resolves to | `agent/lazy-workflow/src/coding-agent/create-coding-agent.ts` |
| Change the CLI names, their binaries, or how a checkpoint records its session owner | `agent/lazy-workflow/src/coding-agent/agent-cli.ts` and the checkpoint module of that workflow |
| Change what the coding agent is told for a run | `agent/lazy-workflow/src/prompts/workflow-prompt.ts` and the assets in `agent/lazy-workflow/prompts/` |
| Change how the operator answers a planning interview, or add a channel | `agent/lazy-workflow/src/interaction/` |
| Change a marker or the completion-manifest contract | `agent/lazy-workflow/src/prompts/workflow-contract.ts` (the only definition; prompt assets use `{{PLACEHOLDER}}`) |
| Change the shape of the plan a session returns behind `PLAN_READY`, or the order it is published in | `agent/lazy-workflow/src/prompts/plan-contract.ts` (shared by both trackers) |
| Change what a run is permitted to execute with OpenCode | `agent/lazy-workflow/opencode/authority.json` |
| Change what a run is permitted to execute with Claude Code | `agent/lazy-workflow/claudecode/<profile>.json` |
| Change what a run is permitted to execute with Codex | `agent/lazy-workflow/codex/<profile>.rules` and `agent/lazy-workflow/src/prompts/codex-authority-home.ts` |
| Change which profile a run gets, or where each CLI reads its authority | `agent/lazy-workflow/src/prompts/authority-profile.ts` |
| Change how a run powers the machine down when it ends (`--off`) | `agent/lazy-workflow/src/system/shutdown-service.ts` |
| Change the executable entrypoint | `agent/lazy-workflow/main.ts` |
| Change installation, destinations, cache swap, links or Windows managed copies | `installer/install.ts`, `installer/options.ts`, and `installer/install.test.ts` |
| Change GUI build, installation, stamp or removal | `installer/gui.ts` and `installer/install.test.ts` |
| Change installer bootstrap acquisition or argument delegation | `install.sh`, `install.ps1`, and `tests/install_test.sh` |
| Change the GUI launch or self-update boundary | `agent/lazy-workflow/src/system/gui-launcher.ts`, `self-update.ts`, and the CLI constructor/helper |
| Change user-facing orientation | `README.md`, `agent/lazy-workflow/README.md`, and `agent/lazy-workflow/gui/README.md` |
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
bun test installer
bash tests/install_test.sh
BASH_BIN=zsh bash tests/install_test.sh
git diff --check
```

When the GUI or its build/installation changes, also run:

```bash
(cd agent/lazy-workflow/gui && bun install && bun run typecheck)
(cd agent/lazy-workflow/gui/src-tauri && cargo test && cargo clippy --all-targets)
```

For installer changes, also exercise the bootstrap and GUI install/launch, unchanged-tree
skip and uninstall in a temporary HOME. Keep CARGO_HOME and RUSTUP_HOME pointed
at the real toolchain, and leave the real installation untouched.

Do not use real credentials or a live backlog in automated tests.

## Adding another autonomous agent

Adding another agent requires explicit repository-level approval. Give it an
isolated directory, contract, executable entrypoint, tests, installer
discovery coverage, README entry, and a documented authorization boundary.
