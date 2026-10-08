---
status: accepted
---

# Render the CLI from its own catalog

The desktop GUI does not know the CLI's commands. `lz catalog` prints them — each
command's family and effect, its flags with their value kinds, defaults,
requirements and conflicts, and the shared flag groups it accepts — and the GUI
draws a form per entry, builds the argument vector from the form, shows it, and
runs `lz` with it as a child process. Every validation, checkpoint and run-log
record stays the CLI's; the GUI's only state is its settings file, which
prefills forms and shapes the environment of the runs it starts.

The catalog is data written beside the parser, not derived from it: yargs knows
the flags but not which command takes which, nor what a command changes. A test
pins one to the other instead — every supported command is described exactly
once, every described flag is one the parser or the installer accepts, every flag
an invocation form shows as required is required in the catalog, and every
command assembled from the catalog with the GUI's own builder parses. A flag the
catalog forgets is a test failure, not a missing field in a window.

The GUI reads the catalog from the installed binary at start rather than
bundling a copy, so an `lz update` changes what the window offers without
rebuilding it; the document carries a schema version, bumped only when an older
GUI would misread it.

Two alternatives were rejected. Bundling the catalog into the GUI at build time
couples the window to the checkout it was built from, while it runs whatever
`lz` the PATH resolves. Parsing `lz --help` keeps one source but loses the value
kinds, the effects and the per-command flag sets a form needs, and turns
Spanish help prose into an interface.

Interrupting a run from the GUI sends SIGINT to the run's process group, the
same signal Ctrl-C delivers, so the CLI records the run as interrupted, cancels
a pending `--off` and names the checkpoint to reconcile (ADR-0029, ADR-0030);
only a second interrupt kills the group.
