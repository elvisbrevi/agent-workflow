# Lazy Workflow

This context defines the language used by the repository's sole executable
agent.

## Language

**Lazy workflow**:
The Bun-based workflow in `agent/lazy-workflow/` that sends a prompt to
OpenCode and emits a normalized JSON result.
_Avoid_: issue runner, queue supervisor

**Reporter**:
The typed severity-aware output abstraction used by `agent/lazy-workflow/`.
Every workflow constructs a single `Reporter` via `createReporter()` and
funnels all operator messages through its `info`, `warn`, `error`, `debug`,
`start`, and `stop` methods. The Reporter decides whether each message
reaches the operator based on three global flags (`--verbose`, `--quiet`,
`--no-color`) and respects the `NO_COLOR=1` environment variable.
_Avoid_: ad-hoc console output, parallel log streams

**operator-output**:
The name of the file module (`src/output/operator-output.ts`) that hosts
the compat shim `reportOperator(message)`. The shim routes the existing
~100 call sites to the Reporter's `info` method and keeps a swappable
default Reporter. The Reporter is the abstraction; `operator-output` is
the seam name and the legacy entry point.
_Avoid_: new direct `console.log` calls, new top-level log helpers

**Terminal protocol marker**:
An exact machine-readable workflow token such as `TICKET_COMPLETED` or
`WORKFLOW_STEP_FINISHED`. CLI coordination writes these tokens directly to
stdout because reporter decoration, filtering, or severity would break their
control-plane contract. Human-readable results and diagnostics still use the
Reporter.
_Avoid_: routing operator prose through stdout protocol output

**GitHub repository run**:
A lazy-workflow `plan` or `code` invocation without `--hu`. It follows the
repository's GitHub conventions and never uses Azure coordination; `plan` runs
once, while `code` delegates one fixed issue at a time to a fresh OpenCode
session through a coordinator-owned delivery lifecycle.
_Avoid_: implicit Azure run, unscoped run

**GitHub managed queue**:
The open, non-epic GitHub issues carrying the repository's `ready-for-agent`
role. An issue may belong to the queue while blocked; eligibility additionally
requires an unclaimed issue whose native dependencies are closed.
_Avoid_: every open issue, prompt-selected work

**GitHub coordinated delivery**:
The `code` lifecycle in which lazy workflow selects and claims one issue,
fixes its identity for OpenCode, verifies every Git and GitHub effect, and
reconciles the queue before advancing. OpenCode prepares one implementation;
it does not select work or declare queue state.
_Avoid_: prompt-driven queue drain, autonomous issue selection

**GitHub parent reconciliation**:
The verified closure of an open native parent after all of its direct native
sub-issues and dependencies are closed. Reconciliation may continue through
the parent's ancestors and never infers hierarchy from prose or titles.
_Avoid_: checklist closure, title-based epic closure

**GitHub delivery checkpoint**:
The repository-scoped record that fixes an in-flight issue and its delivery
phase so recovery reconciles that issue before consulting the managed queue.
_Avoid_: selecting replacement work after partial delivery

**GitHub queue outcome**:
A coordinator-owned result distinguishing completed delivery, an empty managed
queue, a blocked managed queue, and delivery state requiring reconciliation.
_Avoid_: marker text supplied by OpenCode

**Azure HU run**:
A lazy-workflow invocation selected by `--hu`, or recovered from an Azure HU
checkpoint. It preserves the HU's planning or ticket-delivery lifecycle.
_Avoid_: GitHub repository run

**Default workflow prompt**:
The GitHub-only instructions used by a GitHub repository run for its selected
workflow and operator request.
_Avoid_: Azure HU prompt

**Azure HU planning run**:
A lazy-workflow invocation with `plan --hu <ID>`. It reads the Azure DevOps
User Story, combines that data with the English autoplan prompt, and starts
OpenCode in the selected working directory.
_Avoid_: Azure ticket delivery run

A fresh **Azure ticket delivery run** first queries the HU's native integration
branch and verifies or provisions `hu/<HU>` through structured
`--base-branch <name>` input before selecting a ticket, writing a checkpoint, or
starting OpenCode. The operator prompt is not a branch-management interface.

**Azure ticket delivery run**:
  A lazy-workflow invocation with `code --hu <ID>`. It delivers one eligible
  direct Task or Bug per fresh OpenCode session. The coordinator owns ticket
  selection, branches, pull requests, Azure fields, evidence, effort, completion
  gates, recovery, and cleanup; OpenCode owns only scoped implementation,
  validation, review, commit, and completion-manifest generation. OpenCode emits
  `IMPLEMENTATION_READY`, after which the coordinator verifies completion, removes
  the completed ticket branch, and refreshes Azure before selecting the next ticket.

**Azure multi-repository ticket delivery run**:
  A lazy-workflow invocation with `code --hu <ID> --ticket <ID>
  --working-directory <repo1,repo2,...> [--base-branch <name>]`. It runs one
  OpenCode session from the workspace parent directory, validates one
  completion manifest per changed repository, associates every changed-repository
  pull request and merge commit with the same ticket through native Azure
  ArtifactLinks, applies every existing completion gate before moving the ticket
  to `Done`, and only then transitions the HU from exactly `En Desarrollo` to
  exactly `Desarrollo Terminado` once no direct delivery children remain open.
  The single primary ticket Branch ArtifactLink points to the first changed
  repository while participant repositories keep their workspace branches
  without native links. Single-repository Azure ticket delivery remains
  unchanged when `--working-directory` is a single path.
