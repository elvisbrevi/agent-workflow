---
status: accepted
---

# Coordinate GitHub delivery outside OpenCode

GitHub `code` runs use a repository-owned coordinator for queue discovery,
stable oldest-first selection, verified claiming, branch and pull-request
effects, issue closure, parent reconciliation, recovery, and terminal queue
outcomes. The coding session receives one fixed issue and implements it on the
branch the coordinator fixed; it cannot select work, mutate remote GitHub state,
or declare the run's outcome. This superseded the prompt-driven queue drain that
preceded it, because provider text is not a reliable control plane and partial
remote delivery requires deterministic recovery.

That reasoning was carried to its conclusion later: the session's own completion
signal was itself provider text. It is now the process exit plus what git
answers about the branch (ADR-0035), and the manifest the session used to
return is gone (ADR-0037).

Selection orders eligible issues by creation time and then issue number, claims
the selected issue, and rereads it before work starts. A repository-scoped
checkpoint records only that the unit passed verification, so an interrupted
delivery is finished without opening a session (ADR-0038). After a child closes,
native parents close recursively only when they have at least one native
sub-issue, every direct sub-issue is closed, and no native dependency remains
open. The coordinator decides every queue outcome from the tracker itself;
unrelated `needs-triage` issues are outside the managed queue, while any open
child prevents parent closure.
