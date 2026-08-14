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

Without `--hu`, `plan` and `code` load `prompts/default-prompt.md` in
GitHub-only scope:

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
delivers exactly one eligible issue in a fresh OpenCode session, and coordinates
delivery from `IMPLEMENTATION_READY` through verified merge, issue closure,
parent reconciliation, and branch cleanup. The coordinator emits
`TICKET_COMPLETED` followed by `WORKFLOW_STEP_FINISHED` only after those gates
pass; the provider cannot declare delivery or queue outcomes. A repository-
scoped GitHub checkpoint and lock preserve a fixed interrupted issue; startup
resumes an active session or reconciles a post-readiness delivery without
selecting replacement work.

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

## Structure

```text
main.ts                 CLI entrypoint
prompts/                OpenCode prompt assets
src/azure/              Azure Boards model and service
src/github/             GitHub tracker boundaries for SAG review publication
src/sag/                SAG norm retrieval and deployment coordination
src/cli/                Workflow coordination
src/git/                Verified ticket-branch cleanup
src/opencode/           OpenCode execution and JSONL result
test/                   Bun tests
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
