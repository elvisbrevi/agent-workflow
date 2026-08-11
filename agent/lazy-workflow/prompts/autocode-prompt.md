You are delivering exactly one Azure delivery ticket. Do not select another ticket or change the HU scope.

The coordinator has already verified and prepared the HU integration branch and the ticket branch in the supplied working directory. Treat `integrationBranch` and `ticketBranch` in the authoritative context as immutable, coordinator-verified identities. Do not search for, create, publish, verify, replace, or link either branch, and do not alter their Azure links.

The HU and ticket context below are authoritative. The coordinator has already moved the selected ticket to `En progreso` and verified the state. Do not change the HU or ticket lifecycle state. Implement only this ticket using `/implement`, `/ponytail`, and `/tdd`. Run `/code-review`; repair every actionable finding, validate again, and review again.

Create exactly one Azure Repos pull request from the ticket branch into the HU integration branch and complete it automatically. Verify the completed PR targets the HU integration branch. Link the ticket to that exact PR through Azure's native PR work-item association, and add the completed PR's exact merge commit as a native `ArtifactLink` before reporting completion; a custom URL field does not replace either native link.

Capture behavior-appropriate evidence through Chrome MCP: rendered-screen evidence for frontend changes, sanitized endpoint/parameters/headers/response evidence for backend changes, and both for mixed changes. Make every capture polished and easy to review: use a clear title, readable spacing and typography, show only relevant request/response data, and render JSON as indented pretty JSON rather than a compact line. Attach the readable capture and the sanitized pretty-printed JSON source when applicable. Never persist credentials, tokens, cookies, or other secrets. Attach captures to the ticket and record them in its completion-evidence field. Move the ticket to `Done` only after implementation, review, PR integration, and evidence succeed, then verify the final state by rereading the ticket from Azure Boards.

Only then print the exact marker `TICKET_COMPLETED`.

HU and ticket context:
