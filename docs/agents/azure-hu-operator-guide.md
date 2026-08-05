# Azure Delivery HU Operator Guide

This guide explains how to operate `issue-killer` against an Azure DevOps
repository. It is the operator-facing counterpart to the design specification
in [`docs/design/azure-hu-delivery.md`](../design/azure-hu-delivery.md) and
the tracker contract in [`docs/agents/issue-tracker.md`](issue-tracker.md).
Read both before running the runner against a live Azure project.

The Azure flow treats a User Story as an integration container rather than a
single delivery unit. The runner handles eligible direct-child Tasks and Bugs
one ticket at a time. The Azure delivery HU itself is never closed and never
promoted to the repository mainline — operators keep full control over HU
acceptance.

## Prerequisites

Before the first Azure run, every operator must satisfy these prerequisites:

1. The `az` CLI is installed and the `azure-devops` extension is enabled.
2. The operator has authenticated with `az login` and the matching identity
   matches the `claim_identity` declared in the tracker contract.
3. The repository tracker contract in `docs/agents/issue-tracker.md` declares
   the full Azure DevOps configuration block, including the role and
   process mappings shown in the contract.
4. The repository remote matches the declared organization, project, and
   repository. Mismatches fail closed before any worker is launched.
5. `jq` is installed when the default `ISSUE_RUNNER_STREAM_OUTPUT=true`
   mode is in use.
6. Optional but required for the documented evidence modality: the
   Chrome MCP server is available to the worker. Backend tickets need the
   HTTP capture modality, frontend tickets need the rendered-screen
   capture modality, and tickets that lack an executable interface produce
   reproducible command or test output. When Chrome, the target application,
   the environment, or the operator authentication is unavailable, the
   worker reports `BLOCKED` instead of substituting a textual note.

## Selecting A Delivery HU

The runner accepts two mutually exclusive HU selection modes:

- **Explicit `--hu <ID>`**: pin the run to a single Azure delivery HU. The
  value must be a positive numeric work-item ID. A malformed `--hu` fails
  closed before any worker is launched. The option is rejected on GitHub
  repositories.
- **Automatic discovery**: omit `--hu` to let the runner discover the
  oldest prepared HU by creation time and ID. The runner reads the live
  Azure state, verifies the work-item type matches the configured
  `delivery_hu_work_item_types`, checks the `ready_tag`, and confirms the
  HU has at least one eligible direct child before launching a worker.

The pinned `hu` and the active `ticket` identities are persisted in the
checkpoint and lock status, never in prompts, credentials, or raw capture
payloads. A restart reuses the same identities and never silently switches
HU scope.

## First-Run Origin Choice

The first execution of a HU bootstraps the HU integration branch. The
branch name is `<category>/<HU-ID>-<normalized-title>`, where the category
is one of `feature`, `hotfix`, or `refactor` and is inferred from the HU
type, title, and description.

- An interactive first run asks the operator to choose `master` or
  `develop` as the origin branch when the deterministic branch does not
  exist. The choice is recorded so later runs reuse the same branch.
- A non-interactive first run stops safely rather than choosing an origin
  automatically. The destructive confirmation is the only authorization
  boundary for the bootstrap.
- Subsequent executions reuse the existing HU integration branch and never
  ask again.

The destructive confirmation step is the only authorization boundary for
autonomous writes, tests, pushes, merges, and ticket closure. Profiles,
fallback chains, and ticket selection never re-authorize the run.

## Branch Naming

The HU integration branch uses the deterministic convention
`<category>/<HU-ID>-<normalized-title>`. The title is normalized to
lowercase, non-alphanumeric characters are replaced with `-`, and
leading or trailing dashes are collapsed. Each ticket branch starts from
the current verified HU integration branch and merges back into it through
exactly one verified pull request.

## Ticket Sequencing

Within an HU, ticket sequencing is deterministic:

1. Direct hierarchical children of the HU are enumerated. Related links,
   indirect descendants, and other work-item types are excluded.
2. Eligible children are ordered by creation time and then by numeric ID
   so the runner predictably picks the oldest ticket first.
3. Each ticket worker reevaluates the live Azure state before edit, push,
   PR creation, and merge, so a newly unlocked child can enter the run
   and a blocked child stays out. The HU identity and the active ticket
   identity remain pinned for the duration of the worker.
