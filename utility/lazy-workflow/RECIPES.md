# Recipes

One intent per section, stated the way an operator states it, answered with the
commands to run in order. Replace `/repo`, the HU and the issue numbers.

## "Run HU 23438: plan and then code, with the SAG norms and my own prompt"

The whole shape of the request in the order it executes.

```bash
# 1. Read the HU before planning it — no session, no cost
lazy-workflow hu-info --hu 23438
lazy-workflow hu-children-info --hu 23438

# 2. Plan: the session slices the HU, the coordinator publishes the work items
lazy-workflow plan --hu 23438 --normas-sag \
  --prompt "Prioritize the read paths before the write paths; keep ticket titles in Spanish." \
  --working-directory /repo

# 3. Confirm what was published before spending a delivery run
lazy-workflow hu-children-info --hu 23438

# 4. Is there an HU branch? A null link means step 5 needs --base-branch
lazy-workflow hu-branch-info --hu 23438

# 5. Deliver the published Task and Bug tickets, one fresh session each
lazy-workflow code --hu 23438 --normas-sag --base-branch main \
  --prompt "Cover every acceptance criterion with a test before closing the ticket." \
  --working-directory /repo
```

Drop `--base-branch` once `hu/23438` exists or the HU is already linked. Drop
`--normas-sag` on either run to keep that phase away from SAG sources entirely —
it is opt-in per run, and `plan --normas-sag` does not imply `code --normas-sag`.

## "…taking HU 23300 as the reference"

The planning session cannot read Azure — `lazy-azure-plan` denies `az` and `gh`.
Materialize the reference first, then point the prompt at the file:

```bash
lazy-workflow hu-info --hu 23300 > /tmp/ref-23300.json
lazy-workflow hu-children-info --hu 23300 >> /tmp/ref-23300.json

lazy-workflow plan --hu 23438 --normas-sag \
  --prompt "Read /tmp/ref-23300.json first: it is HU 23300 and its published tickets. Slice HU 23438 with the same granularity, ticket titles and estimate scale." \
  --working-directory /repo
```

The same holds in GitHub scope for another issue: capture it with
`github-issue-info --issue <id> > /tmp/ref.json` and reference the path.

## "Let me answer the planning questions myself"

```bash
lazy-workflow plan --hu 23438 --interview terminal --working-directory /repo   # in this terminal
lazy-workflow plan --interview http --working-directory /repo                  # in a browser page it opens
lazy-workflow plan --interview file --interview-dir /tmp/entrevista --working-directory /repo  # via JSON files
```

`--number-of-questions 8` widens the budget for the whole interview.
`--interview` is `plan`-only and cannot be combined with `--quiet`.

## "Drain the GitHub backlog of this repository"

```bash
lazy-workflow github-auth-info  --working-directory /repo   # can it reach GitHub at all
lazy-workflow github-issue-list --working-directory /repo   # what is eligible, and why the rest is skipped
lazy-workflow code --working-directory /repo                # deliver them, one fresh session each
```

`code` re-selects the next eligible issue after every verified delivery until the
queue is empty or blocked. `plan` in this scope maps the requested work without
touching branches or tracker state.

## "Resume the run that was interrupted"

The HU or issue, the ticket and the branch come from the checkpoint, so no
`--hu` and no `--working-directory` are needed:

```bash
lazy-workflow code --session <session-id> --prompt continue
lazy-workflow code --session <session-id> --model claude-sonnet-5 --variant high --prompt continue
```

If the delivery already reached `IMPLEMENTATION_READY`, rerun the **original**
command instead: it resumes the coordinator phase rather than selecting
replacement work.

```bash
lazy-workflow code --hu 23438 --working-directory /repo
```

## "Keep the run alive when the account runs out"

```bash
# Same model, second account paying for it
lazy-workflow code --working-directory /repo \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high

# Several rungs; declaration order is the descent order
lazy-workflow code --working-directory /repo \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high \
  --fallback opencode:opencode-go/deepseek-v4-pro:high \
  --fallback-wait 300 --fallback-wait-max 3600
```

Write each rung's model id exactly as its own CLI exposes it. The descent lasts
only for the unit of work in progress; the next one starts at the primary rung.

## "Review the architecture / check infra / deploy"

```bash
lazy-workflow architecture-review-sag --issue 154 --working-directory /repo
lazy-workflow architecture-review-sag --hu 23438 --working-directory /repo
lazy-workflow infra-sag  --issue 155 --working-directory /repo
lazy-workflow deploy-sag --issue 157 --environment qa --working-directory /repo
```

Exactly one of `--hu` / `--issue` each, `.sag/config.json` required, and
`deploy-sag` refuses PROD and every production alias before any external effect.
A clean architecture review publishes nothing; findings become corrective
tracker work.

## "One unit of work across several repositories"

```bash
lazy-workflow plan --working-directory /repo-a,/repo-b
lazy-workflow code --working-directory /repo-a,/repo-b
lazy-workflow code --hu 23438 --ticket 51 --working-directory /repo-a,/repo-b
```

Every entry must be a Git repository root with an `origin` remote and a clean
worktree, all on the same provider, and the declared order is the delivery
order. Azure workspace `code` requires `--ticket` as well as `--hu`. Recovery
needs the exact same list, in the same order.

## "Publish tickets by hand, without planning"

```bash
lazy-workflow ticket-create --hu 23438 --type Task --title "Slice uno" \
  --description-file ./description.html --estimate 8 \
  --assignee persona@empresa.cl --field Custom.Componente=api
lazy-workflow ticket-link-parent --parent 23438 --child 23459
lazy-workflow ticket-link-predecessor --blocker 23459 --blocked 23460
```

These are the same primitives the plan publication uses, so a hand-published
ticket is indistinguishable from a planned one.

## "Show me everything the agent is doing"

```bash
lazy-workflow code --verbose        --working-directory /repo   # + reasoning and tool calls
lazy-workflow code --verbose-output --working-directory /repo   # + every tool input/output and the raw event
lazy-workflow code --quiet          --working-directory /repo   # errors only
```
