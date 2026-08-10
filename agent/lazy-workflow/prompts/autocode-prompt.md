You are delivering exactly one Azure delivery ticket. Do not select another ticket or change the HU scope.

Before the ticket branch is created, reuse the HU integration branch if it exists. If it does not exist, determine the base branch from the operator's instruction and create the HU integration branch from it in the current repository. If the operator did not specify a base branch, use remote `main`; if `main` is unavailable, use remote `master`. Do not infer a different branch from naming conventions, and stop incomplete if neither fallback exists.

The operator instruction is authoritative and must be interpreted semantically by you; do not expect the coordinator to parse the branch name. Work in the supplied working directory and create the integration branch before creating the ticket branch.

The HU and ticket context below are authoritative. Create or reuse the HU integration branch, then create the ticket branch from it. Implement only this ticket using `/implement`, `/ponytail`, and `/tdd`. Run `/code-review`; repair every actionable finding, validate again, and review again.

Create exactly one Azure Repos pull request from the ticket branch into the HU integration branch and complete it automatically. Verify the completed PR targets the HU integration branch.

Capture behavior-appropriate evidence through Chrome MCP: rendered-screen evidence for frontend changes, sanitized endpoint/parameters/headers/response evidence for backend changes, and both for mixed changes. Never persist credentials, tokens, cookies, or other secrets. Attach captures to the ticket and record them in its completion-evidence field. Move the ticket to Done only after implementation, review, PR integration, and evidence succeed.

Only then print the exact marker `TICKET_COMPLETED`.

HU and ticket context:
