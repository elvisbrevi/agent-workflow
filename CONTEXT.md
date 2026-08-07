# Autonomous Issue Execution

This context describes the language used to configure and run an autonomous worker that completes tracker issues through OpenCode.

## Language

**Execution profile**:
A named, validated pairing of the OpenCode runtime with one provider/model and the runtime behavior they require. Profiles are selected as indivisible options rather than assembled from independent runtime and model choices.
_Avoid_: Agent configuration, CLI/model combination, multi-CLI profile

**Fallback chain**:
An ordered list of alternative OpenCode **execution profiles** that may continue the same issue after an eligible provider failure. A chain contains only OpenCode profiles and ends when no alternatives remain or the operator selects none. A fallback continues the previous **worker session** when that session is still resumable, sending the next profile's model on the same session; it starts a fresh session only when no resumable session exists.
_Avoid_: Backup model, model rotation, mixed-provider fallback, cross-CLI handoff

**Host-owned issue selection**:
The supervisor rule that the runner alone chooses and pins the exact tracker item before any worker session starts. The model must not inspect, choose, or switch issues.
_Avoid_: Model-selected issue, assistant-discovered ticket

**Completion verification**:
The unconditional live tracker check that confirms real delivery before the queue may advance. A worker status marker alone is never sufficient. On GitHub it requires the issue closed, exactly one attributable PR, that PR merged, and `baseRefName` equal to the run's base branch; any other shape is `RECOVERY_REQUIRED`. On Azure it is **ticket completion**.
_Avoid_: Marker-only completion, trust worker status

**Opaque session id**:
The OpenCode session identifier persisted in the checkpoint after format validation. It is an opaque limited token, never a filesystem path, and is confirmed through the OpenCode session API before resume or delete.
_Avoid_: Resume path, transcript path, unvalidated session string

**Azure delivery HU**:
An Azure DevOps User Story that groups independently deliverable child tickets and owns their shared integration boundary. `issue-killer` does not complete or close the HU; its Azure execution ends when the selected child tickets are complete and integrated into the HU boundary.
_Avoid_: Azure issue, executable HU

**Pinned HU execution**:
An Azure run explicitly constrained to one **Azure delivery HU** and its delivery tickets. Recovery preserves both the HU and current ticket identities and never advances to a different scope implicitly.
_Avoid_: Issue adoption, inferred recovery scope

**HU integration branch**:
The shared destination for the branches of every ticket delivered under one **Azure delivery HU**. Its delivery category reflects the HU intent, and it is not automatically integrated into the repository's global mainline by `issue-killer`.
_Avoid_: Main branch, repository base branch

**HU delivery category**:
The `feature`, `hotfix`, or `refactor` classification inferred from the type and description of an **Azure delivery HU** and represented by its integration branch.
_Avoid_: Ticket type, branch prefix

**Azure delivery ticket**:
A non-completed Task or Bug that is a direct hierarchical child of an **Azure delivery HU**. It is implemented, integrated into the **HU integration branch**, and moved to the configured completed state as one delivery unit; related links and indirect descendants do not establish membership.
_Avoid_: HU, Azure issue

**Azure field mapping**:
The repository-owned association between a delivery evidence concept and the exact Azure DevOps field reference name that stores it. A mapping is discovered and validated once before ticket delivery and then reused.
_Avoid_: Display name, inferred field

**Completion evidence**:
The structured, human-readable proof recorded on an **Azure delivery ticket** describing the delivered change, its validation, visual or HTTP captures, and development references. Binary captures belong to the ticket as attachments rather than to the source repository.
_Avoid_: Worker log, screenshot folder

**Evidence modality**:
The mandatory proof selected from the delivered behavior: HTTP interaction for backend changes, visible screens for frontend changes, both for mixed changes, or reproducible command/test output when no executable interface exists.
_Avoid_: Optional screenshot, generic validation note

**Real effort**:
The cumulative active agent time spent delivering an **Azure delivery ticket**, expressed in hours rounded upward to quarter-hour increments. It includes implementation and verification work but excludes operator waits and provider backoff.
_Avoid_: Wall-clock duration, estimate

**Ticket completion**:
The verified Azure state reached after a ticket PR is integrated into its **HU integration branch**, native development links and **completion evidence** are present, **real effort** is published, and the ticket is moved to its completed state. Integration alone is recoverable partial progress, not completion.
_Avoid_: PR merged, code complete

**Worker session**:
The OpenCode conversation bound to one pinned issue for one attempt. Its identity is the **opaque session id** obtained and confirmed through the OpenCode SDK, not inferred from branches, files, or assistant text.
_Avoid_: Conversation, chat, multi-runtime session, CLI transcript layout

**Resumable session**:
A **worker session** that OpenCode still exposes for the same directory, issue, branch, base identity, and **execution profile** family allowed by recovery policy. If resumability cannot be confirmed, recovery fails closed to a fresh worker constrained to the checkpointed issue.
_Avoid_: Resume safe, session present, filesystem transcript check

**Provider failure category**:
A normalized classification — `provider_quota`, `provider_rate_limit`, `provider_model_unavailable`, or `none` — produced from OpenCode/SDK diagnostics. Only the first three categories may consume a **fallback chain** entry. Generic transport failures, malformed output, `BLOCKED`, and `FAILED` never consume a fallback.
_Avoid_: Provider crash, CLI error, retryable failure, mixed-provider failure

**Event pump**:
The single ordered consumer of OpenCode session events for one **worker session**. It drains every matching event, updates checkpoint/status, and never stops after the first tool or message part.
_Avoid_: First-event wins, partial stream read

**Structured worker outcome**:
The primary final status object produced by the worker session (`status`, `issue`, `summary`). Text status markers are compatibility-only while V1 coexists and are removed when V1 is retired. Contradictory or invalid outcomes never advance the queue.
_Avoid_: Marker-only outcome, trust free-form assistant prose

**Autonomous permission mode**:
After the operator's one-time destructive confirmation, the local OpenCode instance runs with full tool permission for that run. Mid-run permission prompts are not used; an unexpected permission event stops the run instead of approving a new category silently.
_Avoid_: Interactive mid-run approval, partial allow without confirmation

**Harness execution log**:
A per-run audit file written by the supervisor from observed OpenCode/tool events (commands, file creates/edits/deletes, and related progress). All such files are written only under the operator-configured log directory from config TOML. It is not model output, is not sent back into the prompt, and must not consume model tokens.
_Avoid_: Agent-written diary, prompt-attached transcript, raw SDK dump, hard-coded log path

## Example Dialogue

Developer: "Which execution profile should issue-killer use?"

Operator: "Use the OpenCode main profile with the high-reasoning model."

Developer: "What happens if that OpenCode provider reaches its subscription limit?"

Operator: "Continue the same issue with the next execution profile in its fallback chain."

Developer: "Can the model pick the next GitHub issue itself?"

Operator: "No. Host-owned issue selection pins the ticket before the worker session starts."

Developer: "The worker printed ISSUE_COMPLETED. Are we done?"

Operator: "Only after completion verification confirms the live tracker and PR state."
