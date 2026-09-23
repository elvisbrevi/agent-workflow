# lazy-workflow

An executable agent that plans and delivers tracked work. It drives a coding
agent CLI — OpenCode, Claude Code or Codex — for the part that needs judgment,
and does everything else itself: selecting the unit, preparing the branch,
verifying what the session left, pushing, opening the pull request, merging,
closing the unit and cleaning up.

To install dependencies:

```bash
bun install
```

Installed by `install.sh` (Bash or Zsh) or `install.ps1` (PowerShell) with
`--all-global`, `--claude-global` or `--claude-local`,
the installer prepares the locked Bun dependencies in its managed cache and the
`lazy-workflow` command is on the path:

```bash
lazy-workflow plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
lazy-workflow code --working-directory /path/to/repository
```

On Windows the installed command is `lazy-workflow.cmd`. For quoted or multiline
prompts from PowerShell, use `lazy-workflow-powershell.ps1` instead.

`install.sh --codex` or `install.ps1 --codex` installs the skills into `~/.codex/skills/`, which is where
Codex resolves them from; without it a run that falls back to Codex has no
skills. Its other modes are `--global`, `--local`, `--opencode`, `--both`,
`--claude-local`, `--target D`, `--ref REF`, `--uninstall`, `--dry-run` and
`--force`.

Once installed, `lazy-workflow update` reinstalls it: it runs the repository's
platform installer with the arguments declared after it, and with `--all-global` when
none is declared.

