---
name: lazy-workflow
description: Compose and run the right lazy-workflow command — the executable agent that plans and delivers work through OpenCode or Claude Code, on GitHub issues or Azure DevOps HUs. Covers both of its layers: the deterministic tool commands that read or mutate the tracker, the branch and the pull request without opening a session, and the workflow commands that drive a coding agent (plan, code, architecture-review-sag, infra-sag, deploy-sag) with their CLI/model/effort selection, fallback chains, authority profiles, sessions and checkpoints. Use this skill whenever lazy-workflow, autoplan, autocode, `--hu`, `--normas-sag`, an Azure HU or ticket, GitHub issue draining, or an interrupted run comes up — including when the user only asks "how do I run…" or describes the task ("plan this HU and then code it") without naming a single flag.
---

# lazy-workflow

`lazy-workflow` is the executable agent of this repository
([`agent/lazy-workflow/`](../../agent/lazy-workflow/README.md)). It has two
layers, and choosing the layer is the first and cheapest decision:

- **Tools** — one deterministic operation against Azure Boards, GitHub or git.
  No session, no model, no cost. They are the same steps a workflow performs
  internally (ADR-0026), so what a tool answers is what the workflow will see.
  Use them to **decide, verify and repair**.
- **Workflows** — `plan`, `code` and the three SAG-scoped commands. Each opens a
  coding-agent session that reasons and writes code. Use them to **do the work**.

Reaching for a workflow when a tool answers the question burns a session on
something a JSON read already knew. Reaching for a tool when the work needs
judgment produces nothing. Almost every question of the form "why did it stop",
"what will it take next", "is this ticket done" is a tool question.

## Invoke it

```bash
lazy-workflow <command> [flags]     # the installed launcher (install.sh --all-global)
bun run main.ts <command> [flags]   # equivalent, from inside agent/lazy-workflow/
lazy-workflow                       # full command help — the authority on flags
```

The output contract makes this scriptable, and it is worth relying on:

- A tool command prints **one indented JSON object on stdout** and exits `0` or `1`.
- Operator output — the run panel, every stamped `dd/mm/yy HH:mm:ss` line, every
  error explanation — goes to **stderr**. So `lazy-workflow ticket-info … 2>/dev/null`
  is clean JSON, and when a command fails the reason is on stderr while stdout is empty.
- Workflow runs are long-lived: they stream to stderr and end on a marker
  (`PLAN_READY`, `IMPLEMENTATION_READY`, `TICKET_COMPLETED`…). Never poll them in a
  loop; read the marker they end on.

Before proposing a run, gather the state it depends on in one pass:

```bash
scripts/preflight.sh --working-directory /repo               # GitHub scope
scripts/preflight.sh --hu 23438 --working-directory /repo    # Azure HU scope
```

It runs only read-only tools, prints one JSON document with every probe and a
`notes` array (for example, that this HU still needs `--base-branch`), and
resolves the binary itself — `LAZY_WORKFLOW_BIN`, then the launcher on `PATH`,
then `bun` against the agent source.

## Decide in four steps

1. **Tool or workflow?** See above, then [TOOLS.md](TOOLS.md) for the catalog
   and what each one answers.
2. **Scope.** No `--hu` → GitHub (the default). `--hu <id>` → Azure HU. The SAG
   commands take exactly one of `--hu` or `--issue`. Scope decides the prompt,
   the authority profile and which flags are legal.
3. **Phase.** `plan` maps and publishes work, `code` delivers it,
   `architecture-review-sag` / `infra-sag` / `deploy-sag` are the SAG ones.
4. **Rung.** `--cli`, `--model`, `--variant`, `--fallback`. Add these only when
   the user asked for a specific model, account or backup —
   [CODING-AGENTS.md](CODING-AGENTS.md) explains what changes when they do.

Compose in a fixed order so two commands are comparable at a glance:

```bash
lazy-workflow <command> <scope> <context> <agent> <reporter>
#             code       --hu 23438 --normas-sag --working-directory /repo --cli claudecode --verbose
```

`--working-directory` defaults to the current directory; state it explicitly
anyway, because a run in the wrong repository is indistinguishable from a
correct one until it acts. A comma-separated list makes it a multi-repository
workspace run (`plan` and `code` only), and the declared order is the delivery order.

