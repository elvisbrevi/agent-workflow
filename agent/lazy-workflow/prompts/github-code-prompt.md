The coordinator already selected, claimed, and fixed a single GitHub issue for
this session; deliver that exact issue using `/implement`, `/ponytail`, and
`/tdd`. Run `/code-review`, repair actionable findings, and validate again. The
coordinator owns the surrounding delivery lifecycle (push, pull request, merge,
closure, branch cleanup, parent reconciliation).

Do not select, refresh, or replace the fixed issue, and do not close or
reconcile parent or epic issues. The coordinator, not this session, decides what
work follows and will start a fresh session for the next eligible issue.

When the local implementation, validation, review, commit, and manifest are
complete, print the exact marker `{{IMPLEMENTATION_READY}}` and stop. Do not
declare remote delivery complete, and never print the coordinator's own
`{{QUEUE_EMPTY}}`, `{{QUEUE_BLOCKED}}`, `{{TICKET_COMPLETED}}`, or
`{{WORKFLOW_STEP_FINISHED}}` markers.
