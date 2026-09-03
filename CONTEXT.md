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
`trace`, `heading`, `start`, and `stop` methods, and its `event` method is
what writes a run record beside the operator line (ADR-0029). The Reporter decides whether
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
unhandled failure above every catch, or a fallback chain spent by provider
exhaustion. Every interruption leaves a run
record, so the durable state a run left behind — a preserved checkpoint above
all — is never the only evidence that it stopped.
_Avoid_: a silent exit, treating a preserved checkpoint as the record

**Unattended shutdown**:
The machine powering down because the run that asked for it ended. Declared
globally with `--off <contrasena>`, it is the last action of an invocation and
never a step of a workflow: it runs whatever the outcome was, except after an
argument error, and it cannot change the exit code the run already earned
(ADR-0030). The grace period it waits first is the operator's way out, not a
timeout.
_Avoid_: a shell chain that shuts down on any exit, a per-command flag

**Deterministic tool**:
An operation a workflow performs against Azure Boards, GitHub or git without
opening a session. Every one of them is reachable as its own command, shares the
adapter the workflow uses, prints what that adapter answered as JSON, and opens
no session (ADR-0026).
_Avoid_: reimplemented tool commands, session-opening tools

**operator-output**:
The name of the file module (`src/output/operator-output.ts`) that hosts
the compat shim `reportOperator(message)`. The shim routes the call sites
that have not moved yet to the Reporter's `info` method and keeps a
swappable default Reporter. They are a shrinking set, not a fixed one. The Reporter is the abstraction; `operator-output` is
the seam name and the legacy entry point.
_Avoid_: new direct `console.log` calls, new top-level log helpers

**Planning protocol marker**:
A line a planning session prints alone to hand control back to the coordinator:
`PLAN_READY` with the slices it decided, `QUESTIONS_PENDING` with the round it
wants answered, and `QUESTIONS_ANSWERED`, which the coordinator prints when it
resumes that session with the operator's replies.

A delivery session prints none, on either provider: it is finished when its process
exits, and it succeeded when git says so (ADR-0035). Only the Azure workspace paths
still print `IMPLEMENTATION_READY`, until the workspace mode is rebuilt.
_Avoid_: a marker for delivery, provider text as a completion signal

**Run outcome line**:
What the coordinator itself prints on stdout when a run ends —
`TICKET_COMPLETED`, `QUEUE_EMPTY`, `QUEUE_BLOCKED`, `WORKFLOW_STEP_FINISHED`,
`RECONCILIATION_REQUIRED`. It shares a vocabulary with the protocol markers and is
not one: no session emits it and nothing parses it back out of a session's text.
_Avoid_: calling it a marker, letting a session print one

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
The `code` lifecycle in which lazy workflow selects and claims one issue, fixes
its identity and branch for the session, verifies the outcome against git, and
performs every Git and GitHub effect itself before advancing. The session
prepares one implementation; it does not select work, open pull requests, or
declare queue state.
_Avoid_: prompt-driven queue drain, autonomous issue selection

**Queue drain**:
The shape of a `code` run: ask the tracker for the first eligible unit, deliver
it, ask again, until there is none. It is an unfold over an immutable run state,
not an iteration of a list captured up front — merging one unit is what makes the
unit it blocked eligible, so the frontier has to be re-asked each turn (ADR-0038).
_Avoid_: foreach over a snapshot, an index into a fixed list

**Session verification**:
What the coordinator asks after a delivery session's process exits: exit code
zero, the fixed branch ahead of its base, and a clean worktree. In a workspace,
per repository: every participant clean, at least one ahead. Nothing the session
wrote is consulted (ADR-0035).
_Avoid_: trusting the exit code alone, reading a completion claim out of the text

**Unit failure**:
Any outcome that is not a verified session: a non-zero exit, a branch with no
commits, a dirty tree, or a chain spent by idle timeout. The unit keeps its claim
on GitHub and its `En progreso` state on Azure, and its branch and commits survive
for inspection.

On GitHub the claim is what removes it from the frontier through the eligibility
predicate that already existed, so the drain continues with the next unit and the
run exits non-zero because it left work broken behind it; a person unassigns the
issue to retry it. On Azure the drain still stops there instead: `En progreso` is
not yet part of the eligibility predicate, so continuing would re-select the same
ticket. That gap closes when the Azure queue gets its own drain.

