# Lazy Workflow

This context defines the language used by the repository's sole executable
agent.

## Language

**Lazy workflow**:
The Bun-based workflow in `agent/lazy-workflow/` that sends a prompt to the
run's coding agent CLI and emits a normalized JSON result.
_Avoid_: issue runner, queue supervisor

**Reporter**:
The typed severity-aware output abstraction used by `agent/lazy-workflow/`.
Every workflow constructs a single `Reporter` via `createReporter()` and
funnels all operator messages through its `info`, `warn`, `error`, `debug`,
`trace`, `heading`, `start`, and `stop` methods. The Reporter decides whether
each message reaches the operator based on four global flags (`--verbose`,
`--verbose-output`, `--quiet`, `--no-color`) and respects the `NO_COLOR=1`
environment variable.
_Avoid_: ad-hoc console output, parallel log streams

**Parsed output**:
The Reporter's default rendering: every line stamped with the local
`dd/mm/yy HH:mm:ss` date and time, a gutter its continuation lines hang from,
one glyph per level, and a rounded panel opening the run — the style of the
Bagels TUI, on its tokyo-night palette.
_Avoid_: unstamped lines, per-workflow formatting

**Verbose output**:
The widest reading of a run, selected with `--verbose-output`. It implies
`--verbose` and adds the `trace` level: the whole input of every tool call, the
output the tool returned, and the raw event the agent CLI emitted. It is what
answers which file a session is editing while it edits it.
_Avoid_: a third mode narrower than `--verbose`, raw dumps in the parsed stream

**Run log**:
The machine-readable reading of a run: one JSON Lines file, appended to as the
run proceeds, whose records a metrics or monitoring service consumes without
parsing operator prose. It is a second surface beside the parsed output, never a
replacement for it, and a run never fails because its run log could not be
written (ADR-0029).
_Avoid_: a transcript of the agent stream, a parallel console logger

**Run record**:
One line of the run log. It carries a fixed low-cardinality label set — the
run's identity, command, workflow, provider, CLI, model, severity, event, and
where applicable its failure kind, phase and outcome — while every
high-cardinality identifier such as an Issue, ticket, HU, repository or session
stays in its nested context. The labels are what a dashboard groups by; the
context is what an operator reads once the group is found.
_Avoid_: free-form fields promoted to labels, secrets or prompt text in a record

**Failure kind**:
The closed vocabulary that classifies why a run failed or was cut short, named
once so the same failure is always the same value. It is what turns a run's
failures into a counter a monitoring service can chart and alert on; the prose
describing the failure travels beside it, never instead of it.
_Avoid_: an open string, a classification derived from a message

**Run interruption**:
A run that ended without reaching its own conclusion: an operator signal, an
unhandled failure above every catch, a session that failed or ended without its
terminal marker, or an exhausted fallback chain. Every interruption leaves a run
record, so the durable state a run left behind — a preserved checkpoint above
all — is never the only evidence that it stopped.
_Avoid_: a silent exit, treating a preserved checkpoint as the record

**Deterministic tool**:
An operation a workflow performs against Azure Boards, GitHub or git without
opening a session. Every one of them is reachable as its own command, shares the
adapter the workflow uses, prints what that adapter answered as JSON, and opens
no session (ADR-0026).
_Avoid_: reimplemented tool commands, session-opening tools

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

**Session-owning CLI**:
The coding agent CLI recorded next to the session identifier in every checkpoint
that keeps one. Recovery resumes against the CLI the checkpoint names rather than
the run's default, and an explicit `--cli` that contradicts it fails closed with
the checkpoint preserved, naming the CLI that owns it and how to resume. The one
contradiction that does not fail closed is the one the run itself created: only
the cross-CLI handoff of a GitHub delivery moves a session off the declared
`--cli`, so only that checkpoint also records the CLI it came from, and the same
command adopts the CLI now holding its work — for that unit only, since the next
one starts on the declared rung. The distinction is what the checkpoint recorded,
never what the rerun's chain declares. Every other checkpoint has no handoff to
record and fails closed on any contradiction. Adopting a CLI revalidates an
explicit `--variant` against it, since parsing validated that value against the
`--cli` of the command: one the adopted CLI cannot execute stops the run before
the session opens, with the checkpoint preserved. A checkpoint written before the
session-owning CLI existed reads as OpenCode and is
rewritten in the current schema, so a delivery in flight survives the update.
_Avoid_: inferring the CLI from the current invocation, a second checkpoint file

**GitHub queue outcome**:
A coordinator-owned result distinguishing completed delivery, an empty managed
queue, a blocked managed queue, and delivery state requiring reconciliation.
_Avoid_: marker text supplied by OpenCode

**Azure HU run**:
A lazy-workflow invocation selected by `--hu`, or recovered from an Azure HU
checkpoint. It preserves the HU's planning or ticket-delivery lifecycle.
_Avoid_: GitHub repository run

