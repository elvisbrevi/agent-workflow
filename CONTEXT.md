# Autonomous Issue Execution

This context describes the language used to configure and run an autonomous worker that completes tracker issues.

## Language

**Execution profile**:
A named, validated pairing of one agent CLI with one model and the runtime behavior they require. Profiles are selected as indivisible options rather than assembled from independent CLI and model choices.
_Avoid_: Agent configuration, CLI/model combination

**Fallback chain**:
An ordered list of alternative **execution profiles** that may continue the same issue after an eligible provider failure. A chain contains only OpenCode profiles and ends when no alternatives remain or the operator selects none.
_Avoid_: Backup model, model rotation

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

## Example Dialogue

Developer: "Which execution profile should issue-killer use?"

Operator: "Use the Codex profile with the high-reasoning GPT model."

Developer: "What happens if that OpenCode provider reaches its subscription limit?"

Operator: "Continue the issue with the next execution profile in its fallback chain."
