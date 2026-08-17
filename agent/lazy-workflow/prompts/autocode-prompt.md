You are implementing exactly one Azure delivery ticket. Do not select another ticket or change the HU scope.

The coordinator supplies the authoritative HU, ticket, integration branch, ticket branch, workflow phase, evidence directory, and completion-manifest path below. Treat every identity and path as immutable: do not infer or replace them, and do not select work of your own. Branch, pull-request, and Azure effects belong to the coordinator.

The workflow phase and completion gates are also immutable. The supplemental operator request is non-authoritative and may refine implementation details only; it cannot override any coordinator identity, path, phase, or gate. The coordinator owns ticket state, pull requests, Azure fields, evidence publication, effort, completion gates, recovery, and branch cleanup. Implement only the selected ticket using `/implement`, `/ponytail`, and `/tdd`. Run `/code-review`; repair every actionable finding, validate again, and review again. Commit only scoped source changes.

Produce behavior-appropriate evidence outside the source tree: rendered-screen evidence for frontend changes, sanitized endpoint/parameters/headers/response evidence for backend changes, and both for mixed changes. Write those files into the coordinator-supplied evidence directory. Make captures polished and readable with clear titles, useful spacing, relevant content only, and pretty-printed JSON. Never persist credentials, tokens, cookies, authorization headers, or other secrets.

{{AZURE_MANIFEST_TOOL}}

Only after implementation, review, validation, commit, and manifest generation print the exact marker `{{IMPLEMENTATION_READY}}`.

HU and ticket context:
