---
status: accepted
---

# Plan from the work, then choose the repositories

The window planned from a repository: a GitHub repository planned a prompt, an
Azure HU was planned in whichever repository its section had been read from, and
a GitHub issue reached its plan only as a sentence in `--prompt` (ADR-0045). The
operator starts from the work instead — an epic on GitHub, an HU or a Bug in
Azure — and picks the repositories after.

**Planificar** lists what is assigned to the operator and a plan can slice:
the GitHub issues the queue already reads as epics (an `[Epic]`/`[Spec]` title
prefix or the `epic` label, which `work-assigned` now answers as the `Epic`
type), and the Azure User Stories, Product Backlog Items and Bugs no story owns.
Only what is assigned: an HU that appears in Trabajo because one of its tasks is
assigned is not the operator's to plan. Choosing one opens the plan form, whose
first field is where to work — the saved repositories of that tracker, in
delivery order, preselected only when there is a single one. Trabajo and its
repository-level **Nuevo plan** stay as they were. No read command was added:
`work-assigned` answers everything the list needs.

**A Bug no story owns is an HU.** Plan publishes Tasks under it and `code --hu
<bug>` drains them; the Azure adapter's HU checks accept a Bug parent, and
`work-assigned` groups those Tasks under it. A Bug whose parent is a User Story
or a Product Backlog Item is that story's delivery ticket, and `plan` refuses it
before any session opens rather than hang Tasks from a unit `code` delivers
whole. Where a delivery moves its HU once no delivery child is left open — the
multi-repository delivery — a Bug moves to `En revisión` instead of `Desarrollo
Terminado`: its workflow has no development-finished state, and it stops short
of `Done` so a person verifies the fix. Single-repository delivery still moves
no HU, story or Bug.

**An epic is sliced by the coordinator, not named in a prompt.** `plan --issue
<n>` reads the epic from the first repository before the session opens,
requires it open and an epic by the queue's predicate, and gives the session
that snapshot, the way an Azure plan receives its User Story. Publication then
hangs every issue it created from the epic as a native sub-issue, read back like
a blocking edge. That relation is what GitHub parent reconciliation already
reads to close the epic once its sub-issues are closed, so an epic planned here
closes itself as `code` delivers it.

The epic's own repository stays first. Reconciliation reads a parent by number
in the repository of the issue it just closed, so an issue published in another
repository would name the wrong parent; other repositories may join the plan's
workspace, and the issues are still published in the epic's. An issue that is
not an epic keeps ADR-0045's prompt-only plan.

`code` does not change: it drains the repository's managed queue, of which the
epic's sub-issues are part. Scoping it to one epic remains a coordinator change.

Rejected: listing every open item of the project, which the operator did not
want; publishing an epic's issues in whichever repository was chosen, which
breaks reconciliation as above; and closing a Bug HU in `Done`, which would skip
the verification a story gets from `Desarrollo Terminado`.
