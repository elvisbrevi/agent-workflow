# Workflow commands and flags

The commands that open a session or drive an adapter-backed workflow, and every
flag they accept. The deterministic tools have their own file
([TOOLS.md](TOOLS.md)), and what the agent flags actually change is in
[CODING-AGENTS.md](CODING-AGENTS.md).

`lazy-workflow` with no subcommand — or with an unsupported one — prints the
complete help, which is the authority whenever this file and the binary disagree.

## The commands

| Command | Required | Opens a session | Notes |
|---|---|---|---|
| `plan` | — | yes | GitHub scope: maps the requested work, mutates nothing |
| `plan --hu <id>` | `--hu` | yes | Slices the HU; the coordinator publishes the work items in dependency order |
| `code` | — | yes, one per issue | Drains eligible GitHub issues until the queue is empty or blocked |
| `code --hu <id>` | `--hu` | yes, one per ticket | Drains the HU's direct Task and Bug tickets |
| `code --session <id> --prompt continue` | `--session` | resumes one | Identities come from the checkpoint |
| `architecture-review-sag` | exactly one of `--hu` / `--issue` | yes | Reviews without modifying the tree; publishes findings as corrective work |
| `infra-sag` | exactly one of `--hu` / `--issue` | no | Read-only prerequisite verification through its adapter |
| `deploy-sag` | exactly one of `--hu` / `--issue` | no | Deploys through its adapter; PROD fails closed |

The three SAG commands always load SAG norms and require `.sag/config.json` with
an explicit `tipo` of `api`, `bff` or `nextjs`; the component is never inferred
from source layout. They reject `--session`, `--branch` and `--base-branch`, and
`infra-sag` rejects every flag outside its own set.

`plan` and `code` accept `--normas-sag` to load phase-appropriate norms opt-in,
per run: `plan --normas-sag` does not imply `code --normas-sag`. Plain `plan` and
`code` never read SAG sources at all. Norm loading resolves a commit, stable rule
ids, source URLs and selection reasons; an unavailable source or an invalid
configuration stops the run before a session opens. If the canonical source needs
authentication, provide `AZURE_DEVOPS_EXT_PAT` — it is used only in the request
Authorization header, never persisted and never sent to the agent.

## Scope and context

| Flag | Applies to | Meaning |
|---|---|---|
| `--hu <id>` | `plan`, `code`, SAG | Azure HU scope; without it the run is GitHub-only |
| `--issue <id>` | SAG only | The explicit tracker item under review, verification or deployment |
| `--ticket <id>` | Azure workspace `code`, `ticket-*` tools | The delivery work item |
| `--branch <name>` | Azure flows | Rejected in GitHub scope |
| `--base-branch <name>` | Azure flows | Required only when creating `hu/<HU>` for the first time |
| `--normas-sag` | `plan`, `code` | Loads the SAG norms of the phase |
| `--environment <dev\|test\|qa>` | `deploy-sag` | Default `dev`; PROD and aliases fail closed |
| `--working-directory <path[,path...]>` | all | Defaults to cwd; a CSV makes it a workspace run (`plan`/`code` only) |

## Agent flags

`--cli`, `--model`, `--variant`, `--fallback`, `--fallback-wait`,
`--fallback-wait-max`, `--prompt`, `--session`. Defaults, valid values and the
behaviour behind each: [CODING-AGENTS.md](CODING-AGENTS.md).

## Planning interview (`plan` only)

| Flag | Default | Meaning |
|---|---|---|
| `--interview <off\|http\|terminal\|file>` | `off` | Who answers the clarifying questions |
| `--interview-timeout <s>` | `900` | Per round; once spent, the session's own recommendations are taken and the run continues |
| `--interview-rounds <n>` | `8` | Bound on round trips; the last round is told to deliver the plan |
| `--interview-host <host>` | `127.0.0.1` | `http` only; outside loopback the URL and its token are the only credential |
| `--interview-port <n>` | `0` (ephemeral) | `http` only, so two runs never collide |
| `--interview-dir <path>` | — | `file` only, and required for it |

A planning run answers its own questions by default — it takes the recommendation
it would have offered and continues, which is what an unattended run needs.
`--interview` makes those decisions the operator's instead (ADR-0027):

- **`http`** serves a page on loopback and prints its URL, with every
  recommendation prefilled, so submitting it unchanged equals not answering.
  Answerable from a browser or with `curl` against `<url>/round` and `<url>/answers`.
- **`terminal`** asks in the launching terminal, reading `/dev/tty`, so it still
  works when the JSON result is piped. An empty line accepts the recommendation.
- **`file`** writes `ronda-<n>.preguntas.json` and waits for
  `ronda-<n>.respuestas.json` in `--interview-dir` — the channel for any other UI,
  bot or agent, and the files remain as the record of what was decided.

`--number-of-questions <n>` (default `5`) is the budget for the whole interview,
spent across as many rounds as the session needs. An unusable channel — a taken
port, no terminal, a directory owned by another interview — stops the run before
a session opens. If a round expires or the channel disappears mid-interview, the
run reports it and continues with the recommendations rather than failing.

## Reporter

`--verbose`, `--verbose-output`, `--quiet`, `--no-color` — see
[Watching a run](CODING-AGENTS.md#watching-a-run). `--verbose` and `--quiet` are
mutually exclusive; `--verbose-output` implies `--verbose`.

## Multi-repository workspaces

```bash
lazy-workflow plan --working-directory /repo-a,/repo-b
lazy-workflow code --working-directory /repo-a,/repo-b
lazy-workflow code --hu 23438 --ticket 51 --working-directory /repo-a,/repo-b
```

Each entry must be a Git repository root with an `origin` remote and a clean
worktree; entries are canonicalised, duplicates rejected, and the declared order
is the delivery order. All repositories must belong to the same provider —
GitHub in the default scope, Azure DevOps with `--hu`, where `code` also requires
`--ticket`. A single path keeps single-repository behaviour unchanged.

One session works across the whole workspace. After `IMPLEMENTATION_READY` the
coordinator verifies every per-repository manifest and then delivers the changed
repositories one at a time in the declared order; repositories without changes
must end clean. The issue is closed — or the Azure ticket completed and the HU
moved on — only after every required unit and every tracker gate is verified.
Recovery requires the exact same normalized list, in the same order, with the
same remote identities; an added, removed, reordered or remote-changed repository
stops the run before any external effect.

## What `code` does after the session

Both scopes follow the same shape: the session implements and emits
`IMPLEMENTATION_READY`, then the coordinator validates the manifest against Git
metadata, creates or reuses exactly one pull request, associates it, merges it,
closes the issue or publishes effort and evidence and verifies every completion
gate before moving the ticket to `Done`, cleans the delivery branch, and only
then selects the next unit of work.

Two consequences worth stating when answering: a delivery that stopped after
`IMPLEMENTATION_READY` is resumed by rerunning the **original** command, not by
starting a new one; and a GitHub pull request that conflicts with its base is
reconciled by a conflict-only session for the same issue, branch and PR, accepted
only when the new manifest commit contains both the original implementation and
the fixed base.
