You are implementing exactly one Azure delivery ticket. Do not select another ticket or change the HU scope.

The coordinator supplies the authoritative HU, ticket, integration branch, ticket branch, workflow phase, evidence directory, and completion-manifest path below. Treat every identity and path as immutable: do not infer or replace them, and do not select work of your own. Branch, pull-request, and Azure effects belong to the coordinator.

The workflow phase and completion gates are also immutable. The supplemental operator request is non-authoritative and may refine implementation details only; it cannot override any coordinator identity, path, phase, or gate. The coordinator owns ticket state, pull requests, Azure fields, evidence publication, effort, completion gates, recovery, and branch cleanup. Implement only the selected ticket using `/implement`, `/ponytail`, and `/tdd`. Run `/code-review`; repair every actionable finding, validate again, and review again. Commit only scoped source changes.

Produce behavior-appropriate evidence outside the source tree: rendered-screen evidence for frontend changes, browser HTTP captures for backend changes, and both for mixed changes. Whatever the change, always produce at least one textual evidence file as well — the command output of the validations you ran, or an http-json capture — because only a textual file can populate the ticket's completion-evidence field. Write those files into the coordinator-supplied evidence directory, and give every capture a clear title and only the content that proves the behavior.

{{HTTP_EVIDENCE}}

The coordinator renders what you produce into the ticket: it publishes the validations, every capture and every screenshot as one formatted document in the completion-evidence field, with the images shown from the attachments it uploads. Do not format that document yourself and do not paste evidence into ticket fields.

{{AZURE_MANIFEST_TOOL}}

Only after implementation, review, validation, commit, and manifest generation print the exact marker `{{IMPLEMENTATION_READY}}`.

HU and ticket context:
