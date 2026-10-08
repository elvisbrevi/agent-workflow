# When a run stops

The operator output is Spanish; the messages below are what the terminal shows.
Read the message first, then run the tool command that produces the evidence,
then rerun the same workflow command. Nothing here needs a new session.

`scripts/preflight.sh` (`scripts/preflight.ps1` in PowerShell) gathers most of
that evidence in one pass, and the failing probe usually names the cause.
Remember where to look: the JSON result
is on stdout, and every explanation is on stderr.

## Start from how it ended

A marker on stdout says who must act next — the full table is in
[Markers](CODING-AGENTS.md#markers). The case read wrong most often: a delivery
whose session was verified (its commits are on the fixed branch) but that ended
without `TICKET_COMPLETED` did **not** fail at implementation. It stopped in the
coordinator phase, and rerunning the original command resumes exactly there.
Starting a new delivery instead re-implements work that is already committed.
`github-session-verify` or `ticket-session-verify` tells the two cases apart.

## Argument errors

A checkpoint that claims an already-`CLOSED` issue is detected automatically:
`code` releases the claim (only if it still names the authenticated identity),
clears the checkpoint, reports the issue, its phase and how long it had been
claimed, and keeps draining the queue with the `--cli`/`--model`/`--variant`
declared on this invocation. `el checkpoint pertenece al CLI X, no a Y` only
fires now when the checkpoint's issue is genuinely still open — no manual
`github-issue-release` is needed for the closed-issue case.

| Message | Fix |
|---|---|
| `--branch y --base-branch solo se permiten en flujos Azure` | Drop them, or add `--hu <id>` if this was meant to be an Azure run |
| `--normas-sag solo se permite con plan o code` | Tools never load norms; drop the flag |
| `--interview solo se permite con plan` | Interviews belong to planning only |
| `--interview y --quiet son mutuamente excluyentes` | Drop `--quiet`: the channel announces itself through operator output |
| `--verbose y --quiet son mutuamente excluyentes` | Pick one verbosity |
| `--variant <v> no es un esfuerzo de claudecode` | Use `low`, `medium`, `high`, `xhigh` or `max` |
| `--variant <v> no es un esfuerzo de codex` | Use `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `--cli <c> requiere el binario <b> en el PATH` | Install `opencode`, `claude`, or `codex`, or drop `--cli` |
| `--fallback <r> no tiene la forma <cli>:<modelo>:<variante>` | Three non-empty parts, colon separated |
| `--fallback <r> repite un escalon ya declarado` | A rung equal to the primary or to another rung is useless |
| `--fallback-wait-max N no puede ser menor que --fallback-wait M` | The bound must cover at least one interval |
| `catalog no acepta opciones` | `lz catalog` takes none; filter its JSON with `jq` instead |
| `--working-directory CSV solo se permite con plan o code` | Workspace runs are planning and delivery only |
| `runAzureWorkspaceCode requiere que --ticket <id> sea un entero positivo` | `--ticket` is optional, but a supplied one must be a positive integer |
| `el checkpoint workspace Azure pertenece al ticket N` | A `--ticket` contradicting the delivery in flight; drop it or pass that one |
| `no hay un ticket elegible todavía para la HU N` | The queue is blocked: every pending child waits on a predecessor that has not landed. `hu-children-info --hu <id>` shows the graph |
| `--commit requiere el nombre de objeto completo` | Full 40+ hex object name, never abbreviated |

## The delivery stopped with unmet completion gates

Sessionless reconciliation prints the pinned ticket and stable reasons. Read the
live state, correct it, and rerun the same `code` command — the checkpoint is
intact and no other ticket will be selected.

| Reason | What is missing | Read it with |
|---|---|---|
| `pinned-ticket-context` | The ticket context could not be rebuilt | `ticket-info --hu --ticket` |
| `ticket-state` | The ticket is not in the state the gate expects | `ticket-state-info --ticket` |
| `completion-evidence` | No completion evidence on the work item | `ticket-info --hu --ticket` (`completionEvidence`) |
| `real-effort`, `real-effort-hours` | The effort fields were never published | `ticket-effort-info --ticket` |
| `commit-url` | The merge commit is not linked to the work item | `ticket-info --hu --ticket` (`mergeCommit`, `attachments`) |
| `hu-integration-branch` | The HU has no usable integration branch | `hu-branch-info --hu` |
| `completed-hu-targeted-pr`, `native-pr-association`, `merge-commit-artifact-link` | The PR is not merged into the HU branch, or not associated | `ticket-pr-info --hu --ticket` |

`ticket-completion-info --hu <id> --ticket <id>` prints all of them at once.
Azure command or authentication failures are operational errors, not gates —
they say so, and rerunning after fixing the credential is enough.

## Branch preflight failures

A `code --hu` run prepares the HU's native Branch link before selecting
anything, in single- and multi-repository scope alike.

- **No link and no `hu/<HU>`** → the run provisions it from `master`, or `main`
  when the repository has no `master`. Supply `--base-branch <name>` to branch
  from anything else, or create the link deliberately with
  `hu-branch-set --hu <id> --branch <name> --base-branch <name> --working-directory <path>`.
- **A repository with neither `master` nor `main`** → the run stops asking for
  `--base-branch <name>`; pass the trunk that repository actually uses.
- **A link whose branch no longer exists in the anchor repository** → the run
  stops rather than recreating it: repair the link, or restore the branch.
- **A malformed, multiple or conflicting link** → `hu-branch-info --hu <id>`
  shows what Azure holds; fix it there. Recovery never guesses, resets or
  force-switches a branch.
- **A dirty worktree, an active git operation, a missing local branch** → clean
  the worktree and rerun. Branch cleanup also stops safely on uncommitted or
  untracked changes.

## The GitHub queue took nothing

```bash
scripts/preflight.sh --working-directory /repo   # authentication, repository, candidates, selection
```

`github-issue-list` is the probe that matters here: it classifies every candidate
with the reason it is or is not eligible, which is the actual answer to "the
queue was empty".

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

## The GUI cannot run anything

The window runs the same `lz` a terminal would, so first make sure the terminal
works (`lz catalog > /dev/null`), then compare what the GUI resolves:
**Inicio → Diagnostico**, or [GUI.md](GUI.md#troubleshooting) for each symptom.
A run that fails inside the GUI fails for the reasons in this file — its operator
panel is the same stderr.
