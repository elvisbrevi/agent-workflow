---
status: accepted
---

# Enforce OpenCode authority with permission profiles

Every lazy-workflow run declares an agent authority profile whose OpenCode
`permission.bash` deny rules the provider enforces, instead of stating the same
prohibitions as prompt prose. ADR-0020 rejected provider text as a control plane
for queue outcomes; the same reasoning applies to what a session may execute,
because a prompt is advice a model may ignore while a denied tool call cannot
run.

OpenCode is invoked with `--auto`, which auto-approves only what is not
explicitly denied, so the deny rules are the whole enforcement surface. The
profiles are injected through `OPENCODE_CONFIG`, which merges with the target
repository's own configuration rather than replacing it, so enforcement does not
depend on the target repository having been configured for lazy-workflow.

There is one profile per authority a run can hold: GitHub planning, GitHub
delivery, Azure planning, Azure delivery, and review. Each denies the delivery
effects the coordinator owns — pushes, branch creation and deletion, remotes,
tags, pull-request operations — and the tracker CLI of the provider it does not
own. Review additionally denies edits, so a review that modifies the tree fails
at the tool call rather than at the after-the-fact worktree check. Committing
stays allowed in delivery profiles because the completion manifest names a
commit OpenCode must produce.

The profile is derived from the same spec as the prompt and returned with it, so
a run cannot carry a delivery prompt without the matching authority. Prohibitions
a permission cannot express — do not select other work, treat coordinator
identities as immutable, do not print coordinator markers — stay in the prompt,
because they constrain judgment rather than execution.
