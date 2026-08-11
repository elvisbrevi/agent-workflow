# lazy-workflow

To install dependencies:

```bash
bun install
```

When installed globally by `install.sh --all-global` or
`install.sh --claude-global`, use the `lazy-workflow` command directly:

```bash
lazy-workflow plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
lazy-workflow code --prompt "deliver GitHub issue 123" --working-directory /path/to/repository
lazy-workflow plan --hu 23438 --working-directory /path/to/repository
lazy-workflow hu-branch-info --hu 23438
lazy-workflow hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --base-branch main --working-directory /path/to/repository
```

OpenCode events and periodic no-output heartbeats are printed with local
`dd/mm/yy HH:mm:ss` timestamps while the workflow runs. Events show their
session ID, reasoning summaries, tool status, and sanitized tool input such as
the shell command reported by OpenCode. The working directory is passed as
OpenCode's real process directory, so tools operate in the selected repository. Azure and OpenCode
retry messages are printed when a transient failure causes a retry.

## Default GitHub workflows

Without `--hu`, `plan` and `code` load `prompts/default-prompt.md` in
GitHub-only scope:

```bash
bun run main.ts plan --prompt "plan the requested change" \
  --working-directory /path/to/repository
bun run main.ts code --working-directory /path/to/repository
```

The default prompt follows the target repository's tracker and delivery
documentation, uses GitHub and `gh`, and forbids Azure DevOps and `az` tools.
These runs do not read Azure, inspect the HU checkpoint, prepare integration
branches, enforce Azure completion gates, or clean Azure ticket branches.
`--branch` and `--base-branch` are rejected in this GitHub scope.

`plan` remains a one-shot planning-only workflow. `code` refreshes GitHub,
delivers exactly one eligible issue in a fresh OpenCode session, closes that
session after `TICKET_COMPLETED`, and repeats. A final fresh session returns
`QUEUE_EMPTY` and stops the command. `WORKFLOW_STEP_FINISHED` closes every
provider session. There is no GitHub checkpoint or coordinator adapter.

## Azure HU workflows

Before a fresh `code` run selects a ticket or writes a checkpoint, the
coordinator queries the HU's native Branch link. It reuses a valid linked
branch, or verifies/creates `hu/<HU>` in the selected repository. Creating a
missing branch requires the structured `--base-branch <name>` option; the
operator prompt is never parsed for branch selection.

To plan an Azure HU:

```bash
bun run main.ts plan --hu 23438 --working-directory /path/to/repository
```

Planning uses the English autoplan prompt and never implements code. Missing or
unsupported subcommands print help and do not call Azure Boards or OpenCode.

To obtain the information of a HU:

```bash
bun run main.ts hu-info --hu 23438
```

To query the HU integration branch without starting OpenCode or changing Git
or Azure:

```bash
bun run main.ts hu-branch-info --hu 23438
```

The command prints one indented JSON object with the HU number and either the
normalized native Azure Git branch (`refs/heads/...`) or `null` when no Branch
ArtifactLink exists. Malformed or multiple distinct Branch links fail with a
nonzero status; the command never proposes `hu/<HU>`.

To inspect one Azure delivery ticket without starting OpenCode:

```bash
bun run main.ts ticket-info --hu 23438 --ticket 23459
bun run main.ts ticket-description-info --ticket 23459
bun run main.ts ticket-state-info --ticket 23459
bun run main.ts ticket-effort-info --ticket 23459
bun run main.ts ticket-attachment-info --ticket 23459
bun run main.ts ticket-evidence-info --ticket 23459
bun run main.ts ticket-completion-apply --hu 23438 --ticket 23459 --pr 123 --manifest /path/to/completion.json
bun run main.ts ticket-pr-link --hu 23438 --ticket 23459 --pr 123
bun run main.ts ticket-commit-link --ticket 23459 --pr 123
bun run main.ts ticket-attachment-add --ticket 23459 --file evidence.json --kind http-json
bun run main.ts ticket-evidence-set --ticket 23459 --evidence-file completion.html
bun run main.ts ticket-branch-info --hu 23438 --ticket 23459
bun run main.ts ticket-branch-set --hu 23438 --ticket 23459 \
  --branch ticket/23459 --working-directory /path/to/repository
bun run main.ts ticket-pr-info --hu 23438 --ticket 23459
bun run main.ts ticket-completion-info --hu 23438 --ticket 23459
```

Each command emits one normalized JSON object. The aggregate response includes
the direct ticket identity, description, state, revision, effort, ticket and
HU branches, pull-request candidates, canonical association, merge commit,
attachments, completion evidence, and all satisfied or unmet completion gates.
Azure CLI reads are attempted first; unsupported or broken read routes use the
authenticated Azure DevOps REST boundary.

