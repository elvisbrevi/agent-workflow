# lazy-workflow

To install dependencies:

```bash
bun install
```

When installed globally by `install.sh --all-global` or
`install.sh --claude-global`, the installer prepares the locked Bun
dependencies in its managed cache. Use the `lazy-workflow` command directly:

```bash
lazy-workflow plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
lazy-workflow code --prompt "deliver GitHub issue 123" --working-directory /path/to/repository
lazy-workflow architecture-review-sag --issue 154 --working-directory /path/to/repository
lazy-workflow architecture-review-sag --hu 23438 --working-directory /path/to/repository
lazy-workflow infra-sag --issue 155 --working-directory /path/to/repository
lazy-workflow deploy-sag --issue 157 --working-directory /path/to/repository
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

## Reporter and verbosity

The lazy-workflow Reporter is the typed abstraction that emits operator
output. Three global flags select its mode and propagate through every
workflow:

```bash
lazy-workflow code --working-directory /path/to/repository        # default (info, warn, error)
lazy-workflow code --verbose --working-directory /path/to/repository   # info, warn, error, debug
lazy-workflow code --quiet   --working-directory /path/to/repository   # error only
lazy-workflow code --no-color --working-directory /path/to/repository  # ANSI stripped
```

`--verbose` and `--quiet` are mutually exclusive. `--no-color` is independent
and stacks with either verbosity. The Reporter keeps the existing
`operator-output` file module name as a compat shim, so `reportOperator(...)`
continues to route to `info` regardless of which verbosity flag is active.

A single `code` GitHub run against a delivery that includes one reasoning
step, three tool uses, and one terminal `IMPLEMENTATION_READY` text event
produces a different volume of operator output per mode. The blocks below
show the full transcript each flag emits, with ANSI stripped so the examples
are copy-pasteable:

**Default** (`code --working-directory /repo`) — info + warn + error only,
5 to 15 lines for a typical ticket delivery, GitHub-Actions style:

```text
ℹ OpenCode iniciado en /repo
ℹ OpenCode [sesión ses_delivery] inició un paso
ℹ OpenCode [sesión ses_delivery] terminó un paso (stop)
ℹ OpenCode [sesión ses_delivery]: IMPLEMENTATION_READY
ℹ lazy-workflow: no quedan issues GitHub elegibles.
```

**Verbose** (`code --verbose --working-directory /repo`) — preserves the full
event stream; reasoning and tool_use surface as debug lines that the default
mode hides:

```text
ℹ OpenCode iniciado en /repo
· OpenCode [sesión ses_delivery] razonando: Analizando cambios pendientes
· OpenCode [sesión ses_delivery] herramienta bash (completed): "git status --short"
· OpenCode [sesión ses_delivery] herramienta read (completed): "/repo/AGENTS.md"
· OpenCode [sesión ses_delivery] herramienta edit (completed): "/repo/README.md"
ℹ OpenCode [sesión ses_delivery] inició un paso
ℹ OpenCode [sesión ses_delivery] terminó un paso (stop)
ℹ OpenCode [sesión ses_delivery]: IMPLEMENTATION_READY
ℹ lazy-workflow: no quedan issues GitHub elegibles.
```

**Quiet** (`code --quiet --working-directory /repo`) — only error lines
reach the operator; info and warn are silenced, and the run is silent
unless something fails:

```text
✗ lazy-workflow: OpenCode terminó con error.
```

`--no-color` can be stacked on top of any of the three modes above and
strips ANSI from every line, leaving only the icon, the space, and the
message.

## Default GitHub workflows

Without `--hu`, `plan` and `code` run in GitHub-only scope, each receiving the
GitHub scope fragment plus its own workflow's instructions:

```bash
bun run main.ts plan --prompt "plan the requested change" \
  --working-directory /path/to/repository
