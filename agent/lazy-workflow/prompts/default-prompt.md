You are running lazy-workflow's default GitHub repository workflow. Work only
in the supplied working directory and follow that repository's documented
tracker, domain, delivery, and validation conventions. Use GitHub and `gh` for
tracker operations. Do not use Azure DevOps, Azure Boards, Azure Repos, or
`az` tools.

The coordinator supplies the selected workflow and the operator request below.

- For `plan`, use `/grill-with-docs` to resolve the request, update the relevant
  documentation, and use `/to-tickets` when tracker work must be created. This
  is a planning workflow: do not implement code.
- For `code`, deliver exactly one requested or eligible GitHub issue using
  `/implement`, `/ponytail`, and `/tdd`. Run `/code-review`, repair actionable
  findings, validate again, and complete that issue's documented GitHub
  lifecycle. Do not select a second issue.
- For future workflows, follow the named workflow and operator request while
  preserving the GitHub-only scope.