Every command has a runnable example in [Practical examples](#practical-examples);
the sections after it explain what each one does.

## Practical examples

### Planning

```bash
# Plan the GitHub backlog of one repository
lazy-workflow plan --prompt "plan the requested change" --working-directory /path/to/repository

# Ask a different number of clarifying questions (default 5)
lazy-workflow plan --number-of-questions 3 --working-directory /path/to/repository

# Answer those questions yourself, in a browser page the run opens
lazy-workflow plan --interview http --working-directory /path/to/repository

# Plan against the norms of the component declared in .sag/config.json
lazy-workflow plan --normas-sag --working-directory /path/to/repository

# Slice an Azure HU and publish its work items in dependency order
lazy-workflow plan --hu 23438 --working-directory /path/to/repository

# Plan one unit of work across several repositories in a single session
lazy-workflow plan --working-directory /path/to/api,/path/to/web
```

### Delivering

```bash
# Drain the eligible GitHub issues, each in its own fresh session
lazy-workflow code --working-directory /path/to/repository

# Same, with the coding norms loaded
lazy-workflow code --normas-sag --working-directory /path/to/repository

# Drain the direct Task and Bug tickets of an Azure HU
lazy-workflow code --hu 23438 --working-directory /path/to/repository

# First delivery of an HU whose hu/<HU> branch does not exist yet
lazy-workflow code --hu 23438 --base-branch develop --working-directory /path/to/repository

# Deliver one Azure ticket across a multi-repository workspace
lazy-workflow code --hu 23438 --ticket 23459 --working-directory /path/to/api,/path/to/web

# Drain the queue overnight and power the machine down when the run ends
lazy-workflow code --off 'sudo-password' --working-directory /path/to/repository
```

### Resuming an interrupted run

```bash
# The issue or HU, the ticket and the branch come from the checkpoint,
# so no --hu and no --working-directory are needed
lazy-workflow code

# Reconcile a delivery whose session had already been verified: rerun the
# original command, which finishes that unit instead of selecting replacement work
lazy-workflow code --working-directory /path/to/repository
```

### Azure reads — no session is opened

```bash
lazy-workflow hu-info --hu 23438
lazy-workflow hu-children-info --hu 23438
lazy-workflow hu-branch-info --hu 23438
lazy-workflow ticket-info --hu 23438 --ticket 23459
lazy-workflow ticket-type-info --ticket 23459
lazy-workflow ticket-description-info --ticket 23459
lazy-workflow ticket-state-info --ticket 23459
lazy-workflow ticket-effort-info --ticket 23459
lazy-workflow ticket-branch-info --hu 23438 --ticket 23459
lazy-workflow ticket-pr-info --hu 23438 --ticket 23459
lazy-workflow ticket-completion-info --hu 23438 --ticket 23459
```

### Azure writes — no session is opened

```bash
# Branch links
lazy-workflow hu-branch-set --hu 23438 --branch refs/heads/hu/23438 --working-directory /path/to/repository
lazy-workflow hu-branch-ensure --hu 23438 --base-branch develop --working-directory /path/to/repository
lazy-workflow ticket-branch-set --hu 23438 --ticket 23459 --branch refs/heads/ticket/23459 \\
  --working-directory /path/to/repository
lazy-workflow ticket-branch-checkout --branch refs/heads/ticket/23459 --working-directory /path/to/repository
lazy-workflow ticket-branch-push --branch refs/heads/ticket/23459 --working-directory /path/to/repository

# Work items and their relations
lazy-workflow ticket-create --hu 23438 --type Task --title "Slice uno" \
  --description-file ./description.html --estimate 8
lazy-workflow ticket-link-parent --parent 23438 --child 23459
lazy-workflow ticket-link-predecessor --blocker 23459 --blocked 23460

# Ticket fields
lazy-workflow ticket-description-set --ticket 23459 --description-file ./description.html
lazy-workflow ticket-state-set --ticket 23459 --state "En progreso" --expected-state "Nuevo"
lazy-workflow ticket-effort-set --ticket 23459 --real-effort 6 --real-effort-hh 6 --expected-rev 9
lazy-workflow hu-state-set --hu 23438 --state "Resuelto" --expected-state "En progreso" --expected-rev 12

# Pull request and completion
lazy-workflow ticket-pr-create --hu 23438 --ticket 23459
lazy-workflow ticket-pr-link --hu 23438 --ticket 23459 --pr 987
lazy-workflow ticket-commit-link --ticket 23459 --pr 987
lazy-workflow ticket-session-verify --branch refs/heads/ticket/23459 \
  --base-branch refs/heads/hu/23438 --working-directory /path/to/repository
lazy-workflow ticket-completion-apply --hu 23438 --ticket 23459 --pr 987 \
  --summary "Lo que la sesión dejó dicho"
```

### GitHub operations — no session is opened

```bash
# What a code run would take, and why it would skip the rest
lazy-workflow github-auth-info --working-directory /path/to/repository
lazy-workflow github-repo-info --working-directory /path/to/repository
lazy-workflow github-issue-list --working-directory /path/to/repository
lazy-workflow github-issue-select --working-directory /path/to/repository
lazy-workflow github-issue-info --issue 263 --working-directory /path/to/repository

# The claim, the branch, the commit, the pull request, the closure
lazy-workflow github-issue-claim --issue 263 --working-directory /path/to/repository
lazy-workflow github-issue-release --issue 263 --working-directory /path/to/repository
lazy-workflow github-branch-prepare --issue 263 --working-directory /path/to/repository
lazy-workflow github-branch-checkout --branch issue/263 --base-branch main --working-directory /path/to/repository
lazy-workflow github-session-verify --branch issue/263 --base-branch main --working-directory /path/to/repository
lazy-workflow github-branch-verify --branch issue/263 --base-branch main --working-directory /path/to/repository
lazy-workflow github-commit-push --branch issue/263 --commit <sha> --working-directory /path/to/repository
lazy-workflow github-pr-create --issue 263 --branch issue/263 --base-branch main --commit <sha> \
  --working-directory /path/to/repository
lazy-workflow github-pr-merge --pr 271 --issue 263 --branch issue/263 --base-branch main --commit <sha> \
  --working-directory /path/to/repository
lazy-workflow github-issue-close --issue 263 --pr 271 --commit <sha> --working-directory /path/to/repository
lazy-workflow github-branch-cleanup --branch issue/263 --base-branch main --commit <sha> \
  --working-directory /path/to/repository

# git
lazy-workflow git-branch-delete --branch issue/263 --base-branch main --commit <sha> \
  --working-directory /path/to/repository

# The operator's own credentials, read from ~/.config/secrets/*.env
lazy-workflow credentials-list
lazy-workflow credentials-get --name OPENAI_API_KEY
# Store or rotate one: the value is prompted, never a flag
lazy-workflow credentials-set --name OPENAI_API_KEY
```

### Updating the tool and the credentials

```bash
# Reinstall the tool; any argument is forwarded to the platform installer
lazy-workflow update
lazy-workflow update --codex

# Bring this machine the secrets another machine published
lazy-workflow credentials-update
```

### Choosing the CLI, the model and the effort

```bash
# OpenCode is the default; naming it explicitly is equivalent
lazy-workflow code --cli opencode --working-directory /path/to/repository

# Claude Code with Sonnet 5 at high effort
lazy-workflow code --cli claudecode --model claude-sonnet-5 --variant high \
  --working-directory /path/to/repository

# Codex with gpt-5.6-sol at high effort
lazy-workflow code --cli codex --model gpt-5.6-sol --variant high \
  --working-directory /path/to/repository
```

### Surviving an exhausted account

```bash
# Claude Code on Sonnet 5, backed by the same model through GitHub Copilot
lazy-workflow code --cli claudecode --model claude-sonnet-5 \
  --fallback opencode:github-copilot/claude-sonnet-5:high \
  --working-directory /path/to/repository

# Several rungs; declaration order is the descent order
lazy-workflow code --cli claudecode --model claude-sonnet-5 \
  --fallback claudecode:claude-opus-5:high \
  --fallback codex:gpt-5.6-sol:high \
  --working-directory /path/to/repository

# End the session and descend after 15 minutes of silence instead of 30
lazy-workflow code --idle-timeout 15 --fallback codex:gpt-5.6-sol:high \
  --working-directory /path/to/repository
```

### Operator output

```bash
lazy-workflow code --verbose --working-directory /path/to/repository
lazy-workflow code --verbose-output --working-directory /path/to/repository
lazy-workflow code --quiet --working-directory /path/to/repository
lazy-workflow code --no-color --working-directory /path/to/repository
lazy-workflow code --log-file /path/to/runs.jsonl --working-directory /path/to/repository
lazy-workflow code --no-log-file --working-directory /path/to/repository
```

## Default GitHub workflows

Without `--hu`, `plan` and `code` run in GitHub-only scope. These runs do not
read Azure, prepare integration branches, or clean Azure ticket branches;
`--branch` and `--base-branch` are rejected here.

### `plan`

The session decides how to slice the work and returns the slices behind a
`PLAN_READY` marker — type, title, body, blocking edges, optional estimate. It
creates no issues: `gh issue create` and `gh issue edit` are denied to it by its
authority profile.

The coordinator publishes the plan. It validates the whole thing first —
duplicate titles, unknown blockers and blocking cycles are rejected before
anything is created — then creates one issue per slice in dependency order, each
with its `ready-for-agent` label applied in the same call that creates it, and
wires the declared blocking edges with GitHub's native dependency relation, read
back to confirm GitHub recorded them. An empty plan publishes nothing, and an
issue somebody opens by hand while the session runs is never labelled, because
an issue is the plan's only if this code created it.

A planning session may also write documentation. The coordinator commits what
git already tracks when the session ends, so the next `code` run finds the clean
tree it needs to prepare a branch.

### `code`

A `code` run is not a pass over a list of issues. It asks the tracker for the
first eligible unit, delivers it, and asks again, until the answer is that there
is none. Re-asking each turn is the point: merging #42 is what makes #47
eligible, and a list captured before the run began would never contain it.

An issue is eligible when it is open, unassigned, labelled `ready-for-agent`,
not an Epic issue type, not labelled `epic`, not titled `[Epic]…`, and has no
open blocking dependency. Ties break by creation date, then by number.

Each unit is one composition of deterministic effects around a single fresh
session:

1. Claim the issue and verify the claim held.
2. Refresh the base branch and create `issue/<number>` from it.
3. Run one session. Its prompt is the issue's number and the skills that
   implement it — four lines, no protocol vocabulary. The session reads the
   issue itself with `gh`, works, and commits.
4. **Verify with git.** The session succeeded when its process exits zero, its
   branch is ahead of the base, and the worktree is clean. Nothing the session
   wrote is consulted: an agent that asked a question, refused, or explored
   without committing leaves a branch with no commits, and one that committed
   half its work leaves a dirty tree. Both are failures, decided by two commands
   rather than by a line of text a model chose to print.
5. Push the verified commit, open the pull request with the session's last text
   as its body, merge it, close the issue, reconcile parents, delete the branch.

Verification happens before any remote effect, which is what makes the two kinds
of failure distinguishable: what has touched the remote and what has not.

**What a failed unit leaves.** An ordinary failure — non-zero exit, a branch
with no commits, a dirty tree, or a session silent past the idle timeout on
every rung — does not release the unit. The claim stays, and since the queue
rejects assigned issues, the unit simply leaves the frontier: no new state is
needed and the loop cannot pick it again. Its branch and any commits survive for
inspection, the drain continues with the next unit, and the run exits non-zero,
so a night's drain can say that something behind it is broken. A person
unassigns the issue to retry it.

A unit that fails *after* verification is the exception and stops the run: it
has already pushed, opened a pull request, or merged, so claiming the next unit
would bury state an operator has to reconcile under a second delivery.

**The checkpoint** carries the one bit git cannot supply — that a unit passed
its verification before the delivery effects finished. It is
`{ repository, issue, branch, baseBranch, commit, summary }`, where a non-null
`commit` *is* that bit. Rerunning `code` in the same repository finishes that
unit instead of selecting replacement work. A run interrupted before its unit
verified leaves the issue claimed and its branch in place, and clears the
checkpoint. A checkpoint written under an older schema is discarded rather than
migrated. A repository-scoped lock keeps two runs out of the same repository.

**Merge conflicts.** When `gh` reports `mergeStateStatus: DIRTY`, the
coordinator merges the base into the unit's branch itself, leaves the worktree
conflicted, and opens a session with a single instruction: resolve the
conflicts, keeping this branch's changes without discarding the base's, touch no
unconflicted file, ask nothing, commit and push. The result passes the same git
verification as any delivery and the merge is retried once; a second conflict is
an ordinary failure. `BLOCKED` is not treated this way — branch protection
requires a review no retry can satisfy, and the run reports it at start-up when
it can read that the base requires one.

**Outcome lines.** The coordinator prints `TICKET_COMPLETED`, `QUEUE_EMPTY` or
`QUEUE_BLOCKED`, each followed by `WORKFLOW_STEP_FINISHED`, and
`RECONCILIATION_REQUIRED` when a delivery needs a person. These are the
coordinator's own stdout, for whatever reads a run's output; no session emits
them and none is asked to.

## Azure HU workflows

With `--hu`, both commands work an Azure DevOps User Story. Every `az` call
resolves the organization from `LAZY_WORKFLOW_AZURE_ORGANIZATION`
(`https://dev.azure.com/<organization>`); a run without it fails before reaching
Azure instead of naming one.

`plan --hu` reads the HU, opens one session that slices it, and publishes the
result the way GitHub does: work items created in dependency order, parent links
wired, blocking relations added in a second pass when real ids exist. A created
ticket inherits its HU's iteration and is assigned to the HU's `Desarrollador 1`
(`Custom.Desarrollador1`), not to whoever the HU itself is assigned to — the HU
answers to a lead, the ticket lands on the developer. `--assignee` overrides
that identity. Publication is idempotent, so republishing a plan reuses its work
items instead of duplicating them.

`code --hu` drains the HU's direct Task and Bug tickets. It ensures the
`hu/<HU>` integration branch exists — `--base-branch` names what to create it
from the first time — creates `ticket/<id>` from it, moves the ticket to
`En progreso`, runs one session, and gates on the same git verification as
GitHub: process exited, ticket branch ahead of the integration branch, clean
tree. The session's last text becomes the ticket's completion-evidence field.
The delivery then pushes, creates or reuses the pull request, associates it,
sets the effort, and moves the ticket to `Done` behind the completion gates.

The Azure delivery prompt is the same four lines as GitHub's, preceded by the
whole ticket. That is the one asymmetry between the two, and the reason for it:
a GitHub delivery session has `gh` and reads its issue itself, while an Azure
one is denied both `az` and `gh`, so the coordinator's own read is the only way
it learns what was asked.

A failed Azure unit keeps its `En progreso` state and its branch, and the run
exits non-zero. Unlike GitHub, the drain stops on that unit rather than
continuing: `En progreso` is still eligible, so re-asking would hand the loop
the same ticket. Stopping is the honest behaviour until that predicate widens.

The Azure checkpoint still carries its phase, its per-effect receipts and the
session it owned; only the GitHub one was reduced.

## Multi-repository workspaces

A comma-separated `--working-directory` is a workspace: one unit of work
delivered across several repositories in a single session, with the first
repository as the anchor.

```bash
lazy-workflow plan --working-directory /path/to/api,/path/to/web
lazy-workflow code --working-directory /path/to/api,/path/to/web
lazy-workflow code --hu 23438 --ticket 23459 --working-directory /path/to/api,/path/to/web
```

Every repository must have a remote of the run's own provider — all GitHub, or
all Azure — and the session may only read or modify the listed ones. It runs
from the parent directory with the ordered roster in its prompt.

A GitHub workspace plan publishes its issues into the anchor repository, which
is the only queue a workspace `code` run drains. A workspace delivery verifies
per repository: every participant clean, at least one ahead of its base — a
repository a transversal change did not need is a repository with nothing to
prove. Its checkpoint and lock live in a state directory beside the workspace
rather than inside any one repository.

## Deterministic tools as commands

Every operation the workflow performs against Azure Boards, GitHub or git
without opening a session is reachable as its own command. They share the exact
adapter a run uses, print what that adapter answered as JSON, and open no
session — so an operator can do by hand precisely what a run does, and the
workflow stays the only thing a run has to trust.

| Family | Commands |
|---|---|
| Azure | `hu-children-info`, `hu-state-set`, `hu-branch-ensure`, `ticket-type-info`, `ticket-pr-create`, `ticket-branch-push`, `ticket-branch-checkout`, `ticket-session-verify` |
| GitHub | `github-auth-info`, `github-repo-info`, `github-issue-list`, `github-issue-select`, `github-issue-info`, `github-issue-claim`, `github-issue-release`, `github-issue-close`, `github-branch-prepare`, `github-branch-checkout`, `github-branch-verify`, `github-branch-cleanup`, `github-session-verify`, `github-commit-push`, `github-pr-create`, `github-pr-merge` |
| git | `git-branch-delete` |
| credentials | `credentials-list`, `credentials-get`, `credentials-set`, `credentials-update` |

`credentials-list` and `credentials-get` are the exception to the JSON answer:
they read the operator's encrypted `~/.config/secrets/*.env` files and write one
name per line or the decoded value, so they feed the shell directly.
`credentials-get` prints only to a terminal unless `--force` declares the pipe.

`credentials-set` stores or rotates one credential. The value comes from a
hidden prompt — or from the first line of the standard input when `--stdin`
declares a pipe, for a session that is not interactive — and never from a flag,
so it stays out of `ps` and the shell history. It writes the declaring file, or
`--service <name>.env`, or `other.env`, with 0600 permissions; and when chezmoi
manages that file it also publishes it: re-adds it to the encrypted source,
commits only that file to the private dotfiles repository and pushes. It answers
with the name, the file and how far the publication got — `published`,
`committed`, `unmanaged` or `failed` — never the value.

`credentials-update` brings this machine to what the repository declares: it
pulls the private dotfiles repository and applies only the credentials
directory, so a value another machine published becomes the value here. Local
modifications of the secrets files are replaced by the repository's version.

Beside them sit the Azure work-item commands the planning and delivery paths
use: `hu-info`, `hu-branch-info`, `hu-branch-set`, `ticket-info`,
`ticket-description-info`, `ticket-state-info`, `ticket-effort-info`,
`ticket-branch-info`, `ticket-pr-info`, `ticket-completion-info`,
`ticket-description-set`, `ticket-state-set`, `ticket-effort-set`,
`ticket-branch-set`, `ticket-pr-link`, `ticket-commit-link`,
`ticket-completion-apply`, `ticket-create`, `ticket-link-parent` and
`ticket-link-predecessor`.

`--help` lists every one of them with its required options.

## Coding agent CLI

`--cli` selects which coding agent a run drives; `--model` and `--variant` say
which model and how much effort.

| `--cli` | Binary | Default model | Efforts |
|---|---|---|---|
| `opencode` (default) | `opencode` | `opencode-go/deepseek-v4-pro` | fixed by the model |
| `claudecode` | `claude` | `claude-sonnet-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `codex` | `gpt-5.6-sol` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

`--variant` defaults to `high`. Naming a `--cli` whose binary is not on the path
is an argument error, so a missing CLI fails before the run spends anything.

## Fallback chain

`--fallback <cli>:<model>:<variant>` declares a rung to descend to; repeat it
for more, and declaration order is the descent order. The primary rung is
whatever `--cli`, `--model` and `--variant` selected.

Descent has two causes: the provider says the account is exhausted, and the
session goes silent past `--idle-timeout` minutes (default 30). A stuck agent
and a spent quota mean the same thing to the loop — this rung is not producing,
try the next — so the silent session is ended and the next rung starts.

Every descent opens a **fresh** session, including a descent to another model on
the same CLI. The new session gets the same prompt plus a progress section: the
branch, the commits it already carries, and the last three reasoning chains of
the outgoing session, reproduced verbatim and presented as what they are — the
previous agent's last thoughts, not a verified account of what landed. What
landed is the commit list beside them.

### When the whole chain is exhausted

The two causes part company only here. Exhausted by quota, the run waits
`--fallback-wait` seconds (default 300) and retries from the primary rung, up to
a total of `--fallback-wait-max` seconds (default 3600) counted from the first
wait: quota returns on its own, and the bound is there so a failure
misclassified as exhaustion surfaces instead of waiting forever. Exhausted by
silence, the unit fails ordinarily and the drain continues, because a prompt
that hung three CLIs will hang the fourth attempt too.

A run without `--fallback` declared no chain, so it never waits.

## Planning interview

By default a planning session answers its own clarifying questions —
`--number-of-questions` sets how many, default 5 — and returns the plan in one
shot.

`--interview http` makes it stop instead: it states the decisions it cannot
settle alone, and the coordinator serves them as a page whose URL it prints,
carries the answers back, and resumes that same session. `--interview off` is
the default and the only other channel.

```bash
lazy-workflow plan --interview http --interview-host 127.0.0.1 --interview-port 8787 \
  --interview-timeout 900 --interview-rounds 8 --working-directory /path/to/repository
```

`--interview-timeout` seconds (default 900) is how long a round waits before
accepting the answers the session itself recommended, so an unattended run
behaves exactly as one without the flag. `--interview-rounds` (default 8) caps
the rounds before the final plan is required. `--interview-host` (default
`127.0.0.1`) and `--interview-port` (default 0, meaning any free port) are
rejected on any channel but `http`; served off loopback, the URL and its token
are the only credential.

## SAG norms

`--normas-sag` reads `.sag/config.json` from the working directory, takes its
`tipo` — `api`, `bff` or `nextjs` — and hands the session the normative file
paths that follow from it, in the remote repository named by
`LAZY_WORKFLOW_SAG_NORMS_REPOSITORY`. The session reads the files itself. A run
that declares the flag and cannot resolve the norms — missing `.sag/config.json`
or an unset `LAZY_WORKFLOW_SAG_NORMS_REPOSITORY` — stops before opening a
session.

## Reporter and verbosity

Four global flags select what reaches the operator:

```bash
lazy-workflow code --working-directory /repo                  # default: info, warn, error
lazy-workflow code --verbose --working-directory /repo        # + debug
lazy-workflow code --verbose-output --working-directory /repo # + debug and trace
lazy-workflow code --quiet --working-directory /repo          # errors only
lazy-workflow code --no-color --working-directory /repo       # ANSI stripped
```

`--verbose` and `--quiet` are mutually exclusive. `--verbose-output` is strictly
wider than `--verbose` and turns it on, so it can never show less. `--no-color`
is independent and stacks with any verbosity; `NO_COLOR=1` does the same.

`--verbose-output` is what answers which file a session is editing while it
edits it: it adds the whole input of every tool call, the output the tool
returned, and the raw event the agent CLI emitted.

### The parsed line

Every line carries the local `dd/mm/yy HH:mm:ss`, then a gutter its continuation
lines hang from, then the glyph of its level. The palette is the Bagels TUI's
tokyo-night, and a run opens with a rounded panel naming what it is about to do:

```text
╭──────────────────────────────────────────────────────────╮
│ lazy-workflow · code                                     │
│ alcance    GitHub                                        │
│ agente     opencode · opencode-go/deepseek-v4-pro · high │
│ directorio /repo                                         │
│ salida     parseada                                      │
╰──────────────────────────────────────────────────────────╯
16/08/26 21:03:48 │ ● OpenCode iniciado en /repo
```

The glyphs are `●` info, `▲` warn, `✖` error, `·` debug and `⋮` trace. Events
show their session id, reasoning summaries, tool status, and the artifact each
tool touched — the file an edit is writing among them. The working directory is
passed as the agent's real process directory, so its tools operate in the
selected repository.

## Run log

Every command also appends to a run log: one JSON Lines file, so a metrics or
monitoring service can tail a run's start, its end, and every `warn`/`error`
between them without parsing operator prose. It describes a run; it never copies
one — a record carries no credential, no prompt text and no diff content.

```bash
lazy-workflow code --working-directory /repo                            # default path
lazy-workflow code --log-file /path/to/runs.jsonl --working-directory /repo
lazy-workflow code --no-log-file --working-directory /repo
LAZY_WORKFLOW_LOG_FILE=/path/to/runs.jsonl lazy-workflow code --working-directory /repo
```

Where it writes resolves in this order: `--log-file <path>`, then
`LAZY_WORKFLOW_LOG_FILE`, then the default
`~/.local/state/lazy-workflow/runs.jsonl`. `--no-log-file` disables it outright
and is rejected together with `--log-file`. The file is capped at a fixed size
and keeps exactly one previous generation (`runs.jsonl.1`).

The first record of a run is always `run.started` and the last always
`run.finished`, carrying `outcome`, `exit_code` and `duration_ms` — including
when the run ends on a failure path. Every `warn` and `error` in between appears
as an `event` record with the same `run_id`, regardless of `--quiet`: the run
log is a separate seam from the terminal stream, so silencing one never silences
the other. A run never fails because its run log could not be written.

A run that ends badly says where its own detail is, naming the run so the file
can be read straight away:

```
lazy-workflow: revisa el run log para el detalle del fallo: grep <run_id> ~/.local/state/lazy-workflow/runs.jsonl
```

It is told once, at the end, and only when there is something to read: a run
with `--no-log-file`, or one whose log could not be written, was already told so
and is not sent to a file holding nothing. An argument error stays silent too —
the operator is at the keyboard with the message on screen, the same reason
`--off` never powers a machine down for a typo.

Each record splits into **labels** — flattened at the top level, the
low-cardinality axes a dashboard groups by: `schema_version`, `run_id`, `ts`,
`severity`, `event`, `command`, `workflow`, `provider`, `cli`, `model`,
`variant`, and where they apply `failure_kind`, `phase`, `checkpoint`,
`outcome`, `exit_code`, `duration_ms`, `session_event`, `reason`, `from_cli` —
and a nested **`context`** carrying the high-cardinality identifiers: `issue`,
`ticket`, `hu`, `repository`, `session_id`, `branch`.

### Failure kind

A failed run carries a `failure_kind` from a closed vocabulary, so the same
failure is always the same value and a monitoring service can chart it. The
prose describing the failure travels beside it, never instead of it:
`tracker-read-failure`, `claim-verification-failure`,
`branch-preparation-failure`, `session-failure`, `session-not-verified`,
`delivery-failure`, `pull-request-failure`, `reconciliation-required`,
`parent-reconciliation-failure`, `deterministic-completion-failure`,
`checkpoint-unreadable`, `lock-unavailable`, `argument-error`,
`hu-transition-failure`, `ticket-branch-cleanup-failure`,
`workspace-scope-failure`, `topology-preparation-failure`,
`run-interrupted-signal`, `run-interrupted-failure`, `shutdown-failure`, and
three the Azure workspace path still raises around the aggregate record it
writes per repository: `manifest-not-verifiable`, `manifest-mismatch` and
`evidence-not-verifiable`.

Every interruption leaves a record, so a preserved checkpoint is never the only
trace a stopped run left behind.

## Unattended shutdown

`--off '<sudo password>'` powers the machine down when the run ends, whatever
its outcome — except when it died on an argument error, where the operator is
still at the keyboard and powering their machine off for a typo is never what
was asked.

```bash
lazy-workflow code --off 'sudo-password' --working-directory /repo
lazy-workflow code --off 'sudo-password' --off-delay 60 --working-directory /repo
LAZY_WORKFLOW_OFF_PASSWORD='sudo-password' lazy-workflow code --off --working-directory /repo
```

`--off-delay` seconds (default 15) is the grace period, and it is the way out:
the interrupt handlers are still installed while it runs, so Ctrl-C cancels the
shutdown and the run is recorded as interrupted. Taking the password from
`LAZY_WORKFLOW_OFF_PASSWORD` keeps it out of `ps` and the shell history. A
shutdown that fails is reported like any other failure and cannot change the
exit code the run already earned.

On Windows, use `lazy-workflow code --off --working-directory C:\repo` without
a password. The command uses `shutdown.exe /s /t 0` after the grace period.

## Agent authority

Every run injects a permission profile into the CLI it drives, in that CLI's own
format: `opencode/authority.json` for OpenCode, `claudecode/<profile>.json` for
Claude Code, `codex/<profile>.rules` for Codex. The profile is the authority —
the prompt does not restate what the profile already denies.

| Profile | Selected by | Denies |
|---|---|---|
| `lazy-github-plan` | `plan` without `--hu` | `gh issue create`, `gh issue edit`, pushes, branch and remote mutation, `gh pr`, `gh repo`, `gh api`, all `az` |
| `lazy-azure-plan` | `plan --hu` | pushes, branch and remote mutation, all `gh`, all `az` |
| `lazy-github-code` | `code` without `--hu`, including the conflict session | pushes, branch and remote mutation, `gh pr`, `gh repo`, `gh api`, `gh issue edit/close/reopen/comment/delete/transfer/lock/unlock`, all `az` |
| `lazy-azure-code` | `code --hu` | pushes, branch and remote mutation, all `gh`, all `az` |

`lazy-review`, which denies editing outright, is still in the profile set; no run
selects it since the review workflows it served were removed.

Planning profiles allow editing and committing, because documentation is a
planning session's own deliverable. Delivery profiles allow committing and deny
pushing: the coordinator pushes the verified commit itself.

## Other flags

`--prompt` supplies the operator's own request to a session. `--session` resumes
an opaque agent session by id. `--issue` names an issue for the run log's
context; it selects no work. `--field <referenceName>=<value>` sets an explicit
Azure field on a work-item write, and is repeatable.

## Structure

```text
main.ts                 CLI entrypoint
prompts/                Prompt assets, composed by src/prompts/
opencode/authority.json Permission profiles injected per run (OpenCode)
claudecode/             One settings file per profile (Claude Code)
codex/                  One execpolicy rules file per profile (Codex)
src/cli/                Workflow coordination, argument parsing, tool commands
src/prompts/            Prompt composition, contract vocabulary, plan contract, authority profiles
src/interaction/        Planning interview: question rounds and the channels that carry them
src/azure/              Azure Boards model, services and plan publication
src/github/             GitHub queue, delivery, plan publication, locks and parent reconciliation
src/workspace/          Multi-repository scope and its checkpoint
src/git/                Session verification and verified branch cleanup
src/sag/                Norm path resolution
src/coding-agent/       Coding agent seam: contract, result, idle watchdog, CLI selection
src/opencode/           OpenCode execution and JSONL result
src/claude-code/        Claude Code execution and stream JSON result
src/codex/              Codex execution and stream decoding
src/output/             Reporter, run log, failure kinds, tool detail
src/system/             Machine shutdown when a run declares --off
test/                   Bun tests
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com)
is a fast all-in-one JavaScript runtime.
