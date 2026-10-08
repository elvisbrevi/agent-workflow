# The tool layer

Every effect a workflow has on Azure Boards, GitHub or git is also a command of
its own. It opens no session, prints the JSON its adapter returned on stdout,
exits `0` or `1`, and shares the adapter the workflow uses — so a tool validates
exactly as the workflow step it mirrors does (ADR-0026). That is what makes these
safe to run while deciding: they cannot answer differently from the run itself.

Contents: [Choosing one](#choosing-one) · [Preflight chains](#preflight-chains) ·
[Azure reads](#azure-reads) · [Azure writes](#azure-writes) ·
[GitHub queue](#github-queue) · [GitHub delivery](#github-delivery) ·
[git](#git) · [Pull requests](#pull-requests) ·
[Describing the CLI](#describing-the-cli) · [Reading the output](#reading-the-output)

## Choosing one

| The question | The tool |
|---|---|
| What is this HU, and what hangs off it? | `hu-info`, `hu-children-info` |
| Does the HU have an integration branch? Which base would a first delivery use? | `hu-branch-info` |
| Everything known about one ticket | `ticket-info --hu --ticket` |
| One facet of a ticket | `ticket-{description,state,effort,type}-info` |
| Why is this ticket not `Done`? | `ticket-completion-info --hu --ticket` — prints the unmet gates |
| Can this environment reach GitHub at all? | `github-auth-info`, `github-repo-info` |
| What would a `code` run take next, and why does it skip the rest? | `github-issue-select`, `github-issue-list` |
| Everything about one issue, with its eligibility reasons | `github-issue-info --issue` |
| Free an issue an interrupted run still holds | `github-issue-release --issue` |
| Which branches exist, local and remote, newest first? | `git-branch-list` |
| Switch to a branch, local or remote, and bring it up to date | `git-branch-checkout --branch` |
| Did the session leave a deliverable branch? | `github-session-verify`, `ticket-session-verify` |
| Repair a half-finished delivery step | `github-branch-prepare`, `github-commit-push`, `github-pr-create`, `github-pr-merge`, `github-issue-close`, `github-branch-cleanup` |
| What pull requests are open, and what is each one waiting on? | `pr-list`, `pr-info --pr`, `pr-thread-list --pr` |
| Answer review feedback, or open a pull request | `pr-thread-reply`, `pr-create` |
| Publish tracker work without planning it | `ticket-create`, `ticket-link-parent`, `ticket-link-predecessor` |
| Attach the completion evidence a gate is waiting for | `ticket-pr-link`, `ticket-commit-link`, `ticket-completion-apply` |
| Which commands and flags does the installed `lz` have? | `catalog` |

Reads are free to run. Writes change a real backlog: run them when the user asked
for that effect, and prefer rerunning the workflow command, which performs the
same step with its own verification, over hand-driving a sequence of writes.

## Preflight chains

The reads worth doing before spending a session. `scripts/preflight.sh`
(`scripts/preflight.ps1` in PowerShell) runs exactly these and returns them as
one JSON document.

```bash
# Before plan/code --hu
lz hu-info         --hu 23438
lz hu-children-info --hu 23438     # what is already published
lz hu-branch-info  --hu 23438      # "branch": null → the first code run provisions hu/23438 from master or main

# Before code in GitHub scope
lz github-auth-info    --working-directory /repo
lz github-repo-info    --working-directory /repo
lz github-issue-list   --working-directory /repo   # every candidate and why it is skipped
lz github-issue-select --working-directory /repo   # what the run would actually take

# Before declaring a ticket stuck
lz ticket-info            --hu 23438 --ticket 23459
lz ticket-completion-info --hu 23438 --ticket 23459
```

## Azure reads

```bash
lz hu-info --hu <id>
lz hu-children-info --hu <id>
lz hu-branch-info --hu <id>
lz ticket-info --hu <id> --ticket <id>
lz ticket-type-info --ticket <id>
lz ticket-{description,state,effort}-info --ticket <id>
lz ticket-{branch,pr,completion}-info --hu <id> --ticket <id>
```

`ticket-info` is the aggregate: identity, description, state, revision, effort,
ticket and HU branches, pull-request candidates, canonical association, merge
commit, attachments, evidence, and every satisfied or unmet completion gate. The
focused commands exist for when only one facet matters. Branch, PR and completion
reads require `--hu` as well, so the direct delivery relationship and the
integration branch are validated rather than assumed.

`hu-branch-info` prints `{ "hu": <id>, "branch": <ref|null> }` and never proposes
`hu/<HU>`: a malformed or ambiguous link fails instead of being guessed at.

## Azure writes

```bash
lz hu-branch-set --hu <id> --branch <name> [--base-branch <name>] --working-directory <path>
lz hu-branch-ensure --hu <id> [--base-branch <name>] --working-directory <path>
lz hu-state-set --hu <id> --state <state> --expected-state <state> --expected-rev <rev>
lz ticket-create --hu <id> --type <Task|Bug> --title <title> --description-file <path> \
  [--estimate <hours>] [--assignee <identity>] [--field <referenceName>=<value>]
lz ticket-link-parent --parent <id> --child <id>
lz ticket-link-predecessor --blocker <id> --blocked <id>
lz ticket-description-set --ticket <id> --description-file <path>
lz ticket-state-set --ticket <id> --state <state> --expected-state <state>
lz ticket-effort-set --ticket <id> --real-effort <h> --real-effort-hh <h> --expected-rev <rev>
lz ticket-branch-set --hu <id> --ticket <id> --branch <name> --working-directory <path>
lz ticket-branch-checkout --branch <name> --working-directory <path>
lz ticket-branch-push --branch <name> --working-directory <path>
lz ticket-pr-create --hu <id> --ticket <id>
lz ticket-pr-link --hu <id> --ticket <id> --pr <id>
lz ticket-commit-link --ticket <id> --pr <id>
lz ticket-session-verify --branch <name> --base-branch <name> --working-directory <path>
lz ticket-completion-apply --hu <id> --ticket <id> --pr <id> --summary <texto de la sesión>
```

Three rules govern these:

- **Optimistic writes.** `ticket-state-set` requires the `--expected-state` it
  will find, and `ticket-effort-set` the `--expected-rev` the ticket was read at,
  so a ticket that moved underneath you fails instead of being silently
  overwritten. Read the value immediately before writing it.
- **`Done` is not reachable** from `ticket-state-set`. Only the coordinator
  applies it, after verifying every completion gate — which is why a ticket that
  "should be done" is a `ticket-completion-info` question, not a state write.
- **Reference names, never labels.** `--field <referenceName>=<value>` is
  repeatable and takes Azure reference names; display labels are never inferred
  (ADR-0006).

`hu-branch-set` without `--base-branch` links an existing remote branch; with it,
it creates the branch from that exact remote commit and publishes it first. It
never resets, cleans or discards worktree changes — a dirty worktree fails closed.
`hu-branch-ensure` is the provisioning half and is the one that defaults: with no
`--base-branch` it creates `hu/<HU>` from `master`, or `main` when the repository
has no `master`, exactly as `code --hu` does.

## GitHub queue

```bash
lz github-auth-info    --working-directory <path>
lz github-repo-info    --working-directory <path>
lz github-issue-list   --working-directory <path>
lz github-issue-select --working-directory <path>
lz github-issue-info    --issue <id> --working-directory <path>
lz github-issue-claim   --issue <id> --working-directory <path>
lz github-issue-release --issue <id> --working-directory <path>
```

`github-issue-list` classifies every candidate with the reason it is or is not
eligible, which is the answer to "why did `code` say the queue was empty".
`github-issue-select` applies the same ordering the run applies. A claim is the
run's own; `github-issue-release` releases only the authenticated user's claim.

## GitHub delivery

```bash
lz github-branch-prepare  --issue <id> --working-directory <path>
lz github-branch-checkout --branch <name> --base-branch <name> --working-directory <path>
lz github-branch-verify   --branch <name> --base-branch <name> --working-directory <path>
lz github-branch-cleanup  --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lz github-session-verify --branch <name> --base-branch <name> --working-directory <path>
lz github-commit-push   --branch <name> --commit <sha> --working-directory <path>
lz github-pr-create --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lz github-pr-merge  --pr <id> --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lz github-issue-close --issue <id> --pr <id> --commit <sha> --working-directory <path>
```

These are the coordinator's own delivery steps, in the order it performs them.
Running them by hand is for repairing a delivery that stopped midway; the
ordinary path is to rerun the `code` command, which resumes the same phase from
its checkpoint.

`github-session-verify` is the question the coordinator asks the moment a
session exits (ADR-0035): is the fixed branch ahead of its base, with a clean
worktree? It answers with the commit the delivery pushes, so a "the session said
it finished" doubt is settled by running it rather than by reading the session.

## git

```bash
lz git-branch-list --working-directory <path>
lz git-branch-checkout --branch <name> --working-directory <path>
lz git-branch-delete --branch <name> --base-branch <name> [--commit <sha>] --working-directory <path>
```

`git-branch-list` and `git-branch-checkout` are `yp checkout` split in two.
`git-branch-list` is its menu: it fetches every remote and lists the branches
newest commit first, with the active one under `current` rather than in the
list and no remote `HEAD` pointer. Every `name` it prints is accepted as is by
`git-branch-checkout`, which switches to that branch — `origin/feature-x` is
tracked as `feature-x` — and fast-forwards it to its upstream, never merging.
`fetched` and `pulled` report those steps; neither failing fails the command.

## Pull requests

```bash
lz pr-list --working-directory <path>
lz pr-info --pr <id> --working-directory <path>
lz pr-thread-list --pr <id> --working-directory <path>
lz pr-thread-reply --pr <id> --thread <id> --body <text> --working-directory <path>
lz pr-create --branch <name> --base-branch <name> --title <title> [--description <text> | --description-file <path>] --working-directory <path>
```

These are `yp pr` without its menu. The tracker is the one `origin` names —
`gh` for GitHub, `az` for Azure DevOps, whose organization must match
`LAZY_WORKFLOW_AZURE_ORGANIZATION` — and every answer carries it as `tracker`,
in one shape for both: review states are `approved`, `approved-with-suggestions`,
`changes-requested`, `rejected`, `commented` or `pending`, and a PR's status is
`open`, `merged` or `closed`.

- `pr-thread-list` returns what a person wrote, never Azure's system comments.
  A code comment carries its `path` and `line`; GitHub's general discussion is
  the thread `conversation`.
- `pr-thread-reply --thread` takes an `id` exactly as `pr-thread-list` printed
  it. On GitHub the thread must belong to `--pr`, or nothing is posted.
- `pr-create` writes no description of its own. Write it, then pass it inline
  with `--description` or, for anything longer than a line, with
  `--description-file`. Omitting both opens the PR with an empty description;
  Azure DevOps rejects one over 4000 characters.

## Describing the CLI

```bash
lz catalog                                                     # every command, flag, default and effect
lz catalog | jq -r '.commands[] | "\(.effect)\t\(.name)"'      # which commands write
lz catalog | jq '.commands[] | select(.name == "ticket-create")'
```

`catalog` takes no options, opens no session and writes no run log. Each flag
carries its `kind` (`integer`, `commit`, `directories`, `secret`…), whether it is
`required`, its `default`, its `choices`, and the flags it `requires` or
`conflicts` with; each command carries its `effect` (`read`, `write`, `session`,
`maintenance`) and the shared flag `groups` it accepts. The desktop GUI builds
its forms from exactly this document ([GUI.md](GUI.md)).

## Reading the output

- JSON on **stdout**, operator lines and errors on **stderr**. `2>/dev/null`
  in Bash or Zsh (`2>$null` in PowerShell)
  leaves parseable JSON; a failed command leaves stdout empty and the reason on
  stderr, so an empty stdout is never "no results".
- `--branch` and `--base-branch` accept the short name (`issue/201`) or the full
  ref (`refs/heads/issue/201`).
- `--commit` requires the full object name, because every tool that takes one
  compares it against a ref — an abbreviation fails that comparison as if the
  branch had moved.
- Tools open no session, so `--cli`, `--model`, `--variant` and `--fallback` do
  not apply. The reporter flags (`--verbose`, `--quiet`, `--no-color`) do.