A unit that fails *after* verification — pushing, opening the pull request,
merging — is not this: it is a half-finished delivery, it keeps its checkpoint,
and it stops the run.
_Avoid_: releasing a failed claim, a new state to mark failure, treating a
half-delivered unit as an ordinary failure

**Delivery summary**:
The last text a delivery session produces, asked for by the last line of the
prompt. It is the body of the GitHub pull request and the content of the Azure
ticket's completion-evidence field — the delivery's only narrative artifact, and
the only thing in it the coordinator cannot derive (ADR-0037).
_Avoid_: completion manifest, rendered evidence document, a summary the
coordinator writes

**Conflict resolution session**:
The one session a delivery may open beyond its own: when `gh` reports
`mergeStateStatus: DIRTY`, the coordinator merges the base into the unit's branch
itself and opens a session whose whole instruction is to resolve the conflicts,
keeping this branch's changes without discarding the base's. Its result passes
the same session verification, and the merge is retried once (ADR-0041).
_Avoid_: keeping ours, a reconciliation subsystem, a second retry

**GitHub parent reconciliation**:
The verified closure of an open native parent after all of its direct native
sub-issues and dependencies are closed. Reconciliation may continue through
the parent's ancestors and never infers hierarchy from prose or titles.
_Avoid_: checklist closure, title-based epic closure

**GitHub delivery checkpoint**:
The repository-scoped record of the one fact git cannot supply: that the unit in
flight passed its session verification before the delivery effects finished. It
carries the repository, the issue, its branch and base, the verified commit — whose
presence *is* that fact — and the delivery summary. Nothing else: phase, receipts,
intents, the session identifier and the CLI that owned it are all derivable or
meaningless now that no session is resumed (ADR-0038). A checkpoint of an older
schema is discarded, not migrated.
_Avoid_: a phase machine, a persisted session identifier, a per-effect receipt

**Queue outcome**:
A coordinator-owned result distinguishing a drained queue, a queue with nothing
eligible yet, and a unit that failed. It is computed from the tracker and from
git, never read out of the session's text.
_Avoid_: marker text supplied by the coding agent

**Azure HU run**:
A lazy-workflow invocation selected by `--hu`, or recovered from an Azure HU
checkpoint. It preserves the HU's planning or ticket-delivery lifecycle.
_Avoid_: GitHub repository run

**Workflow prompt**:
The single module that composes what a coding session is told for one run, keyed
by the class of run and the facts the coordinator has already fixed. It owns
fragment order and the planning protocol marker vocabulary, so a contract change
reaches every run at once. Each run receives only its own workflow's instructions
and only its own provider's scope. A delivery prompt states the work and nothing
else: the issue's number, the skills that implement it, the branch to stay on,
and the request for a closing summary. What the session may do is stated by its
authority profile, not restated here (ADR-0036).
_Avoid_: prompt text assembled at the call site, fencing prose duplicating a
permission, a contract described to a session

**Agent authority profile**:
The definition whose permission deny rules bound what one run may execute,
injected per run alongside its prompt. The prompt states what the coding agent
should decide; the profile states what it is able to do. There is one profile per
authority — GitHub and Azure planning, GitHub and Azure delivery, and review —
and it is derived from the same specification as the prompt, so the two cannot
drift apart. Each profile is written once per coding agent CLI in the format that
CLI's own provider validates — an OpenCode permission block, a Claude Code
settings file, a Codex execpolicy rules file — and never generated from another.
Every CLI runs in its own auto-approve mode, so the deny rules are the whole
enforcement surface.
_Avoid_: prohibitions enforced only by prompt prose, one format translated into
the other at run time

**Coding agent CLI**:
The external command-line agent that executes one lazy-workflow session:
`opencode`, `claudecode` or `codex`, selected per run with `--cli` and defaulting
to `opencode`. Every command that opens a session resolves it once and runs
through the same seam, and each CLI carries its own binary, its own accepted
efforts and its own default model. It names the executor, never the authority:
the agent authority profile still states what a session may do, expressed in the
format its own CLI enforces.
_Avoid_: agent, agent authority profile, runner

