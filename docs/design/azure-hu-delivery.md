# Azure Delivery HU Specification

## Goal

Extend `issue-killer` with an Azure DevOps delivery workflow in which a User
Story is an integration container rather than a single delivery unit. The
runner selects or discovers one Azure delivery HU, scopes execution to its
non-completed direct child tasks and bugs, runs one isolated worker per
eligible child ticket, and merges every ticket pull request into the HU
integration branch. The HU itself stays open and is not promoted to the
repository mainline.

This specification is the published artifact of issue
[#32 — Specify Azure HU delivery through child-ticket integration branches](https://github.com/elvisbrevi/agent-workflow/issues/32).
The decomposition tickets are
[#40 — Drain the eligible tickets of one Azure delivery HU](https://github.com/elvisbrevi/agent-workflow/issues/40),
[#41 — Expose provider-neutral Azure HU progress safely](https://github.com/elvisbrevi/agent-workflow/issues/41),
and
[#42 — Ship and validate the operable Azure HU workflow](https://github.com/elvisbrevi/agent-workflow/issues/42).

The architectural decisions are published as ADRs under `docs/adr/`:

- ADR [0002 — Compose the worker contract by tracker](../adr/0002-compose-worker-contract-by-tracker.md)
- ADR [0003 — Bootstrap the Azure HU integration branch interactively](../adr/0003-bootstrap-azure-hu-integration-branch-interactively.md)
- ADR [0004 — Scope Azure delivery to direct child tickets](../adr/0004-scope-azure-delivery-to-direct-child-tickets.md)
- ADR [0005 — Allow explicit Azure HU selection](../adr/0005-allow-explicit-azure-hu-selection.md)
- ADR [0006 — Bootstrap repository-owned Azure field mappings](../adr/0006-bootstrap-repository-owned-azure-field-mappings.md)
- ADR [0007 — Store completion captures on the work item](../adr/0007-store-completion-captures-on-the-work-item.md)
- ADR [0008 — Require behavior-appropriate completion evidence](../adr/0008-require-behavior-appropriate-completion-evidence.md)
- ADR [0009 — Record cumulative active agent effort](../adr/0009-record-cumulative-active-agent-effort.md)
- ADR [0010 — Complete an Azure ticket after verified integration and evidence](../adr/0010-complete-azure-ticket-after-verified-evidence.md)
- ADR [0011 — Keep the Azure HU lifecycle external](../adr/0011-keep-azure-hu-lifecycle-external.md)

## Scope

The runner accepts an optional `--hu <ID>` that pins the run to one Azure
delivery HU; without it, the runner discovers the oldest prepared HU by
creation time and ID. GitHub runs reject the option. The Azure tracker
contract under `docs/agents/issue-tracker.md` declares the delivery role
mappings (`delivery_hu_work_item_types`, `delivery_ticket_work_item_types`),
process mappings (open/closed states, role labels), and resolution-target
fields (`completion_evidence_field`, `real_effort_field`).

An Azure delivery HU is an integration container, not the work item
completed by the runner. The runner never closes the HU and never creates or
merges a final pull request from the HU integration branch into the
repository mainline directly. The runtime and tracker adapter contracts
remain unchanged; tracker-specific event decoding and progress categories
add HU, ticket, evidence, and integration phases without exposing raw tool
inputs.

## Worker Contract

The worker prompt is composed from one shared contract and one
tracker-specific supplement. GitHub and Azure share implementation, testing,
review, safety, recovery, and final-status rules while defining different
execution units, branch targets, completion criteria, and lifecycle effects.

A single Azure delivery ticket is the unit handled by one fresh worker
session. Successful ticket completion advances only within the pinned HU
until no eligible child remains. The HU identity and active ticket identity
are persisted in checkpoints and lock status so retries and restarts never
switch scope silently.

## HU Integration Branch

The runner owns the HU integration branch so workers can rely on a
deterministic, persistent target for every ticket pull request. The
branch name is `<category>/<HU-ID>-<normalized-title>`, where the category
is one of `feature`, `hotfix`, or `refactor`.

- On the first execution of a HU, when the deterministic branch does not
  exist, the supervisor asks the operator to choose `master` or `develop`
  as the origin branch. A non-interactive first run stops safely rather
  than choosing automatically.
- The category is inferred from the HU type, title, and description:
  - A `Bug` work-item type is always `hotfix` because the work item was
    authored as a defect.
  - A title or description containing `refactor` selects `refactor`.
  - A title beginning with `Fix`, `Hotfix`, or `Bug` selects `hotfix`.
  - Anything else falls back to `feature`.
- Subsequent executions reuse the existing branch and do not ask again.
- Every ticket branch starts from the current verified HU integration
  branch and merges back into it through exactly one verified pull
  request.

## Child-Ticket Selection

Azure execution enumerates only non-completed direct hierarchical children
whose configured types represent Task or Bug. Related links, indirect
descendants, other work-item types, and completed items are excluded.

- Eligible child tickets respect the configured predecessor relation.
- Eligible children are ordered by creation time and then by numeric ID
  so the execution order is deterministic.
- Children are reevaluated from live Azure state before each worker, so
  newly unlocked children can enter the run and blocked children stay out.
- When the selected HU has no remaining eligible children, the run exits
  successfully without selecting another HU in that invocation.

## Evidence And Effort

Required completion evidence is a hard completion gate. The worker
classifies the delivered behavior and matches it to one of the four
modalities:

- Backend changes produce Chrome MCP captures of the relevant HTTP request
  and response.
- Frontend changes produce rendered-screen screenshots.
- Mixed changes produce both HTTP and screen captures.
- Changes without an executable interface produce reproducible command
  or test output.

When the expected application, environment, authentication, or Chrome
capability is unavailable, the worker reports a blocked outcome without
moving the ticket to `Done`. Binary captures are uploaded as Azure
work-item attachments and embedded in the configured HTML
completion-evidence field with titles and descriptions. Captures are never
committed to the source repository.

Real Effort is updated in hours rounded upward to `0.25 h`. The value
adds to any pre-existing field value rather than overwriting or
double-counting effort. Operator waits and provider retry backoff are
excluded.

## Repository-Owned Field Mappings

When required completion or effort mappings are absent, the first Azure
execution queries the Azure field catalog, resolves the intended fields to
their exact editable `referenceName` values, validates compatible types,
and persists the mappings in `docs/agents/issue-tracker.md`. Later ticket
workers reuse the validated mappings instead of rediscovering display
names. Missing, ambiguous, incompatible, or read-only fields block
execution before any ticket mutation.

The persisted block sits next to the `## Azure DevOps configuration`
section and stores the exact editable `referenceName` for the evidence
field as `completion_evidence_field` and for the effort field as
`real_effort_field`. The contract contains no credentials and no
machine-global defaults.

## Ticket Completion Protocol

Ticket completion follows an ordered, recoverable protocol:

1. Produce the required evidence.
2. Commit and push the ticket branch.
3. Create or reuse the pull request targeting the HU integration branch.
4. Merge and verify the HU integration branch move.
5. Add native Azure development relations to the pull request and the
   integrated commit.
6. Upload or reconcile evidence attachments.
7. Publish completion evidence and cumulative Real Effort.
8. Reread and verify Azure state.
9. Move the ticket to `Done`.

Every persistent external effect records intent before mutation and
reconciles live state after interruption. A failure after merge leaves the
ticket non-terminal and recoverable; the restart path adds only missing
effects and never duplicates a pull request, attachment, relation,
effort increment, or `Done` transition.

## HU Lifecycle

`issue-killer` treats the Azure delivery HU as an integration container
rather than a work item it completes. A successful Azure HU run ends when
every selected direct-child ticket is `Done` and integrated into the HU
branch. The runner does not close the HU, does not approve it, and does not
create or merge a final pull request from the HU integration branch into
`master`, `develop`, or another repository mainline. This deliberately
differs from GitHub issue completion and preserves external ownership of
HU acceptance and lifecycle.

## GitHub Regression Guard

GitHub queue discovery, branch targeting, pull-request verification,
automatic merge, issue closure, checkpoint behavior, and prompt supplements
retain their existing externally observable behavior. The GitHub option
surface rejects the Azure-only `--hu` option, so tracker-specific
semantics cannot leak into GitHub execution.

## Status Protocol

The generic status protocol is preserved:

- `ISSUE_KILLER_STATUS=ISSUE_COMPLETED` — the next eligible child has
  been fully integrated and verified.
- `ISSUE_KILLER_STATUS=QUEUE_EMPTY` — the HU has no remaining eligible
  children in this invocation.
- `ISSUE_KILLER_STATUS=BLOCKED` — a ticket or the HU is blocked waiting
  on operator action, missing dependency, or unavailable capability.
- `ISSUE_KILLER_STATUS=FAILED` — the ticket could not be completed in
  this run.
- `ISSUE_KILLER_STATUS=RECOVERY_REQUIRED` — the runner cannot continue
  safely without operator intervention.

`BLOCKED`, `FAILED`, `RECOVERY_REQUIRED`, a missing marker, or partial
completion stops the HU run and never selects another ticket.

## Acceptance Criteria

The specification is complete when:

- The Azure tracker contract is validated against the Git remote before
  the first worker; missing or malformed mappings fail closed.
- `docs/agents/issue-tracker.md` declares the Azure configuration block
  with delivery role mappings, process mappings, and resolved field
  reference names.
- The supervisor accepts `--hu <ID>` for Azure runs and rejects it for
  GitHub runs.
- The supervisor asks the operator to choose `master` or `develop` on
  the first execution of a HU whose integration branch does not exist.
- The worker infers the HU delivery category from the HU type, title,
  and description; the integration branch combines the category, HU ID,
  and normalized title.
- Eligible child tickets are direct hierarchical non-completed Tasks or
  Bugs that respect their declared predecessor relations.
- Eligible children are ordered by creation time and numeric ID.
- Every ticket branch starts from the current verified HU integration
  branch and targets it through a pull request.
- The ticket pull request is merged into the HU integration branch
  before the ticket reaches `Done`.
- Required completion evidence matches the delivered behavior and is
  attached to the work item.
- Real Effort is published in quarter-hour increments and added to the
  pre-existing value exactly once.
- Native development relations point to the pull request and the
  integrated commit.
- The HU stays open, and no final HU pull request reaches the repository
  mainline.
- The repository-wide lock prevents concurrent runners or worktrees from
  processing the same HU.
- Checkpoints and lock status preserve HU identity, ticket identity,
  branch identities, and active-effort accumulation without storing
  credentials, prompts, complete commands, or raw capture payloads.
- Black-box scenarios cover multiple children, newly unlocked children,
  empty HUs, blocked children, and restart from the middle of an HU.
- GitHub regression fixtures remain green, including rejection of the
  Azure-only `--hu` option.
- The focused Azure adapter suite and the complete issue-killer suite
  pass under the host Bash and the supported modern Bash when available.
- Syntax checks and whitespace validation pass.

This specification does not deliver the implementation. The decomposition
tickets [#40](https://github.com/elvisbrevi/agent-workflow/issues/40),
[#41](https://github.com/elvisbrevi/agent-workflow/issues/41), and
[#42](https://github.com/elvisbrevi/agent-workflow/issues/42) carry the
incremental delivery work.
