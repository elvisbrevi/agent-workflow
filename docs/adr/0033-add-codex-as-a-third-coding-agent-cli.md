---
status: accepted
---

# Add Codex as a third coding agent CLI

`--cli` accepts `codex` alongside `opencode` and `claudecode`, and Codex is a
full peer of both: `plan`, `code` and the SAG-scoped workflows may run on it, it
may appear as a `--fallback` rung, it may receive or give up a cross-CLI handoff,
and the checkpoints record it as the session-owning CLI. ADR-0023 already made
the CLI a seam rather than a branch at every call site, so a third one is one
more adapter; a chain that can only descend between two providers still stops the
run when both are exhausted, which is the whole point of having a chain.

Codex is invoked as `codex exec --json`, whose JSONL stream carries the session
identifier on its own `thread.started` event as `thread_id`. That keeps ADR-0023's
rule intact: the identifier is read from the CLI's own stream rather than imposed
by the coordinator. Resuming is `codex exec resume <thread_id> <prompt>`, which
accepts the model and effort overrides a same-CLI fallback descent needs. Session
closure on the terminal marker is a no-op, as it is for Claude Code: a Codex
session is a local transcript with nothing to release, and deleting it would
destroy the only auditable trace of the run.

## Authority

Codex expresses ADR-0021's prohibitions natively. Its execpolicy rules are
Starlark files where `prefix_rule(pattern=["git", "push"], decision="forbidden")`
is the exact analogue of OpenCode's `"git push*": "deny"` and Claude Code's
`Bash(git push:*)`, evaluated by the provider before the command runs. So the
five profiles exist a third time, as `codex/<profile>.rules`, still written by
hand and still not generated from the other two formats.

They are injected through `CODEX_HOME`, because `codex exec` has no flag that
takes a rules path: execpolicy files are discovered only under the resolved Codex
home. Each run therefore gets a lazy-workflow-owned home containing its profile's
`rules/`, with the operator's `auth.json` and `skills/` linked in. Linking
`auth.json` keeps the run on the operator's existing login, exactly as OpenCode
and Claude Code already run, instead of forcing every run onto an API key.
Linking `skills/` is not a convenience: Codex loads skills from the Codex home,
and the planning workflow's own instructions name `/grill-with-docs` and
`/to-tickets`, so a hermetic home would silently remove the skills the prompt
depends on.

The operator's `config.toml` is deliberately not linked. It carries a default
model, a default effort, MCP servers and plugins that would vary the run by
machine, and lazy-workflow already states the model and the effort explicitly on
every invocation. The accepted cost is that MCP servers the operator configured
interactively are absent from a lazy-workflow session; the gain is that the run
depends on the profile, the flags and the login, and on nothing else in the home.

Sessions run with `-s danger-full-access --ask-for-approval never`, which is the
analogue of OpenCode's `--auto` and Claude Code's `bypassPermissions`: nothing
prompts, and the `forbidden` rules remain the entire enforcement surface. The
sandboxed alternative, `workspace-write`, was rejected because it disables
network access wholesale, which would break the `gh` reads the GitHub planning
profile deliberately allows — an authority decision made by a sandbox flag rather
than by the profile that is supposed to own it.

## Effort and exhaustion

`--variant` is Codex's reasoning effort, passed as
`-c model_reasoning_effort=<variant>`. Codex accepts `none`, `minimal`, `low`,
`medium`, `high`, `xhigh` and `max` — a superset of Claude Code's set — and all
seven are accepted, because narrowing them to the intersection would reject
efforts the provider supports in order to make chains look uniform. The effort
sets stay per CLI, as `variantRejection` already assumes, so a rung is validated
against the CLI that will actually execute it.

Provider exhaustion (ADR-0024) is classified from the typed reasons Codex puts on
its own failure events — `usage_limit_exceeded`, `rate_limit_exceeded`,
`session_budget_exceeded`, `unauthorized` — rather than from HTTP status codes as
OpenCode requires or from matched refusal text as Claude Code requires. Codex
reports token usage on `turn.completed` but no cost, which the agent result
already treats as optional.
