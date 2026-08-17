# When a run stops

The operator output is Spanish; the messages below are what the terminal shows.
Read the message first, then run the tool command that produces the evidence,
then rerun the same workflow command. Nothing here needs a new session.

## Markers a run ends on

| Marker | Meaning |
|---|---|
| `PLAN_READY` | The planning session returned a plan; the coordinator publishes it |
| `IMPLEMENTATION_READY` | The session finished implementing; the coordinator owns everything after it |
| `TICKET_COMPLETED`, `WORKFLOW_STEP_FINISHED` | Emitted by the coordinator only, after every gate passed |
| `QUEUE_EMPTY`, `QUEUE_BLOCKED` | Coordinator-owned queue outcomes; a session may not print them |
| `RECONCILIATION_REQUIRED` | A checkpoint survives and must be reconciled before new work is selected |
| `ARCHITECTURE_REVIEW_RESULT` | The review's findings, published as corrective tracker work |

A run that ends on `IMPLEMENTATION_READY` without `TICKET_COMPLETED` did not
fail at implementation — it stopped in the coordinator phase. Rerun the original
command to resume that phase; do not start a new delivery.

## Argument errors

| Message | Fix |
|---|---|
| `--branch y --base-branch solo se permiten en flujos Azure` | Drop them, or add `--hu <id>` if this was meant to be an Azure run |
| `--issue solo se permite con infra-sag, architecture-review-sag o deploy-sag` | Use `--hu` for Azure flows; GitHub `code` selects its own issue |
| `--normas-sag solo se permite con plan o code` | The SAG workflows always load norms; the flag is redundant there |
| `--interview solo se permite con plan` | Interviews belong to planning only |
| `--interview y --quiet son mutuamente excluyentes` | Drop `--quiet`: the channel announces itself through operator output |
| `--verbose y --quiet son mutuamente excluyentes` | Pick one verbosity |
| `--variant <v> no es un esfuerzo de claudecode` | Use `low`, `medium`, `high`, `xhigh` or `max` |
| `--cli <c> requiere el binario <b> en el PATH` | Install `opencode` / `claude`, or drop `--cli` |
| `--fallback <r> no tiene la forma <cli>:<modelo>:<variante>` | Three non-empty parts, colon separated |
| `--fallback <r> repite un escalon ya declarado` | A rung equal to the primary or to another rung is useless |
| `--fallback-wait-max N no puede ser menor que --fallback-wait M` | The bound must cover at least one interval |
| `deploy-sag solo permite DEV, TEST o QA` | PROD and its aliases fail closed by design |
| `--working-directory CSV solo se permite con plan o code` | Workspace runs are planning and delivery only |
| `runAzureWorkspaceCode requiere --ticket <id>` | An Azure workspace delivery needs `--hu` and `--ticket` |
| `--commit requiere el nombre de objeto completo` | Full 40+ hex object name, never abbreviated |

## The delivery stopped with unmet completion gates

Sessionless reconciliation prints the pinned ticket and stable reasons. Read the
live state, correct it, and rerun the same `code` command — the checkpoint is
intact and no other ticket will be selected.

| Reason | What is missing | Read it with |
|---|---|---|
| `pinned-ticket-context` | The ticket context could not be rebuilt | `ticket-info --hu --ticket` |
| `ticket-state` | The ticket is not in the state the gate expects | `ticket-state-info --ticket` |
| `completion-evidence` | No completion evidence on the work item | `ticket-evidence-info --ticket` |
| `real-effort`, `real-effort-hours` | The effort fields were never published | `ticket-effort-info --ticket` |
| `commit-url`, `attached-capture` | The commit link or the capture is absent | `ticket-attachment-info --ticket` |
| `hu-integration-branch` | The HU has no usable integration branch | `hu-branch-info --hu` |
| `completed-hu-targeted-pr`, `native-pr-association`, `merge-commit-artifact-link` | The PR is not merged into the HU branch, or not associated | `ticket-pr-info --hu --ticket` |

`ticket-completion-info --hu <id> --ticket <id>` prints all of them at once.
Azure command or authentication failures are operational errors, not gates —
they say so, and rerunning after fixing the credential is enough.

## Branch preflight failures

A `code --hu` run queries the HU's native Branch link before selecting anything.

- **No link and no `hu/<HU>`** → supply `--base-branch <name>` once, or create
  the link deliberately with
  `hu-branch-set --hu <id> --branch <name> --base-branch <name> --working-directory <path>`.
- **A malformed, multiple or conflicting link** → `hu-branch-info --hu <id>`
  shows what Azure holds; fix it there. Recovery never guesses, resets or
  force-switches a branch.
- **A dirty worktree, an active git operation, a missing local branch** → clean
  the worktree and rerun. Branch cleanup also stops safely on uncommitted or
  untracked changes.

## The GitHub queue took nothing

```bash
lazy-workflow github-auth-info    --working-directory /repo   # authentication
lazy-workflow github-repo-info    --working-directory /repo   # repository identity
lazy-workflow github-issue-list   --working-directory /repo   # every candidate and why it is skipped
lazy-workflow github-issue-select --working-directory /repo   # what a run would take right now
```

An issue claimed by an interrupted run is released with
`github-issue-release --issue <id> --working-directory <path>`.

## The session is gone

`--session <id>` cannot recover a session the provider deleted. The checkpoint
becomes sessionless and stops without retrying forever: rerun the plain command
(`code --hu <id> --working-directory <path>`) so the coordinator reconciles the
pinned ticket, and let it start a fresh session for the remaining work.

A `--cli` that contradicts the checkpoint fails closed and names the CLI that
owns the work — resume with that one, or drop `--cli`. The exception is a
cross-CLI handoff the run itself performed: relaunching the same command resumes
on the CLI holding the work.

## Azure asked for a login

If the session requests `az login`, the run keeps the session, prints
`az login --use-device-code`, waits until the HU is reachable again, and resumes
that same session once with `continue`. Complete the login in another terminal.

## The whole fallback chain is exhausted

The run waits `--fallback-wait` seconds, retries from the primary rung, and
reports the time left until `--fallback-wait-max`. When the bound is spent it
fails closed naming the last rung and its cause, with the checkpoint intact:
`code --session <id> --prompt continue` resumes exactly where it stopped, or
rerun with a chain whose rungs still have quota.
