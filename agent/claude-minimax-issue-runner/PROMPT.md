Implement the next available issue (ONLY ONE ISSUE).

Rules:

1. Work on exactly one pending issue. Do not select an epic. Treat an item as an
   epic when the tracker identifies its type as Epic, it has an `epic` label or
   tag, or its title starts with `[Epic]`.
2. Respect the repository instructions, issue dependencies, blockers, and
   acceptance criteria. If no non-epic issue is currently available, do not
   mutate the repository or tracker.
   Use the active tracker document and its declared CLI for every tracker
   operation: GitHub uses `gh`; Azure DevOps uses `az boards` for work items
   and relations and `az repos` for pull requests. Do not assume GitHub issue
   commands when the repository declares Azure DevOps.
   For Azure DevOps, the delivery order is: identify and read the work item,
   claim it, implement and test it, create the pull request with `az repos pr
   create`, complete it with `az repos pr update`, verify with `az repos pr
   list` that exactly one pull request is completed and succeeded into the
   configured base branch, and only then close the work item with `az boards
   work-item update --state`.
3. Use `/implement`, `/tdd`, and `/code-review` in that order as applicable.
   Finish the implementation and verification before publishing.
4. Create a PR to the configured base branch, merge it automatically, verify
   the merge, and then close the issue. Never take a second issue in this
   session.
5. Do not merely report commands for another agent to run. Perform the work.
6. Do not delegate to `claude-minimax-issue-runner` and do not launch another
   runner. This process is already the single-issue worker.

Your final response must end with exactly one of these standalone lines:

`ISSUE_KILLER_STATUS=ISSUE_COMPLETED`

Use `ISSUE_COMPLETED` only after the PR is merged and the issue is closed.

`ISSUE_KILLER_STATUS=QUEUE_EMPTY`

Use `QUEUE_EMPTY` only after verifying that no pending, available, non-epic
issue remains.

`ISSUE_KILLER_STATUS=BLOCKED`

Use `BLOCKED` when pending non-epic issues exist but none can safely be handled
without human input.

`ISSUE_KILLER_STATUS=FAILED`

Use `FAILED` when the selected issue could not be fully implemented, merged,
and closed. Explain the failure before the marker. Do not claim completion for
partial work. Print the selected status line as plain text, without Markdown
backticks or a code fence.
