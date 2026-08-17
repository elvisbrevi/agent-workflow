---
status: accepted
---

# Drain Azure workspace tickets without a fixed ticket

`code --hu` over a multi-repository workspace selects and delivers the HU's
eligible `Task` and `Bug` children one at a time until the queue is empty or
blocked, exactly as the single-repository run does. `--ticket` remains available
and now means what it says: deliver that one unit and stop.

The workspace run used to reject a command without `--ticket` as an argument
error. That was never a property of multi-repository delivery — it was the
single-repository selection step left unwired when the workspace path was
added, and the requirement was the shape of the gap rather than a decision. It
made the two scopes disagree about what `code --hu` means: the same command that
drains sixteen tickets against one repository refused to start against two, and
an operator draining an HU had to read the dependency graph out of Azure by hand
and issue one command per ticket in an order the coordinator already knows.

Selection is the existing one, not a second implementation. The workspace run
asks `getAutocodeState` for the next unit, so eligibility, the predecessor
gate, the completed-state filter and the `createdDate` ordering are computed in
one place for both scopes. A ticket the coordinator finished is in a completed
state and is therefore not selected again, which is what terminates the drain.

The checkpoint keeps pinning a concrete ticket, so recovery is unchanged. A
surviving checkpoint is the delivery in flight and it wins over selection — the
run resumes that unit rather than choosing a new one, and a `--ticket` that
contradicts it is an operator error rather than a reason to abandon work already
underway. Only the first run of a unit chooses; every later one recovers.

The drain continues only after a clean delivery. An unclean one — a repository
whose ticket branch survived, an unwritable aggregate manifest — stops with its
checkpoint intact, because claiming the next ticket would bury the state the
operator has to reconcile under a second delivery. For the same reason a pending
queue with nothing eligible stops and says so instead of reporting an empty one:
a dependency that has not landed yet is a wait, and an HU with no open children
is a finish, and the two must not be reported as the same outcome.