bun run main.ts plan --normas-sag --working-directory /path/to/repository
bun run main.ts code --working-directory /path/to/repository
```

The default prompt follows the target repository's tracker and delivery
documentation, uses GitHub and `gh`, and forbids Azure DevOps and `az` tools.
These runs do not read Azure, inspect the HU checkpoint, prepare integration
branches, enforce Azure completion gates, or clean Azure ticket branches.
`--branch` and `--base-branch` are rejected in this GitHub scope.

`plan` remains a one-shot planning-only workflow. `code` refreshes GitHub,
delivers each eligible issue in its own fresh OpenCode session, and coordinates
delivery from `IMPLEMENTATION_READY` through verified merge, issue closure,
parent reconciliation, and branch cleanup. After each verified delivery it
re-selects the next eligible issue in the same run until the queue is empty or
blocked. The coordinator emits
`TICKET_COMPLETED` followed by `WORKFLOW_STEP_FINISHED` only after those gates
pass; the provider cannot declare delivery or queue outcomes. A repository-
scoped GitHub checkpoint and lock preserve a fixed interrupted issue; startup
resumes an active session or reconciles a post-readiness delivery without
selecting replacement work.

GitHub recovery validates the repository and acquires its lock before switching
to the exact local branch recorded by the checkpoint. A dirty worktree, active
Git operation, missing branch, or branch unavailable to the current worktree
stops recovery before OpenCode or queue access. Recovery never creates, guesses,
resets, or force-switches a branch.

When GitHub reports a canonical PR as conflicting with its base, the
coordinator fetches and fixes the exact base commit, then starts a conflict-only
OpenCode session for the same Issue, branch, PR and repository. Delivery
continues only after the new manifest is clean and its commit contains both the
original implementation and fixed base commits. Interrupted reconciliation is
checkpointed and resumes without selecting another Issue; this applies to
single-repository and workspace delivery.

`plan --normas-sag` and `code --normas-sag` are opt-in. They read the canonical SAG `master` branch and
requires `.sag/config.json` with an explicit `tipo` of `api`, `bff`, or
`nextjs`; it never infers the component from source layout. OpenCode receives
the resolved commit, stable normative rule IDs, source URLs, selection reasons,
and explicit `needsDecision` values for unknown applicability. An unavailable
source or invalid configuration stops before OpenCode. Coding selects common
and component rules plus families supported by explicit artifacts and
capabilities. Plain `plan` and `code` do not access SAG sources. If the
canonical source requires authentication, provide
`AZURE_DEVOPS_EXT_PAT`; its value is used only in the request Authorization
header and is never persisted or sent to OpenCode.

`architecture-review-sag` always loads the canonical SAG `master` branch and
requires exactly one explicit `--issue` or `--hu` plus `.sag/config.json`. It
reviews architecture without changing the reviewed code. Numbered norms stay
separate from procedural guidance; findings are synthesized and published as
corrective tracker work with `/to-spec` and `/to-tickets` semantics. A clean
review publishes nothing, and the command never deploys or requires another
SAG workflow.

`deploy-sag` always loads delivery norms and requires exactly one explicit
`--issue` or `--hu`. It reads the explicit `deployment` route in
`.sag/config.json`, asks an authenticated external adapter to verify one
pipeline v7, Release Definition, repository/base branch, and the selected
DEV, TEST, or QA target, then verifies the external deployment state. DEV is
the default. PROD and every production alias fail before external mutation;
ambiguous or unverifiable routes fail closed. Repeated runs reconcile by
environment, route, and scope identity rather than triggering a duplicate.

`infra-sag` always loads infrastructure norms and requires exactly one explicit
`--issue` or `--hu`. It verifies repository identity/base branch, Consul
configuration, and explicitly declared database, pipeline, and Release
Definition prerequisites through a read-only authenticated adapter and records
the versioned config/Consul contracts used. Missing or
unverifiable checks are published as corrective work, and the command never
provisions infrastructure.

The deployment configuration has this shape (identities are examples, not
inferred defaults):

```json
{
  "tipo": "api",
  "deployment": {
    "authentication": "operator",
    "adapter": { "command": [".sag/deploy-adapter"] },
    "route": {
      "repository": "project/repository",
      "baseBranch": "main",
      "pipeline": { "id": "pipeline-7", "version": "v7" },
      "releaseDefinition": { "id": "release-1" },
      "openShift": { "id": "openshift-dev", "evidence": "authoritative-openshift-evidence" },
      "consul": { "deployKey": "project/deploy", "requiredVariables": ["DATABASE_URL"], "evidence": "authoritative-consul-evidence" },
      "target": { "id": "openshift-dev", "environment": "dev", "evidence": "authoritative-target-evidence" }
    }
  }
}
```

The adapter is executed without a shell and receives JSON on stdin with
`--operation discover|reconcile|verify`. It must use operator authentication,
return exactly one route for `discover`, atomically reconcile the idempotency
key, and return independently verified OpenShift, Consul, and target evidence.
Authentication continuation is signaled with exit code 0 and
`{"authenticationRequired":true}`; nonzero exits are terminal adapter errors.

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

The session decides how to slice the User Story and returns a delivery plan
behind a `PLAN_READY` marker; it creates no Azure work items. The coordinator
validates the whole plan first — duplicate titles, unknown blockers, and
blocking cycles are rejected before anything is created — then publishes the
work items in dependency order and records the blocking relations in a second
pass, when it can name real ids. Publication is idempotent, so rerunning a plan
reuses its work items instead of duplicating them, and an empty plan publishes
nothing. The same primitives are available directly:

```bash
bun run main.ts ticket-create --hu 23438 --type Task --title "Slice uno" \
  --description-file ./description.html --estimate 8
