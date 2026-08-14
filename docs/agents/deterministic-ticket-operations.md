# Deterministic Azure ticket operations

## Objective

Mechanical Azure DevOps and Git effects are kept out of the OpenCode prompt and
owned by typed, idempotent `lazy-workflow` commands. OpenCode remains responsible
for implementation, review, commits, and producing behavior-appropriate
evidence files. The coordinator owns ticket selection, branches, Azure fields,
attachments, PR integration, completion verification, cleanup, and recovery.

Use `ticket` rather than `task` in command names because delivery children may
be either Azure `Task` or `Bug` work items.

## Command contracts

Every read command prints one normalized JSON object and never starts OpenCode.
Every mutation validates the HU/ticket relationship and expected current state,
performs only missing effects, rereads Azure/Git, and prints the verified result.
Conflicting existing data fails closed.

| Concern | Read command | Mutation command | Required explicit input |
|---|---|---|---|
| Aggregate ticket | `ticket-info --hu <id> --ticket <id>` | none | HU and ticket IDs |
| Description | `ticket-description-info --ticket <id>` | `ticket-description-set --ticket <id> --description-file <path>` | UTF-8 file; no shell-embedded HTML |
| State | `ticket-state-info --ticket <id>` | `ticket-state-set --ticket <id> --state <state> --expected-state <state>` | expected and desired state |
| Effort | `ticket-effort-info --ticket <id>` | `ticket-effort-set --ticket <id> --real-effort <hours> --real-effort-hh <hours> --expected-rev <rev>` | absolute cumulative totals and Azure revision |
| Ticket branch | `ticket-branch-info --hu <id> --ticket <id>` | `ticket-branch-set --hu <id> --ticket <id> --branch <name> --working-directory <path>` | exact branch; base is the verified HU branch |
| PR | `ticket-pr-info --hu <id> --ticket <id>` | `ticket-pr-link --hu <id> --ticket <id> --pr <id>` | exact completed PR ID |
| Merge commit | included in `ticket-pr-info` | `ticket-commit-link --ticket <id> --pr <id>` | merge commit resolved from the exact PR |
| Attachments | `ticket-attachment-info --ticket <id>` | `ticket-attachment-add --ticket <id> --file <path> --kind <http-json|screen|command-output>` | local file and evidence kind |
| Completion evidence | `ticket-evidence-info --ticket <id>` | `ticket-evidence-set --ticket <id> --evidence-file <path>` | sanitized UTF-8 HTML or Markdown source |
| Completion gates | `ticket-completion-info --hu <id> --ticket <id>` | `ticket-completion-apply --hu <id> --ticket <id> --pr <id> --manifest <path>` | explicit PR and completion manifest |

`ticket-info` is the efficient aggregate read used by the coordinator. The
specific `*-info` commands remain available for operators and focused tests.

## Shared safety rules

- Resolve field reference names from the repository-owned mapping; never infer
  them from display labels during delivery.
- Verify that the ticket is a direct `Task` or `Bug` child of the HU before any
  mutation.
- Require the HU's single native Branch `ArtifactLink` and the selected
  repository's matching Azure `origin` before branch or PR operations.
- Use exact IDs and refs. Never select the newest PR, guess a branch from a
  title, or parse semantic intent from `--prompt`.
- A setter is idempotent when the requested value/link/file digest already
  exists. A different existing value is a conflict unless the command contract
  includes an explicit expected value or revision.
- Use Azure revisions (`/rev` JSON Patch tests) for multi-field mutations.
- Never include credentials, cookies, tokens, authorization headers, or raw
  command lines containing secrets in output, checkpoints, or evidence.
- Reread the affected work item, PR, relation, or remote ref before success.

## Azure CLI and REST policy

Use a supported Azure CLI command first when its contract is complete and
stable. Preserve stderr and command context on failure. If the installed Azure
CLI lacks the operation or its route is broken, use `az rest` with Azure DevOps
resource `499b84ac-1321-427f-aa17-267ca6975798`:

- Work item reads: `GET .../_apis/wit/workitems/{id}?$expand=relations`.
- Field and relation mutations: JSON Patch with
  `Content-Type=application/json-patch+json` and an expected `/rev` test.
- Attachment upload: `POST .../_apis/wit/attachments?fileName=...` with
  `Content-Type=application/octet-stream`, followed by an `AttachedFile`
  relation patch.
- PR association: prefer `az repos pr work-item add/remove`; fall back to the
  exact PR `ArtifactLink` only after resolving project and repository IDs.

