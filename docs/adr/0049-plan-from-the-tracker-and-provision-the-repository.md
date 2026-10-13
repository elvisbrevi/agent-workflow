---
status: accepted
---

# Plan from the tracker, and provision the repository it is worked in

ADR-0047 listed what a plan could slice out of each saved repository's assigned
work, so an HU whose repository was not on this machine could not be planned at
all, and an epic could only be planned in its own repository. The operator
starts from the tracker instead: they pick an HU, a Bug or an epic, then decide
where it is worked — a folder they already have, a repository downloaded from
the tracker, or a new one created there.

**What is plannable is read at the tracker.** `lz work-plannable --tracker
azure` answers the HUs in `En Desarrollo` and the Bugs in `En progreso` assigned
to the operator across the organization, or one project with `--project`; a Bug
under a story is still that story's ticket and is left out. `--tracker github`
answers the open epics, by the managed queue's predicate, of every repository of
the operator's account and organizations. Repositories of other people the
operator collaborates on are not searched. The states are named once, beside
the query, in the Azure adapter.

**Provisioning is a deterministic tool, not a session.** `azure-project-list`,
`azure-repo-list` and `github-owner-list` read where a repository can come from;
`repo-clone` and `repo-create` write it. Both only create a folder that does not
exist yet under one that does, and both are runs an operator can follow and
repeat. An Azure clone keeps a credential helper that answers git with the
`AZURE_DEVOPS_EXT_PAT` lz loads into every run, so a later `code` pushes without
the secret being written to disk or shown in a process list. A created
repository is private and starts with a commit on `main`, because a delivery
provisions `hu/<HU>` from `main` or `master` and an empty repository has neither.

**An epic's issues go where the plan is worked.** `plan --issue <n>
--issue-repository owner/name` reads an epic of another repository and publishes
its issues in the first working directory, where `code` drains them, as native
sub-issues of the epic. Parent reconciliation now reads each relation with its
repository, and comments on and closes a parent in its own repository (`-R`), so
the epic closes once its sub-issues are delivered wherever they live. A parent in
the run's own repository is written exactly as before. This replaces ADR-0047's
rule that an epic's issues stay in its repository.

**The window composes these commands.** Planificar lists `work-plannable` and
opens the plan form, whose first field is where to work. A download or a
creation runs from the form without leaving it; when it succeeds, the folder is
registered and becomes the chosen one, and Plan runs there like anywhere else.
Over the web, a new `destination` value kind is accepted only as a new, visible
folder directly under a folder the browser may walk, and a command that takes no
working directory runs below those roots when no repository is registered yet.

Separately, **Ajustes shows each command's own agent.** Plan's and Code's forms
can save an agent of their own, which wins over the default one; it was never
shown, so a changed default looked unsaved. Ajustes now shows it, edits it and
removes it.

Rejected: listing every open item of the project, which the operator did not
want; cloning inside the plan session, which would give a planning authority
network writes it does not need; and keeping an epic's issues in its own
repository, which would leave them outside the queue `code` drains in the
repository the operator chose.