bun run main.ts ticket-link-parent --parent 23438 --child 23459
bun run main.ts ticket-link-predecessor --blocker 23459 --blocked 23460
```

Beyond the system fields, name any field explicitly with
`--field <referenceName>=<value>`; reference names are never inferred from
display labels.

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

The same recovery path can continue the preserved GitHub or Azure session with
an explicitly selected model:

```bash
bun run main.ts code --session <session-id> \
  --model openai/gpt-5.6-luna --variant high --prompt continue
```

Only explicitly supplied `--model` and `--variant` values override the existing
session. Omitted values remain unchanged. This does not recover a session
removed with `opencode session delete`.

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

## Multi-repository workspaces

`plan` and `code` accept a comma-separated `--working-directory` list to plan or
deliver one unit of work across several repositories in a single OpenCode
session:

```bash
bun run main.ts plan --working-directory /path/to/repo-a,/path/to/repo-b
bun run main.ts plan --hu 23438 --working-directory /path/to/repo-a,/path/to/repo-b
bun run main.ts code --working-directory /path/to/repo-a,/path/to/repo-b
bun run main.ts code --hu 23438 --ticket 51 \
  --working-directory /path/to/repo-a,/path/to/repo-b
```

`plan` only inspects the declared repositories: it prepares no branches, writes
no workspace state, and mutates no tracker item, with or without `--hu`.

**Scope.** Each entry must be the root of a Git repository with an `origin`
remote and a clean worktree. Entries are canonicalised, duplicates are
rejected, and the declared order is the delivery order. All repositories must
belong to the same provider: GitHub for the default scope, Azure DevOps when
`--hu` is given (`code` also requires `--ticket`). A single path keeps the existing
single-repository behavior unchanged — no workspace state is created and no
aggregate checkpoint is read or written.

**Workspace state.** The coordinator resolves a common parent directory of the
declared repositories and keeps aggregate state in `<parent>/.lazy-workflow/`,
outside every source repository. It holds the aggregate checkpoint
(`github-workspace-code-checkpoint.json` or
`azure-workspace-code-checkpoint.json`) and, for GitHub, the delivery manifest.
Per-repository completion manifests stay inside each repository's Git common
directory.

**Serial execution.** One OpenCode session works across the whole workspace.
After `IMPLEMENTATION_READY` the coordinator verifies every per-repository
manifest, then delivers the changed repositories one at a time in the declared
order: push, create or reuse the pull request against that repository's own
base or HU integration branch, associate it with the Issue or ticket, and
merge. Repositories without changes must end clean; their temporary branches
are deleted safely. The Issue is closed — or the Azure ticket completed and the
HU moved from `En Desarrollo` to `Desarrollo Terminado` — only after every
required repository unit and every tracker gate is verified. GitHub parent
reconciliation and the Azure HU transition never run on a partial delivery.

**Azure primary repository.** A ticket carries exactly one native Branch
ArtifactLink. The coordinator prepares the ticket branch in every participant
repository but writes that link only after the session finishes, to the first
repository in declared order that produced a completion manifest. That primary
repository need not be the HU's anchor; its pull request and merge commit are
where the ticket's completion gates are read, and the other changed
repositories stay correlated through their own native PR and merge-commit
associations. The choice is recorded in the checkpoint so recovery reuses it.

**Recovery.** Rerun the same command to resume an interrupted workspace run.
Recovery requires the exact same normalized repository list, in the same
declared order, with the same remote identities, and — for Azure — the same HU
and ticket. An added, removed, reordered or remote-changed repository stops the
run before any external effect and leaves the checkpoint untouched. A pull
request that was already created, associated and merged is reused through its
recorded receipt rather than created twice; a failure in one repository leaves
the later ones pending and preserves the aggregate checkpoint. Nothing is
rolled back or reverted after a partial merge — fix the cause and rerun.
`--session <id>` must match the session stored in the checkpoint.

## Coding agent CLI

Every command that opens a session — `plan`, `code`, and the SAG-scoped
workflows — runs it through one coding agent CLI, selected once per run with
`--cli`. The default is `opencode`; omitting the flag behaves exactly as before.

```bash
lazy-workflow plan --cli claudecode --model claude-opus-5 --variant high \
  --working-directory /path/to/repository