**Workflow prompt**:
The single module that composes what OpenCode is told for one run, keyed by the
class of run and the facts the coordinator has already fixed. It owns fragment
order, the completion-manifest contract, and the terminal protocol marker
vocabulary, so a contract change reaches every run at once. The manifest contract
is a command name, not a shape: the prompts tell a session which tool writes the
manifest and hand it the invocation with the fixed identities already in place.
Each run receives only its own workflow's instructions and only its own
provider's scope.
_Avoid_: prompt text assembled at the call site, contract text restated in a
prompt asset, the manifest's JSON shape described to a session

**Agent authority profile**:
The definition whose permission deny rules bound what one run may execute,
injected per run alongside its prompt. The prompt states what the coding agent
should decide; the profile states what it is able to do. There is one profile per
authority — GitHub and Azure planning, GitHub and Azure delivery, and review —
and it is derived from the same specification as the prompt, so the two cannot
drift apart. Each profile is written once per coding agent CLI in the format that
CLI's own provider validates, never generated from the other.
_Avoid_: prohibitions enforced only by prompt prose, one format translated into
the other at run time

**Coding agent CLI**:
The external command-line agent that executes one lazy-workflow session:
`opencode` or `claudecode`, selected per run with `--cli` and defaulting to
`opencode`. Every command that opens a session resolves it once and runs through
the same seam. It names the executor, never the authority: the agent authority
profile still states what a session may do, expressed in the format its own CLI
enforces.
_Avoid_: agent, agent authority profile, runner

**Agent rung**:
One executable position in a run's fallback order: a coding agent CLI, a model,
and a variant declared together. The primary rung is the run's own `--cli`,
`--model`, and `--variant`. Recovery resumes on the rung its checkpoint recorded,
except where the command declares that field explicitly: an explicit `--model` or
`--variant` still wins, and the variant is the one adoption validated against the
CLI the checkpoint imposes.
_Avoid_: fallback model, model override

**Fallback chain**:
The ordered agent rungs a run may descend to, declared with a repeatable
`--fallback <cli>:<model>:<variant>` whose declaration order is its priority.
The binaries of every rung are verified present when arguments are parsed.
_Avoid_: implicit fallback, configuration-file chain

**Provider exhaustion**:
The class of failures in which the active agent rung cannot be retried at all —
usage or rate limit, quota, billing, or authentication. It is the only condition
that descends the fallback chain. A session that fails its task is not
exhaustion and never descends.
_Avoid_: failed session, non-zero exit

**Bounded fallback wait**:
The wait a run enters when every rung of its declared chain is exhausted for the
unit of work in progress: it pauses `--fallback-wait` seconds and retries the
chain from its primary rung, up to the `--fallback-wait-max` wall-clock total
counted from the first wait, which covers the retries as well as the waits. Every wait is reported with the exhausted rung, its cause, and
the time left; once the bound is spent the run fails closed with the checkpoint
intact. A run that declared no chain never waits.
_Avoid_: unbounded retry, backoff schedule

**Cross-CLI handoff**:
The continuation of fixed work in a fallback rung whose coding agent CLI differs
from the exhausted one, where no session can be resumed. The coordinator starts
a fresh session with its own rebuilt prompt for the same fixed work plus a
progress section assembled from verified state — checkpoint phase, branch, last
commit, uncommitted worktree, completion manifest — and never from the outgoing
session's text. Verified state is state of this unit: the commit is the one the
branch has over its base, and the manifest is cited only when it names this issue
and this branch; anything else is stated as the absence it is.
_Avoid_: session summary handoff, resumed session across CLIs, base tip as unit commit, manifest of another delivery

**Agent result**:
The normalized JSON representation of a coding agent CLI's event stream,
including the session identifier, final text, stop reason, token counts, and
cost when available. Both CLIs reduce to this shape, so coordination reads one
result regardless of which agent produced it.
_Avoid_: raw transcript, CLI-specific result shape

**Default workflow prompt**:
The GitHub-only instructions used by a GitHub repository run for its selected
workflow and operator request.
_Avoid_: Azure HU prompt

**Azure HU planning run**:
A lazy-workflow invocation with `plan --hu <ID>`. It reads the Azure DevOps
User Story, combines that data with the English autoplan prompt, and starts
OpenCode in the selected working directory. OpenCode decides how to slice the
User Story and returns the slices as a delivery plan; it publishes no Azure work
items. The coordinator validates that plan and publishes it. It may hold a
planning interview on the way, which changes who answers its questions and
nothing about what it publishes.
_Avoid_: Azure ticket delivery run, OpenCode-created work items

**Planning interview**:
The bounded exchange between a planning session and the operator: the session
states the decisions it cannot settle alone and stops, the coordinator carries
them out and back, and the same session is resumed with the answers. Off unless
a run declares a question channel, so an unattended planning run answers itself
exactly as it always did.
_Avoid_: chat mode, interactive session, conversational planning

**Question round**:
One paused planning turn: the questions the session handed over together, each
with an id, the decision it states, and the answer the session recommends. The
round is read from the turn's own text, never from a terminal marker, because a
terminal marker closes the session the next round must resume.
_Avoid_: survey, prompt, questionnaire