## Where to look next

| Question | File |
|---|---|
| Which tool answers this, and what does it return? | [TOOLS.md](TOOLS.md) |
| Which workflow command, and what does each flag mean? | [COMMANDS.md](COMMANDS.md) |
| Which CLI/model/effort, what the session may execute, how sessions and checkpoints behave | [CODING-AGENTS.md](CODING-AGENTS.md) |
| The whole sequence for a real intent | [RECIPES.md](RECIPES.md) |
| It failed, or stopped early | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

## Plan then code

They are two runs, never one command, and nothing passes implicitly between them:

```bash
lazy-workflow plan --hu 23438 --working-directory /repo   # returns a plan, publishes the work items
lazy-workflow code --hu 23438 --working-directory /repo   # drains the published Task/Bug tickets
```

`plan` writes no checkpoint and mutates no branch, so it is the safe half. `code`
delivers one unit of work per fresh session and re-selects the next until the
queue is empty or blocked. Between them, read what `plan` actually published
(`hu-children-info`, or `github-issue-list`) — a plan that published nothing
turns the delivery run into an expensive no-op.

`code --hu` needs `--base-branch <name>` **only** on the first delivery, when the
HU has no branch link and `hu/<HU>` does not exist. `hu-branch-info --hu <id>`
answers that: a `"branch": null` means the flag is required.

## The operator prompt is supplemental

`--prompt` enters the session as the *operator request*, and the workflow prompt,
the coordinator-fixed identities (issue, HU, ticket, branch, manifest path) and
the SAG context all outrank it. The manifest at that path is written by
`ticket-manifest-set` / `github-manifest-set` (see `TOOLS.md`) and never by hand,
so `--prompt` has nothing useful to say about its shape. Two further consequences
change what you can promise:

- Norms load with `--normas-sag`, never from prose. Asking for "the SAG norms"
  inside `--prompt` loads nothing at all.
- The session cannot read the tracker itself — the authority profiles deny `az`
  and `gh` to Azure runs, and `gh pr`/`gh api`/`gh repo`/`az` to GitHub runs. So a
  reference ("use HU 23300 as the model") has to be materialized first:

  ```bash
  lazy-workflow hu-info --hu 23300 > /tmp/ref-23300.json
  lazy-workflow plan --hu 23438 --normas-sag \
    --prompt "Read /tmp/ref-23300.json first: it is the reference HU. Slice 23438 with the same granularity." \
    --working-directory /repo
  ```

`--prompt continue` is the recovery idiom, always paired with `--session <id>`.

## Guardrails that reject a run before it starts

These are argument errors, caught while parsing — mention them when they apply,
because they cost nothing to avoid and a full error message to discover.

- `--branch` / `--base-branch` are Azure-only; `--issue` is SAG-only;
  `--environment` is `deploy-sag`-only; `--normas-sag` is `plan`/`code`-only.
- The SAG commands need exactly one of `--hu` / `--issue`, and reject
  `--session`, `--branch` and `--base-branch`.
- `deploy-sag` accepts `dev`, `test`, `qa`; PROD and every alias fail closed.
- `--interview` is `plan`-only and incompatible with `--quiet`; `--interview-dir`
  belongs to (and is required by) `--interview file`; `--interview-host` and
  `--interview-port` are `http`-only.
- `--verbose` and `--quiet` are mutually exclusive.
- With `--cli claudecode`, `--variant` must be `low|medium|high|xhigh|max`.
- Every `--fallback <cli>:<model>:<variant>` rung has its binary verified while
  parsing; a repeated rung is an error, and `--fallback-wait-max` may not be
  smaller than `--fallback-wait`.
- Azure multi-repository `code` requires `--hu`; `--ticket` is optional and
  narrows the run to that single unit instead of draining the HU.
- `--commit` always takes the full object name.

## How to answer

Lead with the command block, then one line per non-obvious flag, then what to
check when it finishes — the marker it should end on, the items it should have
published, or the JSON worth rereading. When a preflight read would change the
command you are about to propose, run it first and say what it returned.

Running a workflow command has real effects on a real backlog: it claims issues,
pushes branches, opens and merges pull requests, and moves tracker items. Read-only
tools are yours to run freely; anything that writes is the user's call unless they
already asked for the run.
