<img width="1280" height="640" alt="banner" src="https://github.com/user-attachments/assets/3a8a2e6d-a721-4aed-af24-6e3f159a0461" />

# agent-workflow

Reusable AI-agent workflows for software engineering: **21 prompt-driven
skills** and one executable agent,
[`lazy-workflow`](agent/lazy-workflow/README.md).

Skills describe a process that an AI session follows. The agent is an
executable workflow that drives a coding agent CLI — OpenCode by default, with
Claude Code and Codex selectable — over GitHub by default and over explicit
Azure DevOps HU runs.

## Install

Install Git and Bun first. The installer refreshes its managed cache and
reconciles repository-owned entries while preserving files owned by other tools.
Bash and Zsh use `install.sh`; PowerShell uses `install.ps1` with the same flags:

```bash
curl -fsSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh \
  | bash -s -- --all-global
```

```zsh
curl -fsSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh \
  | zsh -s -- --all-global
```

```powershell
$installer = Join-Path $env:TEMP 'agent-workflow-install.ps1'
Invoke-WebRequest https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer --all-global
```

Narrower modes include `--claude-global`, `--global`, `--local`,
`--opencode`, and `--both`. Use `--target <directory>` for local modes
and run `./install.sh --help` or `./install.ps1 --help` for the complete option list.

With `--all-global` or `--claude-global`, the executable launcher is installed
at `~/.local/bin/lazy-workflow` on Unix and `~/.local/bin/lazy-workflow.cmd`
on Windows. Windows also gets `lazy-workflow-powershell.ps1` for prompts with
quotes or multiple lines; run it from PowerShell with a script execution policy
that permits local scripts. The installer prepares its locked Bun dependencies in the managed
cache before exposing the launcher. Ensure `~/.local/bin` is in `PATH`, then run:

```bash
lazy-workflow plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
lazy-workflow plan --normas-sag --working-directory /path/to/repository
lazy-workflow code --working-directory /path/to/repository
lazy-workflow plan --hu 23438 --working-directory /path/to/repository
lazy-workflow code --hu 23438 --base-branch main --working-directory /path/to/repository
lazy-workflow hu-info --hu 23438
lazy-workflow hu-children-info --hu 23438
lazy-workflow hu-branch-info --hu 23438
lazy-workflow hu-branch-set --hu 23438 --branch feature/hu-23438 --working-directory /path/to/repository
lazy-workflow ticket-info --hu 23438 --ticket 23459
lazy-workflow ticket-state-info --ticket 23459
lazy-workflow ticket-branch-info --hu 23438 --ticket 23459
lazy-workflow ticket-create --hu 23438 --type Task --title "Slice uno" --description-file ./description.html
lazy-workflow ticket-branch-set --hu 23438 --ticket 23459 --branch feature/hu-23459 --working-directory /path/to/repository
lazy-workflow ticket-completion-apply --hu 23438 --ticket 23459 --pr 987 --summary "Lo que dejó la sesión"
lazy-workflow github-issue-list --working-directory /path/to/repository
lazy-workflow github-issue-select --working-directory /path/to/repository
lazy-workflow github-branch-prepare --issue 201 --working-directory /path/to/repository
lazy-workflow github-pr-create --issue 201 --branch issue/201 --base-branch main --commit <sha> --working-directory /path/to/repository
lazy-workflow git-branch-delete --branch issue/201 --base-branch main --working-directory /path/to/repository
lazy-workflow credentials-list
lazy-workflow credentials-get --name OPENAI_API_KEY
lazy-workflow credentials-set --name OPENAI_API_KEY
lazy-workflow credentials-update
lazy-workflow update
```