_Avoid_: Azure HU planning run

**Azure workspace delivery checkpoint**:
The aggregate record kept in the workspace state directory that fixes the HU,
the ticket, the normalized repository list with its declared order and remote
identities, the accumulated active duration, and one unit per repository. It is
the only authority on which repositories were already delivered, so recovery
resumes the same run instead of restarting or reselecting work.
_Avoid_: per-repository Azure checkpoints, restarting a partial delivery

**Delivery receipt**:
The verified record that a repository's external delivery effect already
happened. A repository unit carrying one is reused as-is rather than repeated,
and a repository unit without one stays pending. Aggregate completion, the
ticket transition to `Done`, and the HU transition require a receipt for every
changed repository.
_Avoid_: rollback or revert pull requests after a partial merge

**Azure workspace branch topology**:
The resolved HU and ticket branch layout across the declared participant
repositories, including the anchor repository that owns the single native
Branch ArtifactLink for the HU and the candidate primary repository for the
ticket Branch ArtifactLink. The anchor is the existing HU Branch ArtifactLink
when present and unambiguous, otherwise the first declared repository. The
ticket primary anchor is later selected as the first repository that actually
produces changes.
_Avoid_: per-repository native Branch links, guessed base branches

**Azure HU integration branch preparation**:
The multi-repository preparation that resolves the anchor, verifies or
provisions `hu/<HU>` in each participant repository from a checked, clean
worktree and the explicit remote base branch, and writes the single native
Branch ArtifactLink only in the anchor repository.
_Avoid_: multiple native HU Branch links, implicit base branch

**Explicit command**:
The first argument must be a supported workflow command: `plan`, `code`,
`hu-info`, `hu-branch-info`, `hu-branch-set`, or a documented `ticket-*`
read/mutation command.
Missing or unsupported subcommands print help and do not call Azure Boards or
OpenCode.
_Avoid_: accidental OpenCode execution

**HU information query**:
The `hu-info --hu <ID>` command that prints the selected User Story as JSON
without starting OpenCode.
_Avoid_: planning execution

**HU integration branch query**:
The `hu-branch-info --hu <ID>` command that reads the HU's native Azure Git
`Branch` ArtifactLink and prints one normalized JSON object, `{ "hu": ID,
"branch": "refs/heads/..." | null }`, without starting OpenCode or mutating
Git or Azure. Missing links are `null`; malformed or conflicting native links
fail with a nonzero status.
_Avoid_: proposing a branch from the HU number

**HU integration branch assignment**:
The `hu-branch-set --hu <ID> --branch <name> [--base-branch <name>] --working-directory <path>`
command assigns an existing remote Azure Git branch to an HU, or creates the
missing branch from the exact remote commit named by `--base-branch`, through
its native Branch ArtifactLink. It validates the selected worktree's Azure
`origin`, preserves unsafe worktrees by failing closed, verifies Git before
Azure mutation, and rereads Azure after the update without invoking OpenCode.
_Avoid_: inferring a base branch or replacing an existing integration branch

**OpenCode result**:
The normalized JSON representation of OpenCode JSONL output, including the
session identifier, final text, stop reason, token counts, and cost when
available.
_Avoid_: raw transcript

**Azure login continuation**:
When an HU planning run encounters an `az login --use-device-code` request,
lazy-workflow preserves the OpenCode session, waits for Azure access, and
resumes that same session once with `continue`.
_Avoid_: automatic credential capture

**SAG norms context**:
An optional, phase-selected view of the engineering norms in the remote
`sag.desarrollo.ia.rag` `master` branch. A run records the resolved commit and
stops when the source cannot be read; summaries and procedural guidance do not
replace the identified normative rules.
_Avoid_: local SAG checkout, implicit SAG compliance

**SAG-scoped workflow**:
A workflow whose purpose and name are tied to SAG norms. Unlike `plan` and
`code`, it always loads SAG norms and has no non-SAG mode.
_Avoid_: generic workflow with implicit norms

**SAG infrastructure verification run**:
A tracker-scoped `infra-sag` run that verifies development prerequisites such
as repository, Consul configuration, and database availability without
provisioning them. Missing or unverifiable prerequisites become corrective
work in the source tracker.
_Avoid_: infrastructure provisioning run

**SAG architecture review run**:
A tracker-scoped `architecture-review-sag` run that reviews the completed scope
against applicable SAG architecture and design norms without correcting code.
Findings are synthesized into a specification and corrective tickets in the
source tracker.
_Avoid_: implementation run, automatic remediation

**SAG deployment run**:
A tracker-scoped `deploy-sag` run that discovers one unambiguous repository
deployment route and may execute it for DEV by default or explicit TEST/QA.
PROD and ambiguous or unverifiable deployment routes fail closed.
_Avoid_: production deployment, guessed pipeline

**SAG source scope**:
The complete Azure HU selected by `--hu`, or the single GitHub Issue selected
by `--issue`, used by a SAG-scoped workflow for context and publication.
_Avoid_: Azure child ticket, GitHub queue drain