**Codex authority home**:
The lazy-workflow-owned Codex home a run is given so its agent authority profile
reaches Codex, which discovers execpolicy rules only under the resolved home and
accepts no rules path as a flag. It holds the profile's own `rules/`, and links
the operator's `auth.json` and `skills/` so the run keeps the operator's login
and the skills its prompt names. The operator's `config.toml` is not linked: the
model and the effort are stated on the invocation, and nothing else in the
operator's home may vary the run.
_Avoid_: the operator's own Codex home, a hermetic home, generated rules

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
The fixed-interval retry the run performs when every rung is spent **by provider
exhaustion**, up to a bounded total, after which it fails closed with the
checkpoint preserved. A chain spent by idle timeout does not wait: quota returns
on its own, a hung prompt does not.
_Avoid_: waiting on a stuck session, an unbounded wait

**Agent handoff**:
What every fallback descent performs: a fresh session on the next rung receiving
the same workflow prompt plus a progress section. No session is ever resumed,
whether or not the rung changes CLI, because resuming replayed a whole
transcript to change a model.
_Avoid_: resuming a session on a new rung, two behaviours depending on the CLI

**Progress section**:
What an agent handoff states about the work already done: the branch, the commits
it carries, and the last three reasoning chains of the outgoing session,
reproduced verbatim. The reasoning is passed through as what it is — the previous
agent's last thoughts — never as a verified account of what landed. What landed
is the commit list beside it.
_Avoid_: a summary the outgoing session is asked to write, a paraphrase

**Idle timeout**:
The silence a session is allowed between stream events before the coordinator
kills it and descends the fallback chain, on every CLI. A stuck agent and an
exhausted quota mean the same thing to the loop. The silence that tripped it is
subtracted from the unit's accrued effort.
_Avoid_: an idle nudge, resuming the killed session, counting the silence as work

**Agent result**:
The normalized JSON representation of a coding agent CLI's event stream,
including the session identifier, final text, stop reason, token counts, and
cost when available. Every CLI reduces to this shape, so coordination reads one
result regardless of which agent produced it, and a CLI that reports no cost
simply leaves it absent.
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
round is read from the turn's own text rather than from the stream, because the
session the next round must resume is the one that would otherwise be closed. A round whose
JSON does not parse is restated once by the same session before the run stops:
the questions were already written, and reading them again decides nothing.
_Avoid_: survey, prompt, questionnaire

**Question channel**:
The HTTP surface the coordinator opens to put a question round in front of the
operator: its own page at `/i/<token>/`, and the round and the answers as JSON at
`/i/<token>/round` and `/i/<token>/answers`, so another client can replace the
page without touching the coordinator. Outside loopback the URL with its token is
the only credential. It is off unless asked for.
_Avoid_: a terminal channel, a file channel, a channel per workflow

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
The deterministic half of a planning run, in both trackers. The session decides
the slices and returns them behind `PLAN_READY` — type, title, body, blocking
edges, estimate. The coordinator creates the items, wires parents and blocking
relations, applies `ready-for-agent` on GitHub in the same call that creates the
issue, and sets every derivable Azure field: assignee, month, remaining work,
and the HU's integration branch. The agent supplies title, description and
estimate; everything else about a published item is derivable, and therefore not
the agent's to state (ADR-0040).
_Avoid_: a session publishing to the tracker, a numbering watermark

**Desarrollador 1**:
The developer a User Story names in `Custom.Desarrollador1`, and the owner every
ticket published from it is assigned to. Distinct from the HU's own assignee,
who answers for the story without necessarily writing its code. Azure answers it
as an identity object, so a reader that only accepts text loses it.
_Avoid_: HU assignee, session-chosen owner

**Creation defaults**:
The fields a project requires on a delivery ticket that the plan itself never
names — remaining work, estimated hours, the month. They are repository-owned
(ADR-0006), written only when the work-item type's field catalog defines them,
validated against the field's allowed values, and always outranked by an
explicit `--field`.
_Avoid_: guessing a field from its display label, hardcoding a project's fields

**Azure multi-repository planning run**:
A lazy-workflow invocation with `plan --hu <ID> --working-directory
<repo1,repo2,...>`. It normalizes and inspects the declared Azure repositories,
combines the User Story data with the English autoplan prompt, and starts one
OpenCode session from the workspace parent directory. It never prepares
branches or writes a checkpoint, and it ends in the same **plan publication**
as a single-repository planning run: the repository count is the session's
scope, never a reason to leave a plan unpublished.
_Avoid_: Azure multi-repository ticket delivery run

