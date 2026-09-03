# Complete an Azure ticket after verified integration and closure evidence

An Azure ticket reaches `Done` only after its reviewed branch is merged through
exactly one verified PR into the HU integration branch, native links to the PR
and integrated commit are present, the completion-evidence field and the
cumulative real effort are verified by rereading Azure, and all effects reconcile
successfully. Completing that PR sets Azure's `deleteSourceBranch` option, so the
remote ticket branch is removed by the merge itself; coordinator cleanup still
verifies the integration branch and removes any surviving local or remote ref
idempotently. Azure withdraws the ticket's Branch ArtifactLink together with the
branch it names, so after the merge the delivered branch is read from the
associated completed PR that integrated it into the HU branch; a ticket whose
branch is gone is not a ticket without a branch. The runner persists intent
before each external effect; after interruption it reuses the merged PR and adds
only missing links, field updates, or state transition, so a
merged-but-incomplete ticket remains recoverable without duplicating effort.

Nine gates remain. The `attached-capture` gate is removed with the evidence
system, and the completion-evidence field is now populated by the session's
closing summary (ADR-0037). Rereading Azure to verify what was just written stays
required: Azure Boards accepts partial writes without error — a custom field the
process does not expose, a transition a project rule rejects, an ArtifactLink
that never lands — and those failures are invisible until someone opens the
ticket weeks later.