Every deterministic operation the workflows perform against Azure Boards,
GitHub or git is also a command of its own: it opens no session, prints what
its adapter answered as JSON — except the credential reads, which print one
name or value per line so they feed the shell — and shares the adapter the
workflow uses, so it validates identically (see
[Deterministic tools as commands](agent/lazy-workflow/README.md#deterministic-tools-as-commands)
and [ADR-0026](docs/adr/0026-run-deterministic-tools-as-standalone-commands.md)).

`update` reinstalls the tool by running the repository's platform installer with the
arguments declared after it, and with `--all-global` when none is declared. The
`credentials-*` commands keep the operator's own secrets usable from the
terminal: `credentials-list` and `credentials-get` read the encrypted
`~/.config/secrets/*.env` files, `credentials-set` stores or rotates one value
from a hidden prompt, and `credentials-update` pulls what another machine
published.

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
| Utility | `caveman`, `credentials`, `grilling`, `lazy-workflow`, `ponytail`, `setup-elvis-brevi-skills`, `write-a-skill` | Communication, credentials, interviewing, running the agent, setup, or skill authoring |

Skills with `disable-model-invocation: true` are explicit-only. See each
`SKILL.md` for its trigger and output contract.

## Agent

| Agent | Purpose | Source |
|---|---|---|
| `lazy-workflow` | Runs GitHub workflows by default and explicit Azure HU workflows | [`agent/lazy-workflow/`](agent/lazy-workflow/) |

The `lazy-workflow` skill turns an intent — "plan and then code this HU with the
SAG norms and my own prompt", "why did the queue stop" — into the exact command
line, and knows when a deterministic tool answers it without opening a session.

Install dependencies and run it from its directory:

```bash
cd agent/lazy-workflow
bun install
bun run main.ts plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
```

Omitting `--hu` selects the GitHub-only default prompt and never uses Azure
tools. `code` delivers each eligible GitHub issue in its own fresh selected-CLI
session and re-selects the next until the queue is empty or blocked; the
coordinator emits `TICKET_COMPLETED` and
`WORKFLOW_STEP_FINISHED` only after each verified delivery. Add `--hu <ID>` to select
the existing Azure planning or delivery workflow.

If a canonical GitHub PR conflicts with its base, `code` fixes the exact base
commit and starts a conflict-only session on the selected CLI for the same Issue,
branch and PR. It accepts the result only when the reconciled commit keeps both
the original implementation and the fixed base as ancestors; an interruption
keeps that unit's checkpoint, so rerunning finishes it instead of selecting
another Issue.

Sessions run with OpenCode by default. Add `--cli claudecode` or `--cli codex` to
execute the same workflow with another coding agent:

```bash
bun run main.ts plan --cli claudecode --model claude-opus-5 --variant high --working-directory /path/to/repository
bun run main.ts plan --cli codex --model gpt-5.6-sol --variant high --working-directory /path/to/repository
```

`--variant` is the effort level of the selected CLI (`low`, `medium`, `high`,
`xhigh`, or `max` for Claude Code; Codex also accepts `none` and `minimal`), and
naming a `--cli` verifies its binary — `opencode`, `claude`, or `codex` — while
the arguments are parsed. The model defaults are `opencode-go/deepseek-v4-pro`,
`claude-sonnet-5`, and `gpt-5.6-sol` respectively. Omitting `--cli` keeps the
OpenCode behavior unchanged.

`plan` and `code` accept `--cli`, and each run resolves it once:

```bash
bun run main.ts code --cli claudecode --model claude-opus-5 --working-directory /path/to/repository
bun run main.ts code --cli codex --model gpt-5.6-sol --working-directory /path/to/repository
```

Each workflow keeps its own rules whichever CLI runs it: a planning session
publishes nothing — the coordinator creates the issues or work items from the
plan it returns — and a delivery session is verified with git before the
coordinator touches the remote.

A long run can survive its account running out or a session going silent by
declaring an ordered fallback chain with a repeatable
`--fallback <cli>:<model>:<variant>`:

```bash
bun run main.ts code --working-directory /path/to/repository \
  --model opencode-go/deepseek-v4-pro --variant high \
  --fallback claudecode:claude-opus-5:high
```

A chain may also reach the same model through a second account. Sonnet 5 at high
effort on a Claude Code subscription, backed by the identical model billed to a
GitHub Copilot seat through OpenCode, keeps the model and only changes who pays
for it when the first account runs out:

```bash
bun run main.ts code --working-directory /path/to/repository \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high
```

Declaration order is the descent order, and every rung's binary is verified
while the arguments are parsed. Two causes descend the chain: the provider
saying the account is exhausted — usage or rate limit, quota, billing, or
authentication — and a session silent past `--idle-timeout` minutes (30 by
default); a session that fails its task never does. Every descent opens a fresh
session on the next rung, which receives the coordinator's prompt plus the
commits the branch already carries and the outgoing session's last reasoning, so
a run can finish the same issue in another CLI without reimplementing what is
already committed. The descent lasts only for the unit in progress: the next
one starts again on the primary rung.

When every rung is exhausted by the provider, the run waits `--fallback-wait`
seconds (default `300`) and retries from the primary rung, up to
`--fallback-wait-max` seconds (default `3600`), reporting the time left until
the bound on each wait. Once the bound is spent — wall clock from the first
wait, retries included — it fails closed with the checkpoint intact. A chain
exhausted by silence does not wait: a prompt that hung every rung would hang the
retry too, so the unit fails and the drain continues. The full walkthrough is in
[`agent/lazy-workflow/README.md`](agent/lazy-workflow/README.md#fallback-chain),
and a runnable example of every lazy-workflow command is in
[Practical examples](agent/lazy-workflow/README.md#practical-examples).

Any command can also power the machine down when it ends, with a global
`--off '<sudo password>'` (`-off` works too), so an overnight run does not leave
the machine awake until morning:

```bash
bun run main.ts code --off 'MiPassword123' --working-directory /path/to/repository
```

The run shuts down whatever its outcome, except when it died on an argument
error — there the operator is still at the keyboard. The shutdown announces
itself and waits `--off-delay` seconds (15 by default) first, so Ctrl-C cancels
it. The password reaches `sudo -S shutdown -h now` through stdin, and
`LAZY_WORKFLOW_OFF_PASSWORD` keeps it out of `ps` and the shell history
altogether: with that variable set, `--off` takes no value. The details are in
[Unattended shutdown](agent/lazy-workflow/README.md#unattended-shutdown).
On Windows, use `--off` without a password; it runs `shutdown.exe /s /t 0`.

Add `--normas-sag` to `plan` or `code` to load the norms of the component
declared in the selected repository's `.sag/config.json` — `tipo` must be
`api`, `bff`, or `nextjs` — from the remote repository named by
`LAZY_WORKFLOW_SAG_NORMS_REPOSITORY`. The prompt hands the session the normative
file paths that follow from that component and phase; the session reads the
files itself. Missing or unreadable SAG context stops before a session opens;
plain `plan` and `code` never read SAG sources.

Azure delivery tickets can be inspected without opening a session. Use
`ticket-info --hu <HU> --ticket <ticket>` for the aggregate normalized record,
or the focused `ticket-description-info`, `ticket-state-info` and
`ticket-effort-info` commands with `--ticket`. Branch, pull-request, and
completion reads also require `--hu`, so the direct delivery relationship and
the integration branch are validated.

To drain the HU's direct delivery tickets one at a time (Azure commands read the
organization from `LAZY_WORKFLOW_AZURE_ORGANIZATION`,
`https://dev.azure.com/<organization>`):

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
session. A session removed with `opencode session delete` cannot be recovered
this way.

Recovery first reacquires and verifies the HU's native integration-branch link
before rebuilding the pinned ticket context. Stable missing or conflicting
branch state stops once and preserves the checkpoint; rerun the same command
after correcting the reported Azure state.

To query HU data without opening a session:

```bash
bun run main.ts hu-info --hu 23438
```

To query its native integration branch without opening a session or mutating
Git or Azure:

```bash
bun run main.ts hu-branch-info --hu 23438
```

To assign an existing remote Azure branch to the HU without opening a session
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
