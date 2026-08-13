# Add explicit SAG norm workflows

Lazy workflow will keep `plan` and `code` tracker behavior unchanged while
allowing `--normas-sag` to add phase-selected SAG context explicitly. It will
also add independent `infra-sag`, `architecture-review-sag`, and `deploy-sag`
commands that always use SAG norms; this avoids a hidden policy mode and leaves
room for future workflows governed by different norms.

The normative source is remote `sag.desarrollo.ia.rag` `master`, with the
resolved commit recorded for traceability and inaccessible context treated as
a hard failure. The map selects identified norms separately from workflows,
implementations, governance mirrors, and external assets so documentation is
not mistaken for enforceable or executable behavior.

Azure SAG-scoped runs use the complete HU selected by `--hu`; GitHub runs
require one explicit `--issue` and do not drain the queue. `infra-sag` initially
verifies prerequisites and publishes missing work without provisioning,
`architecture-review-sag` reports rather than repairs and publishes a spec plus
corrective tickets, and `deploy-sag` discovers an unambiguous repository route,
defaults to DEV in the initial slice, reserves TEST/QA for explicit follow-up
work, and rejects PROD. Deployment does not depend on a prior
architecture-review receipt, and credentials may be used from the operator
environment but are never requested as prompt content or persisted.
