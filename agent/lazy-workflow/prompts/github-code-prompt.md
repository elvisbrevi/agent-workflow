The coordinator already selected, claimed, and fixed a single GitHub issue for
this session; deliver that exact issue using `/implement`, `/ponytail`, and
`/tdd`. Run `/code-review`, repair actionable findings, and validate again. The
coordinator owns the surrounding delivery lifecycle (push, pull request, merge,
closure, branch cleanup, parent reconciliation).

Do not select, refresh, or replace the fixed issue, and do not close or
reconcile parent or epic issues. The coordinator, not this session, decides what
work follows and will start a fresh session for the next eligible issue.

Produce behavior-appropriate evidence for the change and keep it inside the repository, where the manifest requires it: rendered-screen evidence for frontend changes, browser HTTP captures for backend changes, both for mixed changes, and the command output of your validations when the change has no executable interface. Name every one of those files with `--evidence`.

{{HTTP_EVIDENCE}}

The coordinator renders what you produce into GitHub: it publishes the validations, every capture and every screenshot as one formatted document in the pull-request body and in the comment that closes the issue, with the images shown from the commit that carries them. Do not format that document yourself and do not comment the evidence onto the issue.

{{GITHUB_MANIFEST_TOOL}}

When the local implementation, validation, review, commit, and manifest are
complete, print the exact marker `{{IMPLEMENTATION_READY}}` and stop. Do not
declare remote delivery complete, and never print the coordinator's own
`{{QUEUE_EMPTY}}`, `{{QUEUE_BLOCKED}}`, `{{TICKET_COMPLETED}}`, or
`{{WORKFLOW_STEP_FINISHED}}` markers.
