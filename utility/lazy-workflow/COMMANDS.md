# Command catalog

Every command, its required arguments, and what it costs. Inside
`agent/lazy-workflow/` the globally installed `lazy-workflow <command>` and
`bun run main.ts <command>` are interchangeable.

`lazy-workflow` with no subcommand — or with an unsupported one — prints the
complete help, which is the authority when this file and the binary disagree.

## Session commands

These open one coding-agent session and accept the agent flags (`--cli`,
`--model`, `--variant`, `--fallback`, `--fallback-wait`, `--fallback-wait-max`,
`--prompt`, `--session`) and the reporter flags.

| Command | Required | Optional highlights |
|---|---|---|
| `plan` | — (GitHub scope) | `--prompt`, `--number-of-questions`, `--interview*`, `--normas-sag`, `--working-directory` |
| `plan --hu <id>` | `--hu` | same as above; publishes the plan's work items in dependency order |
| `code` | — (GitHub scope) | `--normas-sag`, `--working-directory`, `--session` |
| `code --hu <id>` | `--hu` | `--base-branch` (first delivery only), `--ticket` (workspace runs), `--normas-sag` |
| `code --session <id> --prompt continue` | `--session` | `--model`, `--variant` to continue on another rung |
| `architecture-review-sag` | exactly one of `--hu` / `--issue` | `--cli`; runs under `lazy-review`, cannot modify the reviewed tree |

`infra-sag` and `deploy-sag` are listed with the session commands in the help but
verify and deploy through their own adapters without opening a session:

| Command | Required | Notes |
|---|---|---|
| `infra-sag` | exactly one of `--hu` / `--issue` | read-only; rejects any flag outside its own set |
| `deploy-sag` | exactly one of `--hu` / `--issue` | `--environment dev\|test\|qa` (default `dev`); PROD fails closed |

All three SAG workflows always load SAG norms and require `.sag/config.json`
with an explicit `tipo` of `api`, `bff`, or `nextjs`. They reject `--session`,
`--branch` and `--base-branch`.

## Scope and context flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--hu <id>` | `plan`, `code`, SAG | Azure HU scope; without it the run is GitHub-only |
| `--issue <id>` | SAG only | The explicit tracker item under review/verification/deployment |
| `--ticket <id>` | Azure `code` (workspace), `ticket-*` | The delivery work item |
| `--branch`, `--base-branch` | Azure flows only | Rejected in GitHub scope |
| `--normas-sag` | `plan`, `code` | Loads phase-appropriate norms from the canonical SAG `master` |
| `--working-directory <path[,path...]>` | all | Defaults to cwd; a CSV makes it a workspace run (`plan`/`code` only) |
| `--environment <dev\|test\|qa>` | `deploy-sag` | Default `dev` |

## Agent flags

| Flag | Default | Meaning |
|---|---|---|
| `--cli <opencode\|claudecode>` | `opencode` | Binary verified while parsing when supplied |
| `--model <id>` | `opencode-go/deepseek-v4-pro` | Written exactly as the selected CLI exposes it |
| `--variant <effort>` | `high` | Claude Code accepts `low\|medium\|high\|xhigh\|max` |
| `--fallback <cli>:<model>:<variant>` | — | Repeatable; declaration order is descent order |
| `--fallback-wait <s>` | `300` | Interval between retries once the chain is exhausted |
| `--fallback-wait-max <s>` | `3600` | Wall-clock bound of the wait-and-retry cycle |
| `--prompt <text>` | a fixed default | Supplemental operator request, never authoritative |
| `--session <id>` | — | Resume the preserved session recorded in the checkpoint |

The chain descends only on provider exhaustion — usage or rate limit, quota,
billing, authentication (ADR-0024). A session that fails its task never descends.
A backup on the same CLI resumes the session; a backup on another CLI hands the
same fixed unit of work to a fresh session with the progress verified on disk
(ADR-0025). The descent is sticky for the unit in progress only.

## Planning interview flags (`plan` only)

| Flag | Default | Meaning |
|---|---|---|
| `--interview <off\|http\|terminal\|file>` | `off` | Who answers the clarifying questions |
| `--interview-timeout <s>` | `900` | Per round; once spent the session's recommendations are taken |
| `--interview-rounds <n>` | `8` | Bound on round trips |
| `--interview-host <host>` | `127.0.0.1` | `http` only |
| `--interview-port <n>` | `0` (ephemeral) | `http` only |
| `--interview-dir <path>` | — | `file` only, and required for it |

`--number-of-questions` (default `5`) is the budget for the whole interview.
Rejected together with `--quiet`.

## Reporter flags

`--verbose` (adds reasoning and tool calls), `--verbose-output` (adds every tool
input/output and the raw event; implies `--verbose`), `--quiet` (errors only),
`--no-color`. `--verbose` and `--quiet` are mutually exclusive.

## Azure reads (no session)