REST fallback belongs in one Azure adapter helper so individual commands do not
reimplement authentication, API versions, retries, encoding, or sanitization.

## Completion manifest

OpenCode writes a manifest under Git common metadata, never in the source tree:

```json
{
  "ticket": 23459,
  "ticketBranch": "refs/heads/ticket/23459-code-review",
  "commit": "<exact local commit>",
  "validation": [
    { "command": "npm run test:ci", "result": "145 passed" }
  ],
  "evidence": [
    { "path": "<absolute path>", "kind": "http-json", "sha256": "<digest>" },
    { "path": "<absolute path>", "kind": "screen", "sha256": "<digest>" }
  ]
}
```

The coordinator validates paths, digests, ticket identity, branch, commit, and
worktree cleanliness. For Chrome evidence, screenshots must be polished and
readable, while JSON evidence must be sanitized and pretty-printed with stable
indentation. Missing required evidence keeps the ticket incomplete.

## Target delivery state machine

1. `preflight-hu`: verify/provision the HU integration branch.
2. `selected`: refresh Azure, select one eligible direct child, and persist its
   identity plus effort baseline.
3. `started`: use `ticket-state-set` for `En progreso`; create and link the exact
   ticket branch from the verified HU branch. In a multi-repository workspace the
   branch is created in every participant but the single native Branch
   ArtifactLink is deferred to step 5, because it must name the primary
   repository — the first declared repository that actually changed.
4. `implementing`: start one OpenCode session with immutable HU, ticket, branch,
   and evidence-output context. OpenCode cannot select tickets or mutate Azure.
5. `implementation-ready`: OpenCode emits `IMPLEMENTATION_READY` and the
   validated completion manifest; the session is closed. A multi-repository
   workspace resolves its primary repository here and links the ticket branch
   there before validating any manifest.
6. `integrating`: the coordinator pushes the exact branch, creates or reuses one
   PR, completes it, and persists PR/merge receipts before the next effect.
7. `evidencing`: upload missing digest-identified attachments, publish readable
   completion evidence, and set cumulative effort exactly once.
8. `completing`: set `Done`, reread all gates, and persist verified completion.
9. `cleaning`: switch/update the HU branch, delete the exact ticket branch
   locally/remotely, clear the checkpoint, and only then refresh the queue.

Recovery resumes the persisted phase. A merged canonical PR always enters
`integrating`/`evidencing` reconciliation even when the ticket is not yet
`Done`; OpenCode is never resumed merely to repair Azure metadata.

## Checkpoint contract

The checkpoint uses a version and durable receipts for:

- `phase`, HU ID, ticket ID, integration branch, ticket branch, and session ID;
- Azure revision and effort baseline;
- active-duration accumulator excluding operator waits and retry backoff;
- local commit, PR ID, merge commit, and evidence manifest path/digests;
- per-effect receipts for PR association, commit link, attachments, evidence,
  effort, and final state.

Write intent before each external effect and its receipt immediately after
verification. Legacy four-field checkpoints remain readable and map
conservatively to `implementing` or `reconciling`; all subsequent writes use the
versioned shape.

## Prompt after migration

Remove instructions to select/move tickets, create/link branches, create/merge
PRs, upload attachments, set fields, or move tickets to `Done`. The prompt will:

- treat HU, ticket, integration branch, and ticket branch as immutable;
- implement only the selected ticket and commit only scoped changes;
- validate and perform two-pass code review;
- generate sanitized, polished Chrome captures and pretty JSON evidence at the
  coordinator-provided paths;
- emit `IMPLEMENTATION_READY` only after the manifest is complete.

The operator prompt is supplemental and cannot override identities, branches,
state-machine phases, or gates.

## Delivered slices

1. The normalized ticket model and read-only `*-info` commands use fixture-based tests.
2. Field, state, description, effort, branch, PR, attachment, and evidence mutations use revision guards, rereads, idempotency, and focused tests.
3. `ticket-completion-apply` composes the tested primitives without duplicating their mutation logic.
4. The versioned checkpoint and coordinator own branch/state creation and durable effect receipts.
5. `IMPLEMENTATION_READY`, manifest validation, and deterministic integration/evidence/completion phases define the Azure delivery contract.
6. `autocode-prompt.md` contains only scoped implementation, validation, review, commit, and evidence instructions; the obsolete legacy executor is removed.
7. Generic no-HU runs remain Azure-independent, and the Bun, installer, and whitespace suites validate the contract.

Every slice keeps generic no-HU runs independent of Azure and must not use
real credentials or a live backlog in automated tests.