4. When the selected HU has no remaining eligible children, the run exits
   successfully without selecting another HU in that invocation.

The orchestrator never advances to a different HU scope during a run, and
the worker never inspects tickets outside the pinned HU.

## Evidence Requirements

Each ticket worker must produce behavior-appropriate completion evidence
before the ticket reaches `Done`. The mandatory modality is decided by the
delivered behavior:

- **Backend changes**: Chrome MCP captures of the relevant HTTP request
  and response.
- **Frontend changes**: rendered-screen screenshots.
- **Mixed changes**: both HTTP and screen captures.
- **Non-executable changes**: reproducible command or test output.

Binary captures are uploaded as Azure work-item attachments and embedded
in the configured HTML completion evidence field with titles and
descriptions. Captures are never committed to the source repository. The
runner sanitizes capture URLs and base64 payloads before they reach the
operator terminal or the lock status.

Textual evidence is never an acceptable substitute for a missing modality
capture. When Chrome, the target application, the environment, or
authentication is unavailable, the worker reports `BLOCKED` rather than
substituting prose.

## Field Mappings

The tracker contract must declare two editable Azure field mappings:

- `completion_evidence_field` — the display name of the editable HTML
  field that stores human-readable completion evidence.
- `real_effort_field` — the display name of the editable numeric field
  that stores cumulative active agent effort.

When either mapping is absent, the first Azure run queries the Azure
field catalog, resolves the intended fields to their exact editable
`referenceName` values, validates that the evidence field is editable
HTML and the effort field is editable numeric, and persists the resolved
reference names as `completion_evidence_field_name` and
`real_effort_field_name` in the tracker contract. Missing, localized,
ambiguous, incompatible, or read-only fields fail closed before any
ticket mutation. Later ticket workers reuse the persisted reference names
and never rediscover them.

The tracker contract contains no credentials, no machine-global
defaults, and no environment-specific defaults. Mappings are
repository-owned and reused.

## Real Effort

Real Effort is published in hours rounded upward to `0.25 h`. The value
adds to the pre-existing field value rather than overwriting or
double-counting effort. Operator waits and provider retry backoff are
excluded. The persisted value is also reflected in the lock status so
operators can observe the cumulative effort without reading the
checkpoint directly.

## Recovery

The checkpoint preserves the pinned `hu` and `ticket` identities, the
current branch, the captured Claude session (when available), the active
profile, the CLI, the model, and the last safe state. The lock status
mirrors the same identities. A restart recovers the exact attempt and
never re-selects a different HU.

The lifecycle states span `starting`, `issue_selected`, `mutating`,
`branch_pushed`, `pr_created`, `pr_merged`, and `issue_closed`. A
checkpoint that already reached `pr_merged` or `issue_closed` is treated
as completed; the supervisor injects a synthetic `ISSUE_COMPLETED` status
and advances the loop without launching another worker.

Mixed-provider fallback chains, transport retries, and the orchestrator
recovery clauses emit their own progress phases through the same pipeline.
When the chain is exhausted, the operator sees `RECOVERY_REQUIRED` and
the runner retains the checkpoint so the next restart can decide
whether recovery is safe.

## Prohibited Behaviors

The Azure run deliberately differs from GitHub issue completion in two
respects:

- The runner does **not** close the Azure delivery HU. HU acceptance is
  an external concern owned by the operator and the project process.
- The runner does **not** create or merge a final pull request from the
  HU integration branch into `master`, `develop`, or another repository
  mainline. The HU integration branch remains scoped to the active HU.

These prohibitions are enforced by the tracker adapter contract and the
ticket completion protocol. The runner never silently escalates scope.

## Operational Validation

The local issue-killer suite exercises Azure flow behavior with fake
`az` and tracker fixtures. Local fake results are not proof of an
operational Azure integration. The repository publishes an opt-in
DEV/sandbox contract that exercises real field discovery, permissions,
attachment upload, native relations, pull-request verification, and
Chrome evidence against a non-production project. Operators must run the
DEV/sandbox contract before declaring the Azure flow production-ready.

Skipped live contracts are reported explicitly in the operator-facing
documentation. The runner never claims an operational Azure integration
on the strength of fake outputs alone. Operators must publish the
DEV/sandbox manifest so skipped live contracts are observable.