**Question channel**:
What carries a question round to a human and the answers back — a loopback HTTP
page, the terminal, or a pair of JSON files. The coordinator owns it and decides
what the answers mean; the session only prints a marker and reads what it is
handed, so a channel grants the coding agent no capability and changes no
authority profile. Another channel is another adapter.
_Avoid_: input adapter, UI, agent tool

**Recommended answer**:
The answer a planning session would take on its own. Mandatory in every question
of a round, because it is what an expired deadline resolves to; answers that
resolved this way are declared as such, so a default is never presented to the
session as a decision the operator made.
_Avoid_: default answer, fallback answer

**Delivery plan**:
The machine-readable result of an Azure HU planning run: the tracer-bullet
tickets to publish, each with its type, exact title, body, optional estimate,
and the titles that block it. Titles are the plan's only identity, because
work-item ids do not exist yet. Duplicate titles, unknown blockers, and blocking
cycles are rejected before anything is created, so a malformed plan publishes
nothing.
_Avoid_: prose ticket list, work-item ids in a plan

**Plan publication**:
The coordinator-owned creation of a delivery plan in Azure: every work item
first, in dependency order, then the blocking relations that can now name real
ids. Both steps are idempotent, so republishing a plan reuses what already
exists.
_Avoid_: partial publication, duplicated work items

**Azure multi-repository planning run**:
A lazy-workflow invocation with `plan --hu <ID> --working-directory
<repo1,repo2,...>`. It normalizes and inspects the declared Azure repositories,
combines the User Story data with the English autoplan prompt, and starts one
OpenCode session from the workspace parent directory. It never prepares
branches, writes a checkpoint, or mutates tracker state.
_Avoid_: Azure multi-repository ticket delivery run

A fresh **Azure ticket delivery run** first queries the HU's native integration
branch and verifies or provisions `hu/<HU>` through structured
`--base-branch <name>` input before selecting a ticket, writing a checkpoint, or
starting OpenCode. The operator prompt is not a branch-management interface.

**Azure ticket delivery run**:
  A lazy-workflow invocation with `code --hu <ID>`. It delivers one eligible
  direct Task or Bug per fresh OpenCode session. The coordinator owns ticket
  selection, branches, pull requests, Azure fields, evidence, effort, completion
  gates, recovery, and cleanup; OpenCode owns only scoped implementation,
  validation, review, commit, and completion-manifest generation — which it
  performs by running `ticket-manifest-set`, never by writing that JSON itself.
  OpenCode emits
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
  repository and is written only once that repository is known, while
  participant repositories keep their workspace branches without native links. Single-repository Azure ticket delivery remains
  unchanged when `--working-directory` is a single path.
_Avoid_: Azure HU planning run

**Azure workspace delivery checkpoint**:
The aggregate record kept in the workspace state directory that fixes the HU,
the ticket, the normalized repository list with its declared order and remote
identities, the accumulated active duration, and one unit per repository. It is
the only authority on which repositories were already delivered, so recovery
resumes the same run instead of restarting or reselecting work.
_Avoid_: per-repository Azure checkpoints, restarting a partial delivery

**Textual completion evidence**:
The manifest evidence entry whose kind is not `screen` — `command-output` or
`http-json`. Only a textual file can populate the ticket's completion-evidence
field, so every completion manifest must carry at least one, and the shape check
the writing tool and the coordinator share refuses a manifest without one. A
delivery reads the evidence of every changed repository as one set, so the
textual entry may live in any of them.
_Avoid_: a manifest of screenshots alone, evidence read from one repository only

**Aggregate workspace manifest**:
The validated proof, written to the workspace state directory once every changed
repository carries a delivery receipt and every tracker gate passes, that a whole
transversal delivery landed. It records the tracker identity, the integration and
ticket branches, the primary repository, and one entry per participant repository
with its changed status, commit, pull request and merge commit. It is written and
re-read before the delivery checkpoint is cleared, so it outlives the checkpoint
and the per-repository receipts the checkpoint carried.
_Avoid_: clearing the checkpoint without a manifest, a manifest nobody re-read

**Delivery receipt**:
The verified record that a repository's external delivery effect already
happened. A repository unit carrying one is reused as-is rather than repeated,
and a repository unit without one stays pending. Aggregate completion, the
ticket transition to `Done`, and the HU transition require a receipt for every
changed repository.
_Avoid_: rollback or revert pull requests after a partial merge

**Ticket primary repository**:
The single participant repository that owns the ticket's one native Branch
ArtifactLink: the first repository in declared order that produced a verified
completion manifest, which need not be the HU's anchor repository. It is chosen
after the implementation session, recorded in the workspace checkpoint, and
determines where the ticket's pull request and completion gates are read.
_Avoid_: first declared repository, multiple ticket Branch links

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
The agent result produced from OpenCode's JSONL output. It is one CLI's instance
of the shared shape, not a second vocabulary.
_Avoid_: raw transcript

**Azure login continuation**:
When an HU planning run encounters an `az login --use-device-code` request,
lazy-workflow preserves the session, waits for Azure access, and resumes that
same session once with `continue`. Both coding agent CLIs report the request —
a shell call that runs it or text asking the operator to — so the continuation
does not depend on which one executed the run.
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
