# Lazy Workflow

This context defines the language used by the repository's sole executable
agent.

## Language

**Lazy workflow**:
The Bun-based workflow in `agent/lazy-workflow/` that sends a prompt to
OpenCode and emits a normalized JSON result.
_Avoid_: issue runner, queue supervisor

**Azure HU planning run**:
A lazy-workflow invocation with `plan --hu <ID>`. It reads the Azure DevOps
User Story, combines that data with the English autoplan prompt, and starts
OpenCode in the selected working directory.
_Avoid_: ticket implementation run, backlog drain

**Explicit command**:
The first argument must be `plan` or `hu-info`. Missing or unsupported
subcommands print help and do not call Azure Boards or OpenCode.
_Avoid_: accidental OpenCode execution

**HU information query**:
The `hu-info --hu <ID>` command that prints the selected User Story as JSON
without starting OpenCode.
_Avoid_: planning execution

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
