# Issue Tracker: GitHub

Issues and specifications for this repository live in GitHub Issues at `elvisbrevi/agent-workflow`. Use the `gh` CLI for all operations and infer the repository from the configured Git remote.

## Conventions

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
