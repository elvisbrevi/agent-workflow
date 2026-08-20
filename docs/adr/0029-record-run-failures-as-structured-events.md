---
status: accepted
---

# Record run failures as structured events

A run writes a run log beside the operator stream: one JSON Lines file whose
records name what the run was, what failed, and how it ended. Every failure and
every interruption produces a record, the labels on that record are a fixed
low-cardinality set, and the classification of a failure is a closed vocabulary
declared once. A monitoring service scrapes the file; nothing in the workflow
depends on it.

The failures are already reported — they are just not reportable. Around forty
call sites in the CLI end a run with a line of the same grammar, `no se pudo …;
ejecución detenida.` or `… checkpoint conservado.`, and every one of them goes
out through `reportOperator`, which is `info`. Production code emits no `error`
level at all today. That is what a metric cannot be built on: the severity of a
run's worst moment is indistinguishable from the severity of its progress, and
the only thing separating the two is Spanish prose. So the classification is
made at the failure site rather than inferred by a reader — a typed emission
carrying its failure kind and its context, routed to the Reporter level the
failure actually has. The alternative, a sink that pattern-matches the printed
line, was rejected because it makes every wording change a silently broken
counter, and the wording is prose written for a human, which is exactly the
thing that should stay free to change.

Levelling the failures correctly repairs a contract the documentation already
claims. `--quiet` is documented as showing errors only, and the README shows it
printing a line with the `✖` glyph; because no call site ever emits `error`,
today a `--quiet` run that fails is completely silent. The visible change is
therefore a fix, not a new behavior: the failure lines gain their glyph and
survive `--quiet`. Exit codes, terminal protocol markers, the stdout JSON
payloads, and every checkpoint are untouched.

An interruption is a first-class record because it is the case with no record at
all. There is no signal handler anywhere in the agent and no catch above
`main.ts`: a Ctrl-C, a `kill`, or a throw above every catch ends the process
leaving a preserved checkpoint on disk as the sole evidence that a delivery was
in flight — evidence that says a run started and says nothing about why it
stopped. Handlers now write one final record and then let the default behavior
proceed, so the log gains the ending without the run gaining a new one.

JSON Lines in a file, and not an exporter, is what the observability need
actually is right now. A collector — Promtail, Alloy, Vector, Filebeat — tails a
newline-delimited JSON file with no parser and no agreement to negotiate, so the
file is the integration, and a later OTLP exporter would read this same record
shape rather than replace it. It lives at a single stable path under the user's
XDG state directory rather than beside the checkpoints under `.git/`, because a
collector must be pointed at one path: checkpoint state is per repository, and a
multi-repository workspace run has no repository to write into. Size-capped
rotation keeps one previous generation, since an unbounded file on a laptop is
the failure mode that gets logging switched off entirely.

What may be a label is bounded on purpose. The run's identity, command,
workflow, provider, CLI, model, severity, event, failure kind, phase and outcome
are labels; an Issue number, a ticket, an HU, a repository path, a session id
and a branch are context. The split is the difference between a dashboard that
groups and a time series that explodes into one series per issue ever worked. In
the same spirit a record carries no credential, no prompt and no diff content —
the run log is a description of a run, not a copy of it.

Logging is best-effort by construction, because the run is the product and the
log is the description. A full disk, a read-only home, or a path that cannot be
created must not change an exit code, abort a delivery, or fail a validation.
The sink warns once on the terminal and disables itself for the remainder of the
run. It is enabled by default and can be pointed elsewhere or switched off,
since observability nobody turned on observes nothing.
