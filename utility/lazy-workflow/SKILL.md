---
name: lazy-workflow
description: Turn an operator intent — "run the HU with plan and then code, with SAG norms and a custom prompt", "why did the queue stop", "how do I resume this session" — into the exact lazy-workflow command line, or into the deterministic tool command that answers it without opening a session. Use when the user mentions lazy-workflow, autoplan/autocode, an Azure HU or ticket run, GitHub issue draining, `--normas-sag`, `--hu`, `--interview`, a fallback chain, or asks which lazy-workflow command or tool applies to their case.
---

# Running lazy-workflow

`lazy-workflow` is the executable agent in [`agent/lazy-workflow/`](../../agent/lazy-workflow/README.md).
Answering "how do I run it for X" means composing one command line per run — never a
paragraph of prose, never a made-up flag. A wrong flag is caught at parse time; a
wrong *command* spends a session.

## Resolve four things, in this order

1. **Does this need a session at all?** Every effect the workflow has on Azure
   Boards, GitHub or git is also its own command that opens no session, prints
   JSON, and validates identically (ADR-0026). Reads, branch links, ticket
   fields, PR and queue inspection are tool commands — see
   [Tool commands](#tool-commands-no-session). Only implementing, planning and
   architecture review need a session.
2. **The scope.** No `--hu` → GitHub scope (the default). `--hu <id>` → Azure HU
   scope. The three SAG workflows take exactly one of `--hu` or `--issue`.
   Scope decides the prompt, the authority profile, and which flags are legal.
3. **The phase.** `plan` maps and publishes work; `code` delivers it;
   `architecture-review-sag`, `infra-sag`, `deploy-sag` are the SAG-scoped ones.
   Phases are separate runs — see [Plan then code](#plan-then-code).
4. **The rung.** `--cli` (`opencode` default, or `claudecode`), `--model`,
   `--variant`, and optionally a `--fallback` chain. Only add these when the user
   asked for a specific model, account, or backup.

Then compose in a fixed order, so two commands are comparable at a glance:

```bash
lazy-workflow <command> <scope> <context> <agent> <reporter>
#             code       --hu 23438 --normas-sag --working-directory /repo --cli claudecode --verbose
```

`--working-directory` defaults to the current directory and is worth stating
explicitly in every answer. A comma-separated list makes it a multi-repository
workspace run (`plan` and `code` only); declared order is delivery order.

Full catalog: [COMMANDS.md](COMMANDS.md). Runnable end-to-end intents:
[RECIPES.md](RECIPES.md). A run that failed: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Plan then code

They are two runs, never one command, and nothing is implicit between them:

```bash
lazy-workflow plan --hu 23438 --working-directory /repo   # returns a plan, publishes the work items
lazy-workflow code --hu 23438 --working-directory /repo   # drains the published Task/Bug tickets
```

`plan` writes no checkpoint and mutates no branch. `code` drains one unit of work
per fresh session and re-selects the next until the queue is empty or blocked.
Between them, verify what `plan` published with `hu-children-info` (Azure) or
`github-issue-list` (GitHub) before spending a delivery run.

`code --hu` needs `--base-branch <name>` **only** the first time, when the HU has
no branch link and `hu/<HU>` does not exist yet. Check first with
`hu-branch-info --hu <id>`: a `null` branch means `--base-branch` is required.

## A custom prompt is supplemental, never authoritative

`--prompt` is injected as the *operator request*; the workflow prompt,
the coordinator-fixed identities (issue, HU, ticket, branch, manifest path) and
the SAG context outrank it. Consequences worth stating when answering:

- Norms come from `--normas-sag`, not from prose. Asking for "the SAG norms" in
  `--prompt` loads nothing.
- The session cannot read another HU or issue by itself: the Azure profiles deny
  every `az` and `gh` command, and the GitHub profiles deny `az`, `gh pr`,
  `gh api` and `gh repo`. To use another HU as a **reference**, materialize it
  first with a tool command and point `--prompt` at the file:

  ```bash
  lazy-workflow hu-info --hu 23300 > /tmp/hu-23300.json
  lazy-workflow hu-children-info --hu 23300 >> /tmp/hu-23300.json
  lazy-workflow plan --hu 23438 --normas-sag \
    --prompt "Slice HU 23438 with the same ticket shape as the reference in /tmp/hu-23300.json; read that file first." \
    --working-directory /repo
  ```

- `--prompt continue` is the recovery idiom, paired with `--session <id>`.

## Tool commands (no session)

Reach for these before proposing a session — they are the workflow's own steps,
they cost nothing, and their JSON is the evidence for the next decision.

| The user wants to know | Command |
|---|---|
| What the HU is, its children, its branch link | `hu-info`, `hu-children-info`, `hu-branch-info` |
| Everything about one ticket, or one facet | `ticket-info --hu --ticket`; `ticket-{description,state,effort,attachment,evidence}-info --ticket` |
| Why a ticket is not `Done` | `ticket-completion-info --hu --ticket` (prints the unmet gates) |
| What a `code` run would take next, and why it skips the rest | `github-issue-list`, `github-issue-select`, `github-issue-info --issue` |
| Whether the environment can run at all | `github-auth-info`, `github-repo-info` |
| To fix a branch link by hand | `hu-branch-set`, `hu-branch-ensure`, `ticket-branch-set` |
| To publish tickets without planning | `ticket-create`, `ticket-link-parent`, `ticket-link-predecessor` |
| To repair a stalled delivery step | `github-branch-prepare`, `github-pr-create`, `github-pr-merge`, `github-issue-close`, `ticket-completion-apply` |

Writes that move a ticket are optimistic and need the state you read:
`ticket-state-set --expected-state`, `ticket-effort-set --expected-rev`. `Done` is
never reachable from `ticket-state-set` — only the coordinator applies it, after
verifying every gate.

## Guardrails that reject a run before it starts

State these when they apply; they are argument errors, not runtime surprises.

- `--branch` and `--base-branch` are Azure-only. `--issue` is SAG-only.
  `--environment` is `deploy-sag`-only. `--normas-sag` is `plan`/`code`-only.
- The SAG workflows require exactly one of `--hu` or `--issue`, and take no
  `--session`, `--branch` or `--base-branch`.
- `deploy-sag` accepts `dev`, `test`, `qa` only; PROD and its aliases fail closed.
- `--interview` is `plan`-only and incompatible with `--quiet`;
  `--interview-dir` is required by (and exclusive to) `--interview file`;
  `--interview-host`/`--interview-port` are `http`-only.
- `--verbose` and `--quiet` are mutually exclusive.
- With `--cli claudecode`, `--variant` must be `low|medium|high|xhigh|max`.
- `--fallback <cli>:<model>:<variant>` is repeatable; every rung's binary is
  verified while parsing, a repeated rung is an error, and
  `--fallback-wait-max` may not be smaller than `--fallback-wait`.
- Azure multi-repository `code` requires `--hu` **and** `--ticket`.
- `--commit` always takes the full object name, never an abbreviation.

## Answering

Give the command block first, then one line per non-obvious flag, then what to
check when it finishes (the marker, the published items, or the JSON to reread).
Offer the preflight tool command whenever it would change the command you just
proposed. Do not run anything against a real backlog without being asked to.
