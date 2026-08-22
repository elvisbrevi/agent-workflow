---
status: accepted
---

# Shut down the machine when a run ends

A run declares `--off <password>` and, when it has nothing left to do, the
machine goes down. It is one global option rather than a flag of `plan` or of
`code`: the operator's intent is about the invocation, not about the workflow
inside it, so the same declaration ends a planning run, a drained GitHub queue,
a multi-repository Azure delivery, or a deterministic tool.

Overnight is when the option earns its place. A `code` run drains a queue one
fresh session at a time and finishes at an hour nobody chose; leaving the
machine awake until morning is the cost of every unattended run, and the
alternative the operator writes by hand — `lazy-workflow code … ; sudo
shutdown -h now` — shuts down on a parse error just as eagerly as on a finished
queue, because a shell chain cannot tell one exit from another. Wiring the
shutdown into the run is what lets it be told.

So the rule is stated at the one place a run ends: the invocation shuts down
whatever its outcome — success or failure, because a failure at 3am is still a
run the operator is not watching — except when the run died on an argument
error. There the operator is at the keyboard, having just mistyped a flag, and
powering their machine off for a typo is never what was asked. Nothing else
distinguishes the cases: the run log's own failure vocabulary already carries
`argument-error` past the Reporter, so the decision reads a classification that
exists instead of tracking a second one alongside forty return paths.

A grace period is the second way out. The shutdown announces itself, waits
fifteen seconds by default, and only then runs the command; the interruption
handlers are still installed while it waits, so Ctrl-C cancels the shutdown and
leaves the run recorded as interrupted, exactly as it would have been a moment
earlier. `--off-delay 0` removes the window for an operator who wants none.

The password reaches sudo through stdin, never through an argument, and
`LAZY_WORKFLOW_OFF_PASSWORD` is the form that keeps it out of `ps` and the shell
history altogether. Whatever sudo says back is redacted before it is reported,
because a failed shutdown must not be the thing that publishes the credential
into the run log. Declaring `--off` with no value at all falls back to that
variable and then to `sudo -n`, which fails immediately rather than blocking on
a prompt no one will answer.

The shutdown cannot change what the run was. It runs after the work and before
the run's final record, a failure to shut down is reported as a failure like any
other (`shutdown-failure`), and the exit code is the one the run had already
earned. A machine that stayed on is a nuisance; a run whose result changed
because of how it ended would be a defect.