To assign an already existing remote branch to an HU, omit `--base-branch`:

```bash
bun run main.ts hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --working-directory /path/to/repository
```

The command normalizes the branch, reads the HU project and the selected
worktree's Azure `origin`, verifies the exact remote ref, and creates the native
Branch ArtifactLink with the resolved project and repository IDs. The same
link is idempotent; a different or ambiguous link fails without replacing it.
Azure is reread before success, the result is one indented JSON object, and
OpenCode is never started.

To create the HU branch on first use, provide an explicit remote base:

```bash
bun run main.ts hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --base-branch main --working-directory /path/to/repository
```

When the desired branch is absent, the command requires `--base-branch`,
creates it from that exact remote commit, publishes it, verifies the remote
ref, and only then creates the Azure link. It does not reset, clean, checkout,
or discard worktree changes; a dirty worktree fails closed.

To drain the HU's direct Task and Bug delivery tickets one at a time:

```bash
bun run main.ts code --hu 23438 --base-branch main \
  --working-directory /path/to/repository
```

Omit `--base-branch` when the HU is already linked or the expected remote
`hu/23438` branch already exists. A branch preflight failure stops once,
without selecting a ticket, writing a checkpoint, or starting OpenCode.

After `IMPLEMENTATION_READY`, the coordinator closes OpenCode, validates the
manifest from Git common metadata, creates or reuses exactly one HU-targeted
pull request, publishes effort and evidence through typed idempotent commands,
verifies every completion gate, and only then moves the ticket to `Done`.
An already absent session is safe; any other closure failure stops the run with
the pinned ticket in a sessionless checkpoint. A later invocation resumes the
coordinator phase without asking OpenCode to repair Azure metadata, switches to
the updated HU integration branch, deletes the completed ticket branch locally
and remotely, clears the checkpoint, and refreshes Azure before starting the
next eligible ticket. Branch cleanup stops safely when the working tree
contains uncommitted or untracked changes.

To recover an interrupted ticket, use the opaque session identifier printed by
OpenCode. The HU and ticket are restored from the repository checkpoint, so no
`--hu` argument is needed:

```bash
bun run main.ts code --session <session-id> --prompt continue
```

Recovery and sessionless reconciliation first reacquire the HU's native Branch
link through the deterministic branch service, then rebuild the pinned ticket
context. A recovered ticket already in `Done` is verified and reconciled before
OpenCode can be resumed. If the recorded provider session no longer exists,
the checkpoint becomes sessionless and stops without an infinite retry loop.
A missing, malformed, conflicting, or otherwise invalid branch state stops once
with an actionable error; the checkpoint, OpenCode session, and ticket branch
remain untouched. Correct the reported branch state and rerun the same command
to preserve the checkpoint's ticket identity.

The deterministic ownership contract for Azure/Git ticket effects is specified in
[`docs/agents/deterministic-ticket-operations.md`](../../docs/agents/deterministic-ticket-operations.md).

The complete command help is available with an unsupported subcommand or no
subcommand. `--model`, `--variant`, `--prompt`, and `--working-directory` are
forwarded to OpenCode; `--number-of-questions` applies to `plan`. Supplying an
invalid `--hu` fails instead of falling back to GitHub.

Autocode stores a versioned checkpoint in repository Git metadata. It records
the phase, immutable HU/ticket/branch identities, Azure revision, effort
baseline, active duration, opaque OpenCode session, manifest path, pull request,
and verified effect receipts. Legacy four-field checkpoints migrate
conservatively to `implementing`. Failed or incomplete attempts retry the same
ticket every ten seconds; `IMPLEMENTATION_READY` replaces the session with
`null`, and the checkpoint is removed only after live completion verification.

If sessionless reconciliation finds incomplete Azure completion gates, it
prints the pinned ticket followed by stable reasons such as
`pinned-ticket-context`, `ticket-state`, `completion-evidence`, `real-effort`, `real-effort-hours`,
`commit-url`, `attached-capture`, `hu-integration-branch`,
`completed-hu-targeted-pr`, `native-pr-association`, or
`merge-commit-artifact-link`. The checkpoint remains intact: no OpenCode
session, branch cleanup, or later ticket is selected. Correct the reported
Azure data and rerun the same `code` command to reconcile safely; Azure
command or authentication failures remain operational errors and are not
reported as completion gates.

If OpenCode requests `az login`, lazy-workflow keeps the OpenCode session,
prints `az login --use-device-code`, waits until the HU is accessible again,
and resumes that session once with `continue`.

## Structure

```text
main.ts                 CLI entrypoint
prompts/                OpenCode prompt assets
src/azure/              Azure Boards model and service
src/cli/                Workflow coordination
src/git/                Verified ticket-branch cleanup
src/opencode/           OpenCode execution and JSONL result
test/                   Bun tests
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
