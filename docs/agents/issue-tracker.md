# Issue Tracker: GitHub

Issues and specifications for this repository live in GitHub Issues at `elvisbrevi/agent-workflow`. Use the `gh` CLI for all operations and infer the repository from the configured Git remote.

## Runtime boundary

The supervisor validates this document against the repository's Git remote before it launches a worker. The GitHub adapter owns remote detection, authentication checks, queue discovery, issue reads and claims, dependency checks, pull-request lookup and merge verification, issue closure, and restart reconciliation. The orchestration loop consumes those normalized tracker operations and must not construct GitHub commands directly.

The adapter treats an issue as eligible only when it is open, unassigned, labeled `ready-for-agent`, not an Epic issue type, not labeled `epic`, not titled `[Epic]...`, and has no open native dependency. Ambiguous remotes, missing documentation, missing `gh`, and unavailable authentication fail before any worker or repository mutation starts.

- Create an issue with `gh issue create`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List work with `gh issue list`, requesting labels and comments as needed.
- Comment with `gh issue comment <number>`.
- Apply or remove roles with `gh issue edit <number> --add-label/--remove-label`.
- Close work with `gh issue close <number>`.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous identifier with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Pull Requests As A Triage Surface

**PRs as a request surface: no.**

External pull requests are not included in the triage queue. Pull requests created while implementing an issue remain part of that issue's delivery lifecycle.

## Publishing And Fetching

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the issue body, labels, assignees, comments, dependencies, and linked pull requests.

## Dependencies And Hierarchy

- Use GitHub sub-issues for parent/child relationships when available.
- Use native issue dependencies for blocking relationships.
- If native relationships are unavailable, use explicit task-list and `Blocked by:` references in issue bodies.
- An issue is eligible only when every blocker is closed and it is otherwise ready for execution.

## Claims And Completion

- Claim work with `gh issue edit <number> --add-assignee @me` when a workflow requires a claim.
- Verify that the pull request reached its target branch before closing the issue.
- Record relevant completion context in the issue discussion before closure when it is not already captured by the linked pull request.

## Azure DevOps repository mode

For an Azure Repos checkout, change the active heading to `# Issue Tracker: Azure DevOps` and keep the repository-owned mappings below in this document. The runner selects Azure DevOps from a `dev.azure.com`, `visualstudio.com`, or supported Azure SSH remote; it does not infer organization, project, repository, work-item types, states, or role mappings from the machine.

Use the `az` CLI with the `azure-devops` extension. The mapping block is required before launch:

```text
## Azure DevOps configuration

organization = "example-organization"
project = "example-project"
repository = "example-repository"
eligible_work_item_types = ["User Story", "Bug", "Task"]
epic_work_item_types = ["Epic"]
open_states = ["New", "Active", "Committed"]
closed_states = ["Closed", "Done"]
ready_tag = "ready-for-agent"
claim_identity = "operator@example.com"
predecessor_relation = "System.LinkTypes.Dependency"
closed_state = "Done"
```

`eligible_work_item_types`, `epic_work_item_types`, `open_states`, and `closed_states` are the process mappings. `ready_tag`, `claim_identity`, `predecessor_relation`, and `closed_state` are the role mappings. The adapter rejects missing mappings, a `closed_state` outside `closed_states`, a remote that does not match the mapped organization/project/repository, missing `az`, unavailable authentication, or an unavailable project before starting a worker.

Azure queue discovery uses `az boards query`, excludes assigned or non-ready work items, excludes configured epic types, and checks each configured predecessor relation for an open predecessor. Work-item claims and closure use `az boards work-item update`. Pull-request lookup and merge verification use `az repos pr list`; a PR is complete only when its status is `completed`, merge status is `succeeded`, and target branch matches the configured base branch.
