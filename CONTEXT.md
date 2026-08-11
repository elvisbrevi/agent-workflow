# Lazy Workflow

This context defines the language used by the repository's sole executable
agent.

## Language

**Lazy workflow**:
The Bun-based workflow in `agent/lazy-workflow/` that sends a prompt to
OpenCode and emits a normalized JSON result.
_Avoid_: issue runner, queue supervisor

**GitHub repository run**:
A lazy-workflow `plan` or `code` invocation without `--hu`. It follows the
repository's GitHub conventions and never uses Azure coordination; `plan` runs
once, while `code` drains eligible issues one per fresh OpenCode session.
_Avoid_: implicit Azure run, unscoped run

**Azure HU run**:
A lazy-workflow invocation selected by `--hu`, or recovered from an Azure HU
checkpoint. It preserves the HU's planning or ticket-delivery lifecycle.
_Avoid_: GitHub repository run

**Default workflow prompt**:
The GitHub-only instructions used by a GitHub repository run for its selected
workflow and operator request.
_Avoid_: Azure HU prompt

**Azure HU planning run**:
A lazy-workflow invocation with `plan --hu <ID>`. It reads the Azure DevOps
User Story, combines that data with the English autoplan prompt, and starts
OpenCode in the selected working directory.
_Avoid_: Azure ticket delivery run

A fresh **Azure ticket delivery run** first queries the HU's native integration
branch and verifies or provisions `hu/<HU>` through structured
`--base-branch <name>` input before selecting a ticket, writing a checkpoint, or
starting OpenCode. The operator prompt is not a branch-management interface.

**Azure ticket delivery run**:
A lazy-workflow invocation with `code --hu <ID>`. It delivers one eligible
direct Task or Bug per fresh OpenCode session, verifies completion, removes the
completed ticket branch, and refreshes Azure before selecting the next ticket.
_Avoid_: Azure HU planning run

**Explicit command**:
The first argument must be `plan`, `code`, `hu-info`, `hu-branch-info`, or
`hu-branch-set`.
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
The normalized JSON representation of OpenCode JSONL output, including the
session identifier, final text, stop reason, token counts, and cost when
available.
_Avoid_: raw transcript

**Azure login continuation**:
When an HU planning run encounters an `az login --use-device-code` request,
lazy-workflow preserves the OpenCode session, waits for Azure access, and
resumes that same session once with `continue`.
_Avoid_: automatic credential capture
