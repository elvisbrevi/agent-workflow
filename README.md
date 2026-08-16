<img width="1280" height="640" alt="banner" src="https://github.com/user-attachments/assets/3a8a2e6d-a721-4aed-af24-6e3f159a0461" />

# agent-workflow

Reusable AI-agent workflows for software engineering: **19 prompt-driven
skills** and one executable agent,
[`lazy-workflow`](agent/lazy-workflow/README.md).

Skills describe a process that an AI session follows. The agent is an
executable workflow that invokes OpenCode for GitHub by default and supports
explicit Azure DevOps HU runs.

## Install

The installer refreshes its managed cache and reconciles repository-owned
links while preserving files and links owned by other tools:

```bash
curl -fsSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh \
  | bash -s -- --all-global
```

Narrower modes include `--claude-global`, `--global`, `--local`,
`--opencode`, and `--both`. Use `--target <directory>` for local modes
and run `./install.sh --help` for the complete option list.

With `--all-global` or `--claude-global`, the executable launcher is installed
at `~/.local/bin/lazy-workflow`; the installer prepares its locked Bun
dependencies in the managed cache before exposing the launcher. Ensure
`~/.local/bin` is in `PATH`, then run:

```bash
lazy-workflow plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
lazy-workflow plan --normas-sag --working-directory /path/to/repository
lazy-workflow code --working-directory /path/to/repository
lazy-workflow infra-sag --issue 155 --working-directory /path/to/repository
lazy-workflow architecture-review-sag --issue 154 --working-directory /path/to/repository
lazy-workflow deploy-sag --issue 157 --working-directory /path/to/repository
lazy-workflow plan --hu 23438 --working-directory /path/to/repository
lazy-workflow code --hu 23438 --base-branch main --working-directory /path/to/repository
lazy-workflow hu-info --hu 23438
lazy-workflow hu-branch-info --hu 23438
lazy-workflow hu-branch-set --hu 23438 --branch feature/hu-23438 --working-directory /path/to/repository
lazy-workflow ticket-info --hu 23438 --ticket 23459
lazy-workflow ticket-state-info --ticket 23459
```

## Skills

Skills are stored as `SKILL.md` files. Invoke them explicitly with the
client syntax or let the client select them when their trigger matches.

| Phase | Skills | Use when |
|---|---|---|
| Discovery | `zoom-out` | The code or problem is unfamiliar |
| Design | `domain-modeling`, `grill-with-docs`, `prototype`, `improve-codebase-architecture` | Terms, decisions, prototypes, or structure need work |
| Planning | `wayfinder`, `to-spec`, `to-tickets`, `triage` | Work must be mapped, specified, decomposed, or classified |
| Implementation | `implement`, `tdd` | A ticket or specification is ready to build |
| Diagnosis | `diagnose` | A defect needs reproduction and a regression test |
| Review | `code-review`, `handoff` | Changes need review or session transfer |
| Utility | `caveman`, `grilling`, `ponytail`, `setup-elvis-brevi-skills`, `write-a-skill` | Communication, interviewing, setup, or skill authoring |

Skills with `disable-model-invocation: true` are explicit-only. See each
`SKILL.md` for its trigger and output contract.

## Agent

| Agent | Purpose | Source |
|---|---|---|
| `lazy-workflow` | Runs GitHub workflows by default and explicit Azure HU workflows | [`agent/lazy-workflow/`](agent/lazy-workflow/) |

Install dependencies and run it from its directory:

```bash
cd agent/lazy-workflow
bun install
bun run main.ts plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
```

Omitting `--hu` selects the GitHub-only default prompt and never uses Azure
tools. `code` delivers each eligible GitHub issue in its own fresh OpenCode
session and re-selects the next until the queue is empty or blocked; the
coordinator emits `TICKET_COMPLETED` and
`WORKFLOW_STEP_FINISHED` only after each verified delivery. Add `--hu <ID>` to select
the existing Azure planning or delivery workflow.

If a canonical GitHub PR conflicts with its base, `code` fixes the exact base
commit and starts a conflict-only OpenCode session for the same Issue, branch
and PR. It accepts the result only when the new manifest commit contains both
the original implementation and fixed base; interrupted reconciliation resumes
from its checkpoint without selecting another Issue.

Sessions run with OpenCode by default. Add `--cli claudecode` to execute the
same workflow with Claude Code instead:

```bash
bun run main.ts plan --cli claudecode --model claude-opus-5 --variant high --working-directory /path/to/repository
```

`--variant` is the effort level of the selected CLI (`low`, `medium`, `high`,
`xhigh`, or `max` for Claude Code), and naming a `--cli` verifies its binary —
`opencode` or `claude` — while the arguments are parsed. Omitting `--cli` keeps
the OpenCode behavior unchanged.

Every workflow command accepts `--cli`, including the three SAG-scoped ones, and
each run resolves it once:

```bash
bun run main.ts code --cli claudecode --model claude-opus-5 --working-directory /path/to/repository
bun run main.ts architecture-review-sag --issue 154 --cli claudecode --working-directory /path/to/repository
```

Each workflow keeps its own rules whichever CLI runs it: the review session may
not modify the reviewed tree, and `deploy-sag` still refuses PROD and its
aliases before any external effect.

A long run can survive its account running out by declaring an ordered fallback
chain with a repeatable `--fallback <cli>:<model>:<variant>`:

```bash
bun run main.ts code --working-directory /path/to/repository \
  --model opencode-go/deepseek-v4-pro --variant high \
  --fallback claudecode:claude-opus-5:high
```

Declaration order is the descent order, and every rung's binary is verified
while the arguments are parsed. Only provider exhaustion — usage or rate limit,
quota, billing, or authentication — descends the chain; a session that fails its
task never does. A backup sharing the active CLI resumes the same session with
the new model; a backup naming another CLI continues the same issue in a fresh
session that receives the coordinator's prompt plus the progress verified on
disk, so an OpenCode run can finish the same issue in Claude Code without
reimplementing what is already committed. The descent lasts only for the issue
in progress: the next one starts again on the primary rung.

With every rung exhausted, the run waits `--fallback-wait` seconds (default
`300`) and retries from the primary rung, up to `--fallback-wait-max` seconds
(default `3600`), reporting the time left until the bound on each wait. Once the
bound is spent — wall clock from the first wait, retries included — it fails
closed with the checkpoint intact. The full walkthrough
is in [`agent/lazy-workflow/README.md`](agent/lazy-workflow/README.md#fallback-chain).

Add `--normas-sag` to `plan` or `code` to load phase-appropriate norms from the
remote SAG `master` branch. The selected repository must contain an explicit
`.sag/config.json` with `tipo` set to `api`, `bff`, or `nextjs`. The prompt
records the resolved commit, source URLs, stable rule IDs, selection reasons,
and applicability facts that need a decision. Coding sessions receive common,
component, and explicit artifact/capability norms. Missing or unreadable SAG
context stops before OpenCode; plain `plan` and `code` never read SAG sources.

`deploy-sag` always loads delivery norms and requires exactly one explicit
`--issue` or `--hu`. It reads an explicit `deployment` route from
`.sag/config.json`, requires authenticated external discovery to confirm one
pipeline v7, Release Definition, repository/base branch, and the selected
DEV, TEST, or QA target, then verifies the deployment result. DEV is the
default; PROD and every production alias fail before any external mutation.
Missing authentication, ambiguous routes, or unverifiable targets fail closed.

`infra-sag` always loads infrastructure norms and requires exactly one explicit
`--issue` or `--hu`. It verifies repository/base branch, Consul variables, and
explicitly declared database, pipeline, and Release Definition prerequisites
through an authenticated read-only adapter, using traceable versioned config
and Consul contracts. Missing or unverifiable
prerequisites become corrective tracker work; the command never provisions
infrastructure.
Remote reads use the public canonical source or `AZURE_DEVOPS_EXT_PAT` when
the source requires authentication; the token is never placed in prompts or
logs.

`architecture-review-sag` always loads SAG norms and requires exactly one
explicit `--issue` or `--hu`. It reviews without changing code, keeps numbered
norms separate from procedural guidance, and publishes findings as corrective
tracker work using `/to-spec` and `/to-tickets` semantics. A clean review
publishes nothing and does not invoke deployment.

Azure delivery tickets can be inspected without starting OpenCode. Use
`ticket-info --hu <HU> --ticket <ticket>` for the aggregate normalized record,
or focused description, state, effort, attachment, and evidence commands with
`--ticket`. Branch, pull-request, and completion reads also require `--hu` so
the direct delivery relationship and integration branch are validated.

To drain the HU's direct delivery tickets one at a time:

```bash
bun run main.ts code --hu 23438 --base-branch main --working-directory /path/to/repository
```

To recover the exact interrupted ticket from its repository checkpoint:

```bash
bun run main.ts code --session <session-id> --prompt continue
```

To continue that preserved session with another model, add explicit overrides:

```bash
bun run main.ts code --session <session-id> --model openai/gpt-5.6-luna --variant high --prompt continue
```

Omitting `--model` or `--variant` leaves that setting unchanged in the existing
OpenCode session. A session removed with `opencode session delete` cannot be
recovered this way.

Recovery first reacquires and verifies the HU's native integration-branch link
before rebuilding the pinned ticket context. Stable missing or conflicting
branch state stops once and preserves the checkpoint; rerun the same command
after correcting the reported Azure state.

To query HU data without starting OpenCode:

```bash
bun run main.ts hu-info --hu 23438
```

To query its native integration branch without starting OpenCode or mutating
Git or Azure:

```bash
bun run main.ts hu-branch-info --hu 23438
```

To assign an existing remote Azure branch to the HU without starting OpenCode
(omit `--base-branch` when it already exists):

```bash
bun run main.ts hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --working-directory /path/to/repository
```

For first use, create and publish the HU branch from an explicit remote base:

```bash
bun run main.ts hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --base-branch main --working-directory /path/to/repository
```

To deliver one unit of work across several repositories, pass a comma-separated
list; the declared order is the delivery order and a single path keeps the
existing single-repository behavior:

```bash
lazy-workflow code --working-directory /path/to/repo-a,/path/to/repo-b
```

See [the agent README](agent/lazy-workflow/README.md) for behavior and
structure, including workspace state, serial execution and recovery.

## Repository documentation

- [`AGENTS.md`](AGENTS.md): modification map and validation rules.
- [`CONTEXT.md`](CONTEXT.md): domain vocabulary.
- [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md): tracker conventions.
- [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md): canonical labels.

## Tests

```bash
(cd agent/lazy-workflow && bun test)
bash tests/install_test.sh
git diff --check
```
