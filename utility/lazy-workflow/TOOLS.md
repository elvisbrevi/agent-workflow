# The tool layer

Every effect a workflow has on Azure Boards, GitHub or git is also a command of
its own. It opens no session, prints the JSON its adapter returned on stdout,
exits `0` or `1`, and shares the adapter the workflow uses — so a tool validates
exactly as the workflow step it mirrors does (ADR-0026). That is what makes these
safe to run while deciding: they cannot answer differently from the run itself.

Contents: [Choosing one](#choosing-one) · [Preflight chains](#preflight-chains) ·
[Azure reads](#azure-reads) · [Azure writes](#azure-writes) ·
[GitHub queue](#github-queue) · [GitHub delivery](#github-delivery) ·
[git](#git) · [Reading the output](#reading-the-output)

## Choosing one

| The question | The tool |
|---|---|
| What is this HU, and what hangs off it? | `hu-info`, `hu-children-info` |
| Does the HU have an integration branch? Do I need `--base-branch`? | `hu-branch-info` |
| Everything known about one ticket | `ticket-info --hu --ticket` |
| One facet of a ticket | `ticket-{description,state,effort,attachment,evidence,type}-info` |
| Why is this ticket not `Done`? | `ticket-completion-info --hu --ticket` — prints the unmet gates |
| Can this environment reach GitHub at all? | `github-auth-info`, `github-repo-info` |
| What would a `code` run take next, and why does it skip the rest? | `github-issue-select`, `github-issue-list` |
| Everything about one issue, with its eligibility reasons | `github-issue-info --issue` |
| Free an issue an interrupted run still holds | `github-issue-release --issue` |
| Repair a half-finished delivery step | `github-branch-prepare`, `github-commit-push`, `github-pr-create`, `github-pr-merge`, `github-issue-close`, `github-branch-cleanup` |
| Write the completion manifest a delivery session must leave behind | `ticket-manifest-set` (Azure), `github-manifest-set` (GitHub) — never by hand |
| Publish tracker work without planning it | `ticket-create`, `ticket-link-parent`, `ticket-link-predecessor` |
| Attach the completion evidence a gate is waiting for | `ticket-pr-link`, `ticket-commit-link`, `ticket-attachment-add`, `ticket-evidence-set`, `ticket-completion-apply` |

Reads are free to run. Writes change a real backlog: run them when the user asked
for that effect, and prefer rerunning the workflow command, which performs the
same step with its own verification, over hand-driving a sequence of writes.

## Preflight chains

The reads worth doing before spending a session. `scripts/preflight.sh` runs
exactly these and returns them as one JSON document.

```bash
# Before plan/code --hu
lazy-workflow hu-info         --hu 23438
lazy-workflow hu-children-info --hu 23438     # what is already published
lazy-workflow hu-branch-info  --hu 23438      # "branch": null → the first code run needs --base-branch

# Before code in GitHub scope
lazy-workflow github-auth-info    --working-directory /repo
lazy-workflow github-repo-info    --working-directory /repo
lazy-workflow github-issue-list   --working-directory /repo   # every candidate and why it is skipped
lazy-workflow github-issue-select --working-directory /repo   # what the run would actually take

# Before declaring a ticket stuck
lazy-workflow ticket-info            --hu 23438 --ticket 23459
lazy-workflow ticket-completion-info --hu 23438 --ticket 23459
```

## Azure reads

```bash
lazy-workflow hu-info --hu <id>
lazy-workflow hu-children-info --hu <id>
lazy-workflow hu-branch-info --hu <id>
lazy-workflow ticket-info --hu <id> --ticket <id>
lazy-workflow ticket-type-info --ticket <id>
lazy-workflow ticket-{description,state,effort,attachment,evidence}-info --ticket <id>
lazy-workflow ticket-{branch,pr,completion}-info --hu <id> --ticket <id>
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
lazy-workflow hu-branch-set --hu <id> --branch <name> [--base-branch <name>] --working-directory <path>
lazy-workflow hu-branch-ensure --hu <id> [--base-branch <name>] --working-directory <path>
lazy-workflow hu-state-set --hu <id> --state <state> --expected-state <state> --expected-rev <rev>
lazy-workflow ticket-create --hu <id> --type <Task|Bug> --title <title> --description-file <path> \
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
lazy-workflow ticket-manifest-set --ticket <id> --branch <name> --manifest <path> [--commit <sha>] \
  --validation <command> --validation-result <outcome> \
  --evidence <http-json|screen|command-output>:<path> --working-directory <path>
```

Four rules govern these:

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
- **The manifest is never hand-written.** `ticket-manifest-set` is the only way a
  completion manifest is created: it takes the identities and what you ran, then
  resolves the commit from HEAD, computes every SHA-256 digest from the evidence
  files, and validates the result with the same code the coordinator's delivery
  gate runs — so a manifest either lands verifiable or does not land at all. A
  manifest typed by hand is how a delivery ends with `"ticket": "23575"`, a
  `currentCommit` key, or an evidence kind that was never in the enum.

`hu-branch-set` without `--base-branch` links an existing remote branch; with it,
it creates the branch from that exact remote commit and publishes it first. It
never resets, cleans or discards worktree changes — a dirty worktree fails closed.

## GitHub queue

```bash
lazy-workflow github-auth-info    --working-directory <path>
lazy-workflow github-repo-info    --working-directory <path>
lazy-workflow github-issue-list   --working-directory <path>
lazy-workflow github-issue-select --working-directory <path>
lazy-workflow github-issue-info    --issue <id> --working-directory <path>
lazy-workflow github-issue-claim   --issue <id> --working-directory <path>
lazy-workflow github-issue-release --issue <id> --working-directory <path>
```

`github-issue-list` classifies every candidate with the reason it is or is not
eligible, which is the answer to "why did `code` say the queue was empty".
`github-issue-select` applies the same ordering the run applies. A claim is the
run's own; `github-issue-release` releases only the authenticated user's claim.

## GitHub delivery

```bash
lazy-workflow github-branch-prepare  --issue <id> --working-directory <path>
lazy-workflow github-branch-checkout --branch <name> --base-branch <name> --working-directory <path>
lazy-workflow github-branch-verify   --branch <name> --base-branch <name> --working-directory <path>
lazy-workflow github-branch-cleanup  --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lazy-workflow github-manifest-info --manifest <path> --working-directory <path>
lazy-workflow github-manifest-set  --issue <id> --branch <name> --manifest <path> [--commit <sha>] \
  --summary <text> --validation <command> --validation-result <outcome> \
  [--evidence <path-in-repository>] --working-directory <path>
lazy-workflow github-commit-push   --branch <name> --commit <sha> --working-directory <path>
lazy-workflow github-pr-create --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lazy-workflow github-pr-merge  --pr <id> --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>
lazy-workflow github-issue-close --issue <id> --pr <id> --commit <sha> --working-directory <path>
```

These are the coordinator's own delivery steps, in the order it performs them.
Running them by hand is for repairing a delivery that stopped midway; the
ordinary path is to rerun the `code` command, which resumes the same phase from
its checkpoint.

`github-manifest-set` is the exception: it is not a repair, it is how a delivery
session produces its manifest in the first place. It fills in what it can verify —
the commit from HEAD, `clean` from the real worktree state, every digest from the
file — so the only things declared are the ones only the session knows. Its
`--evidence` paths live **inside** the repository, unlike the Azure manifest's,
whose evidence must stay out of the worktree.

## git

```bash
lazy-workflow git-branch-delete --branch <name> --base-branch <name> [--commit <sha>] --working-directory <path>
```

## Reading the output

- JSON on **stdout**, operator lines and errors on **stderr**. `2>/dev/null`
  leaves parseable JSON; a failed command leaves stdout empty and the reason on
  stderr, so an empty stdout is never "no results".
- `--branch` and `--base-branch` accept the short name (`issue/201`) or the full
  ref (`refs/heads/issue/201`).
- `--commit` requires the full object name, because every tool that takes one
  compares it against a ref — an abbreviation fails that comparison as if the
  branch had moved. The manifest tools resolve it from HEAD when it is omitted,
  which is what a delivery session should let them do.
- `--validation` and `--validation-result` are repeatable and pair **by
  position**: the first result belongs to the first command. They are two flags
  rather than one because a real validation command carries whatever separator a
  single flag would need (`dotnet test --filter A::B /p:X=Y`). A count mismatch
  fails naming both flags.
- Tools open no session, so `--cli`, `--model`, `--variant` and `--fallback` do
  not apply. The reporter flags (`--verbose`, `--quiet`, `--no-color`) do.