A fresh **Azure ticket delivery run** first queries the HU's native integration
branch and verifies or provisions `hu/<HU>` from a **delivery base branch**
before selecting a ticket, writing a checkpoint, or starting OpenCode. Single
and multi-repository runs prepare it at that same point, because selection
resolves the ticket against that branch. The operator prompt is not a
branch-management interface.

**Delivery base branch**:
The remote branch a delivery run provisions `hu/<HU>` from: the structured
`--base-branch <name>` input when the operator declares one, and otherwise the
first of `master` or `main` that exists remotely in that repository, resolved
per participant repository so a workspace whose repositories disagree still
provisions each from its own trunk. A repository with neither trunk fails closed
asking for `--base-branch`. It applies only to provisioning: `hu-branch-set`
still assigns nothing without an explicit base.
_Avoid_: a base guessed from another repository, a default that replaces a
declared base, an implicit base in `hu-branch-set`

**Azure ticket delivery run**:
  A lazy-workflow invocation with `code --hu <ID>`. It drains the HU's eligible
  direct Tasks and Bugs one at a time, each in a fresh session. The coordinator
  owns ticket selection, branches, pull requests, Azure fields, effort,
  completion gates, recovery, and cleanup; the session owns only scoped
  implementation, validation, review and commit, and closes with its delivery
  summary. Before opening the coding session, the coordinator moves the fixed
  ticket to exactly `En progreso` with the current state and revision as guards —
  which is also what removes a failed ticket from the frontier. When the session's
  process exits, the coordinator runs its session verification, and only then
  pushes, opens the canonical Azure PR, completes it (whose completion options
  delete the source ticket branch), verifies the completion gates, and selects the
  next ticket. Later cleanup remains idempotent when Azure already removed that
  remote ref.

**Azure multi-repository ticket delivery run**:
  A lazy-workflow invocation with `code --hu <ID> [--ticket <ID>]
  --working-directory <repo1,repo2,...> [--base-branch <name>]`. It runs one
  session from the workspace parent directory, verifies every participant
  repository clean and at least one ahead of its base, associates every changed-repository
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
identities, the accumulated active duration, and whether the unit passed its
session verification. It is the only authority on which repositories were already
delivered, so recovery resumes the same run instead of restarting or reselecting
work.
_Avoid_: per-repository Azure checkpoints, restarting a partial delivery, a phase
machine

**Ticket primary repository**:
The single participant repository that owns the ticket's one native Branch
ArtifactLink: the first repository in declared order that produced commits of its
own, which need not be the HU's anchor repository. It is chosen
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
_Avoid_: per-repository native Branch links

**Azure HU integration branch preparation**:
The multi-repository preparation that resolves the anchor, verifies or
provisions `hu/<HU>` in each participant repository from a checked, clean
worktree and that repository's delivery base branch, and writes the single
native Branch ArtifactLink only in the anchor repository. It runs before ticket
selection, so an unlinked HU is provisioned rather than reported as a queue with
nothing eligible. An anchor already linked to a branch that is gone from its own
repository fails closed as a broken link, never provisioned from a base.
_Avoid_: multiple native HU Branch links, selecting a ticket before the HU
branch exists

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
What `--normas-sag` puts in a prompt: the paths of the normative files that apply
to this repository's `tipo`, read from `.sag/config.json`. The session reads the
files itself with `az`. The coordinator selects paths; it does not extract rule
identifiers, decide applicability, or inline normative text.
_Avoid_: rule-identifier metadata, applicability decisions, inlined norms

**SAG-scoped workflow**:
A `plan` or `code` run invoked with `--normas-sag`, which appends the SAG norms
context to its prompt. There are no SAG-only commands.
_Avoid_: a workflow that exists only to consult norms

**SAG source scope**:
The complete Azure HU selected by `--hu`, or the GitHub repository the run is
scoped to, whose `.sag/config.json` names the `tipo` that selects which normative
paths a SAG-scoped workflow is given.
_Avoid_: Azure child ticket, a SAG-only command