```bash
lazy-workflow hu-info --hu <id>
lazy-workflow hu-children-info --hu <id>
lazy-workflow hu-branch-info --hu <id>
lazy-workflow ticket-info --hu <id> --ticket <id>
lazy-workflow ticket-type-info --ticket <id>
lazy-workflow ticket-{description,state,effort,attachment,evidence}-info --ticket <id>
lazy-workflow ticket-{branch,pr,completion}-info --hu <id> --ticket <id>
```

## Azure writes (no session)

```bash
lazy-workflow hu-branch-set --hu <id> --branch <name> [--base-branch <name>] --working-directory <path>
lazy-workflow hu-branch-ensure --hu <id> [--base-branch <name>] --working-directory <path>
lazy-workflow hu-state-set --hu <id> --state <state> --expected-state <state> --expected-rev <rev>
lazy-workflow ticket-create --hu <id> --type <Task|Bug> --title <t> --description-file <path> \
  [--estimate <hours>] [--assignee <identity>] [--field <referenceName>=<value>]
lazy-workflow ticket-link-parent --parent <id> --child <id>
lazy-workflow ticket-link-predecessor --blocker <id> --blocked <id>
lazy-workflow ticket-description-set --ticket <id> --description-file <path>
lazy-workflow ticket-state-set --ticket <id> --state <state> --expected-state <state>
lazy-workflow ticket-effort-set --ticket <id> --real-effort <h> --real-effort-hh <h> --expected-rev <rev>
lazy-workflow ticket-branch-set --hu <id> --ticket <id> --branch <name> --working-directory <path>
lazy-workflow ticket-branch-checkout --branch <name> --working-directory <path>
lazy-workflow ticket-branch-push --branch <name> --working-directory <path>
lazy-workflow ticket-pr-create --hu <id> --ticket <id>
lazy-workflow ticket-pr-link --hu <id> --ticket <id> --pr <id>
lazy-workflow ticket-commit-link --ticket <id> --pr <id>
lazy-workflow ticket-attachment-add --ticket <id> --file <path> --kind <http-json|screen|command-output>
lazy-workflow ticket-evidence-set --ticket <id> --evidence-file <path>
lazy-workflow ticket-completion-apply --hu <id> --ticket <id> --pr <id> --manifest <path>
```

`--field` is repeatable and takes Azure **reference names**, never display
labels (ADR-0006). `--file`/`--kind` accept `--evidence-file`/`--evidence-kind`
as aliases. `ticket-state-set` and `ticket-effort-set` are optimistic writes:
supply the `--expected-state` / `--expected-rev` you just read, so a ticket that
moved underneath you fails instead of being overwritten. `Done` is not reachable
from `ticket-state-set`.

## GitHub tools (no session)

```bash
lazy-workflow github-auth-info    --working-directory <path>
lazy-workflow github-repo-info    --working-directory <path>
lazy-workflow github-issue-list   --working-directory <path>
lazy-workflow github-issue-select --working-directory <path>
lazy-workflow github-issue-info    --issue <id> --working-directory <path>
lazy-workflow github-issue-claim   --issue <id> --working-directory <path>
lazy-workflow github-issue-release --issue <id> --working-directory <path>
lazy-workflow github-issue-close   --issue <id> --pr <id> --commit <sha> --working-directory <path>
lazy-workflow github-branch-prepare  --issue <id> --working-directory <path>
lazy-workflow github-branch-checkout --branch <name> --base-branch <name> --working-directory <path>
lazy-workflow github-branch-verify   --branch <name> --base-branch <name> --working-directory <path>
lazy-workflow github-branch-cleanup  --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lazy-workflow github-manifest-info --manifest <path> --working-directory <path>
lazy-workflow github-commit-push   --branch <name> --commit <sha> --working-directory <path>
lazy-workflow github-pr-create --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lazy-workflow github-pr-merge  --pr <id> --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
```

## git tools (no session)

```bash
lazy-workflow git-branch-delete --branch <name> --base-branch <name> [--commit <sha>] --working-directory <path>
```

`--branch` and `--base-branch` accept the short name (`issue/201`) or the full
ref (`refs/heads/issue/201`). `--commit` requires the full object name, because
every tool that takes one compares it against a ref. Tool commands open no
session, so `--cli`, `--model`, `--variant` and `--fallback` do not apply.

## Authority per run

| Profile | Used by | Denies |
|---|---|---|
| `lazy-github-plan` | `plan` without `--hu` | pushes, branch/remote mutation, `gh pr`/`gh repo`/`gh api`, all `az` |
| `lazy-github-code` | `code` without `--hu` | the above plus every `gh issue` mutation |
| `lazy-azure-plan` | `plan --hu` | pushes, branch/remote mutation, all `az` and all `gh` |
| `lazy-azure-code` | `code --hu` | the above; the coordinator owns every Azure and remote effect |
| `lazy-review` | `architecture-review-sag` | edits, and every mutating `git`, `gh` and `az` command |

A denied command fails as a permission error, and compound commands are matched
per sub-command. This is why a `--prompt` may not ask the session to read the
tracker itself — materialize what it needs with a tool command first.
