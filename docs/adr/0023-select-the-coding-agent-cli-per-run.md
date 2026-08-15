---
status: accepted
---

# Select the coding agent CLI per run

A lazy-workflow run declares which coding agent CLI executes its session with
`--cli opencode|claudecode`, defaulting to `opencode`. Every command that opens
a session — `plan`, `code`, and the SAG-scoped workflows — resolves the CLI once
and runs through a single coding agent seam, so a second CLI is one adapter
rather than a branch at every call site. The `ticket-*` and `hu-*` read and
mutation commands open no session and are unaffected.

The flag is `--cli`, not `--agent`, because this repository already spends the
word "agent" on the agent authority profile that OpenCode receives as
`--agent <profile>`. Two meanings for one word in the same invocation would make
every prompt, ADR, and help line ambiguous, and the cost of the clearer name is
one word the operator types.

Authority survives the second CLI because it is expressed per CLI rather than
translated at run time. Claude Code is invoked with `--settings` pointing at a
mirror of `opencode/authority.json` whose profiles carry the same prohibitions
as `permissions.deny` rules, and with `--permission-mode bypassPermissions`,
which is the exact analogue of OpenCode's `--auto`: prompts are skipped while
deny rules still block, because Claude Code evaluates deny before allow in every
mode. ADR-0021's reasoning is unchanged — a denied tool call cannot run, while
prompt prose is advice a model may ignore — and each CLI keeps its enforcement
in the format its own provider validates, so neither file is generated from the
other and neither can silently lose a rule in translation.

Claude Code sessions start without `--bare`. Bare mode would make startup
reproducible across machines, but it does not read OAuth credentials and would
force every run onto `ANTHROPIC_API_KEY`; the operator's existing subscription
login is how OpenCode already runs, and the target repository's `CLAUDE.md` is
context a delivery session should have.

The session identifier is read from the CLI's own stream — `system/init` for
Claude Code, as the JSONL result already does for OpenCode — rather than
imposed by the coordinator through `--session-id`. Imposing it would let the
checkpoint be written before the process starts, but it would also make the two
CLIs behave differently in the one place recovery depends on.

Because a session identifier alone does not say which binary produced it, the
delivery checkpoints carry the CLI that owns the session and their schema
version rises accordingly. A recovery whose `--cli` contradicts its checkpoint
fails closed rather than resuming against the wrong binary.

Terminal-marker session closure is a no-op for Claude Code. `opencode session
delete` releases server-side session state; Claude Code sessions are local
transcripts with nothing to release, and deleting them would destroy the only
auditable trace of what the run did.