```

`--model` is the model of the selected CLI, and `--variant` is its effort level:
Claude Code accepts `low`, `medium`, `high`, `xhigh`, and `max`, and rejects any
other value before opening the session. When you name a `--cli`, its binary —
`opencode` or `claude` — is verified while the arguments are parsed, so a
missing installation is reported before a session starts.

Claude Code sessions run non-interactively with its JSON event stream, take the
session identifier from the CLI's own initialization event, and never use
`--bare`, so the operator's login and the target repository's `CLAUDE.md` stay
available. Its events reach the Reporter with the same severities as OpenCode's:
assistant text as info, reasoning and tool calls as debug.

`--cli` is accepted by every command that opens a session — `plan`, `code`, and
the three SAG-scoped workflows — and each keeps its own rules whichever CLI runs
it:

```bash
lazy-workflow architecture-review-sag --issue 154 --cli claudecode \
  --working-directory /path/to/repository
lazy-workflow deploy-sag --issue 157 --environment qa --cli claudecode \
  --working-directory /path/to/repository
```

The review session runs with the `lazy-review` authority in the format of its own
CLI, so it cannot modify the reviewed tree in either; `deploy-sag` refuses PROD
and its aliases before any external effect; and `infra-sag` and `deploy-sag`
verify and deploy without opening a session at all, so `--cli` only names the CLI
their run resolves.

Delivery records the owning CLI in its checkpoint, so `--session <id>` resumes
against the CLI that opened the session, and a `--cli` that contradicts the
checkpoint fails closed with the checkpoint preserved.

## Agent authority

Every run carries an agent authority profile alongside its prompt. The prompt
states what the coding agent should decide; the profile states what it may
execute. The same five profiles exist in both formats, one per CLI, and neither
file is generated from the other: each provider validates and enforces its own.

For OpenCode the profiles live in `opencode/authority.json`, injected per run
through `OPENCODE_CONFIG`, which merges with the target repository's own OpenCode
configuration rather than replacing it — enforcement does not require the target
repository to be configured for lazy-workflow. For Claude Code each profile is
its own settings file under `claudecode/<profile>.json`, injected per run by path
with `--settings`.

| Profile | Used by | Denies |
|---|---|---|
| `lazy-github-plan` | `plan` without `--hu` | pushes, branch and remote mutation, `gh pr`/`gh api`, all `az` |
| `lazy-github-code` | `code` without `--hu` | the above plus every `gh issue` mutation |
| `lazy-azure-plan` | `plan --hu` | pushes, branch and remote mutation, all `az` and `gh` |
| `lazy-azure-code` | `code --hu` | the above; the coordinator owns every Azure and remote effect |
| `lazy-review` | `architecture-review-sag` | edits, and every mutating `git`, `gh`, and `az` command |

OpenCode runs with `--auto` and Claude Code with `--permission-mode
bypassPermissions`, which auto-approve only what is not explicitly denied, so
these deny rules are the enforcement surface. A denied command fails
as a permission error rather than relying on the model to obey prose; compound
commands are matched per sub-command, so `cd x && git push` is denied too.
Committing stays allowed in the delivery profiles because the completion
manifest names a commit the session must produce.

## Structure

```text
main.ts                 CLI entrypoint
prompts/                OpenCode prompt assets (composed by src/prompts/)
opencode/authority.json Agent permission profiles injected per run (OpenCode)
claudecode/             One settings file per profile, injected per run (Claude Code)
src/prompts/            Prompt composition, contract vocabulary, authority profiles
src/azure/              Azure Boards model and service
src/github/             GitHub tracker boundaries for SAG review publication
src/sag/                SAG norm retrieval and deployment coordination
src/cli/                Workflow coordination
src/git/                Verified ticket-branch cleanup
src/coding-agent/       Coding agent seam: contract, result, process and CLI selection
src/opencode/           OpenCode execution and JSONL result
src/claude-code/        Claude Code execution and stream JSON result
test/                   Bun tests
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
