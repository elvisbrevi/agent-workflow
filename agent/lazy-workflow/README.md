# lazy-workflow

To install dependencies:

```bash
bun install
```

When installed globally by `install.sh --all-global` or
`install.sh --claude-global`, the installer prepares the locked Bun
dependencies in its managed cache. Use the `lazy-workflow` command directly:

```bash
lazy-workflow plan --prompt "plan the requested GitHub work" --working-directory /path/to/repository
lazy-workflow code --working-directory /path/to/repository
```

Every command has a runnable example in [Practical examples](#practical-examples);
the sections after it explain what each one does.

Every reported line is stamped with the local `dd/mm/yy HH:mm:ss` date and
time, and hangs from a gutter styled after the [Bagels](https://github.com/EnhancedJax/Bagels)
TUI, so a long run reads as one column. Events show their session ID, reasoning
summaries, tool status, and the artifact each tool touches — the file an edit is
writing among them. `--verbose-output` widens that to everything the agent
streams. The working directory is passed as the agent's real process directory,
so tools operate in the selected repository. Azure and agent retry messages are
printed when a transient failure causes a retry.

## Practical examples

Every use of lazy-workflow, one runnable command each. Inside this directory
`bun run main.ts <command>` and the globally installed `lazy-workflow <command>`
are interchangeable. Every command below also accepts the coding agent flags
(`--cli`, `--model`, `--variant`, `--fallback`) and the reporter flags
(`--verbose`, `--verbose-output`, `--quiet`, `--no-color`); the sections after
this one explain the behaviour behind each example. The deterministic tools take
the reporter flags only: they open no session.

### Planning

```bash
# Plan the GitHub backlog of one repository
lazy-workflow plan --prompt "plan the requested GitHub work" \
  --working-directory /path/to/repository

# Ask a different number of clarifying questions (default 5)
lazy-workflow plan --number-of-questions 8 --working-directory /path/to/repository

# Answer those questions yourself, in a browser page the run opens
lazy-workflow plan --interview http --working-directory /path/to/repository

# Same, answering in the terminal you launched the run from
lazy-workflow plan --interview terminal --working-directory /path/to/repository

# Same, answering through JSON files any other tool can write
lazy-workflow plan --interview file --interview-dir /tmp/entrevista \
  --working-directory /path/to/repository

# Plan against the SAG norms of the component declared in .sag/config.json
lazy-workflow plan --normas-sag --working-directory /path/to/repository

# Slice an Azure HU and publish its work items in dependency order
lazy-workflow plan --hu 23438 --working-directory /path/to/repository

# Plan one unit of work across several repositories in a single session
lazy-workflow plan --working-directory /path/to/repo-a,/path/to/repo-b
```

### Delivering

```bash
# Drain the eligible GitHub issues, each in its own fresh session
lazy-workflow code --working-directory /path/to/repository

# Same, with the SAG coding norms loaded
lazy-workflow code --normas-sag --working-directory /path/to/repository

# Drain the direct Task and Bug tickets of an Azure HU
lazy-workflow code --hu 23438 --working-directory /path/to/repository

# First delivery of an HU whose hu/<HU> branch does not exist yet
lazy-workflow code --hu 23438 --base-branch main \
  --working-directory /path/to/repository

# Deliver one Azure ticket across a multi-repository workspace
lazy-workflow code --hu 23438 --ticket 51 \
  --working-directory /path/to/repo-a,/path/to/repo-b
```

### Resuming an interrupted run

```bash
# The issue or HU, the ticket and the branch come from the checkpoint,
# so no --hu and no --working-directory are needed
lazy-workflow code --session <session-id> --prompt continue

# Resume the preserved session on a different model and effort
lazy-workflow code --session <session-id> \
  --model openai/gpt-5.6-luna --variant high --prompt continue

# Reconcile a delivery that already reached IMPLEMENTATION_READY: rerun the
# original command, which resumes the coordinator phase instead of selecting
# replacement work
lazy-workflow code --hu 23438 --working-directory /path/to/repository
```

### SAG-scoped workflows

```bash
# Architecture review: the only SAG workflow that opens a session
lazy-workflow architecture-review-sag --issue 154 --working-directory /path/to/repository
lazy-workflow architecture-review-sag --hu 23438 --working-directory /path/to/repository

# Infrastructure prerequisites, verified read-only through the adapter
lazy-workflow infra-sag --issue 155 --working-directory /path/to/repository
lazy-workflow infra-sag --hu 23438 --working-directory /path/to/repository

# Deploy through the adapter; dev is the default and PROD always fails closed
lazy-workflow deploy-sag --issue 157 --working-directory /path/to/repository
lazy-workflow deploy-sag --issue 157 --environment qa --working-directory /path/to/repository
```

### Azure reads — no session is opened

```bash
lazy-workflow hu-info --hu 23438
lazy-workflow hu-branch-info --hu 23438
lazy-workflow ticket-info --hu 23438 --ticket 23459
lazy-workflow ticket-description-info --ticket 23459
lazy-workflow ticket-state-info --ticket 23459
lazy-workflow ticket-effort-info --ticket 23459
lazy-workflow ticket-attachment-info --ticket 23459
lazy-workflow ticket-evidence-info --ticket 23459
lazy-workflow ticket-branch-info --hu 23438 --ticket 23459
lazy-workflow ticket-pr-info --hu 23438 --ticket 23459
lazy-workflow ticket-completion-info --hu 23438 --ticket 23459
```

### Azure writes — no session is opened

```bash
# Branch links
lazy-workflow hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --working-directory /path/to/repository
lazy-workflow hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --base-branch main --working-directory /path/to/repository
lazy-workflow ticket-branch-set --hu 23438 --ticket 23459 \
  --branch ticket/23459 --working-directory /path/to/repository

# Work items and their relations
lazy-workflow ticket-create --hu 23438 --type Task --title "Slice uno" \
  --description-file ./description.html --estimate 8 \
  --assignee persona@empresa.cl --field Custom.Componente=api
lazy-workflow ticket-link-parent --parent 23438 --child 23459
lazy-workflow ticket-link-predecessor --blocker 23459 --blocked 23460

# Ticket fields
lazy-workflow ticket-description-set --ticket 23459 --description-file ./description.html
lazy-workflow ticket-state-set --ticket 23459 --state "En progreso" --expected-state New
lazy-workflow ticket-effort-set --ticket 23459 \
  --real-effort 6 --real-effort-hh 6 --expected-rev 12

# Completion evidence
lazy-workflow ticket-pr-link --hu 23438 --ticket 23459 --pr 123
lazy-workflow ticket-commit-link --ticket 23459 --pr 123
lazy-workflow ticket-attachment-add --ticket 23459 --file evidence.json --kind http-json
lazy-workflow ticket-evidence-set --ticket 23459 --evidence-file completion.html
lazy-workflow ticket-completion-apply --hu 23438 --ticket 23459 --pr 123 \
  --manifest /path/to/completion.json
```

`--file` and `--kind` accept `--evidence-file` and `--evidence-kind` as aliases,
and `--field <referenceName>=<value>` is repeatable — Azure reference names are
never inferred from display labels.

The two mutations that move a ticket are optimistic: `ticket-state-set` requires
the `--expected-state` it will find and refuses a transition the board does not
allow, and `ticket-effort-set` requires the `--expected-rev` it was read at, so a
ticket that moved underneath you fails instead of being overwritten. `Done` is
never reachable from `ticket-state-set`: only the coordinator applies it, after
verifying every completion gate.

### Choosing the CLI, the model and the effort

```bash
# OpenCode is the default; naming it explicitly is equivalent
lazy-workflow code --working-directory /path/to/repository
lazy-workflow code --cli opencode --model opencode-go/deepseek-v4-pro --variant high \
  --working-directory /path/to/repository

# Claude Code with Sonnet 5 at high effort
lazy-workflow code --cli claudecode --model claude-sonnet-5 --variant high \
  --working-directory /path/to/repository

# The SAG workflows resolve a CLI the same way
lazy-workflow architecture-review-sag --issue 154 --cli claudecode \
  --model claude-sonnet-5 --variant high --working-directory /path/to/repository
```

### Surviving an exhausted account

```bash
# Claude Code on Sonnet 5, backed by the same model through GitHub Copilot
lazy-workflow code --working-directory /path/to/repository \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high

# Several rungs; declaration order is the descent order
lazy-workflow code --working-directory /path/to/repository \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high \
  --fallback opencode:opencode-go/deepseek-v4-pro:high \
  --fallback-wait 300 --fallback-wait-max 3600
```

The walkthrough of the first one is in
[Claude Code on Sonnet 5, backed by GitHub Copilot](#end-to-end-claude-code-on-sonnet-5-backed-by-github-copilot).

### Operator output

```bash
lazy-workflow code --working-directory /path/to/repository                  # info, warn, error
lazy-workflow code --verbose --working-directory /path/to/repository        # + reasoning and tool calls
lazy-workflow code --verbose-output --working-directory /path/to/repository # + every tool input, output and raw event
lazy-workflow code --quiet    --working-directory /path/to/repository       # errors only
lazy-workflow code --no-color --working-directory /path/to/repository       # ANSI stripped
lazy-workflow                                                               # full command help
```

## Deterministic tools as commands

Every operation the workflow performs against Azure Boards, GitHub or git
without opening a session is also a command of its own (ADR-0026). Each one
takes its arguments as flags, prints what its adapter answered as JSON, and
exits zero or one. They share the workflow's adapters, so a tool command
validates exactly as the workflow step it mirrors does.

```bash
# GitHub queue: what a code run would take, and why it would skip the rest
lazy-workflow github-auth-info --working-directory /path/to/repository
lazy-workflow github-repo-info --working-directory /path/to/repository
lazy-workflow github-issue-list --working-directory /path/to/repository
lazy-workflow github-issue-select --working-directory /path/to/repository
lazy-workflow github-issue-info --issue 201 --working-directory /path/to/repository
lazy-workflow github-issue-claim --issue 201 --working-directory /path/to/repository
lazy-workflow github-issue-release --issue 201 --working-directory /path/to/repository

# GitHub delivery: the branch, the manifest, the commit, the PR, the closure
lazy-workflow github-branch-prepare --issue 201 --working-directory /path/to/repository
lazy-workflow github-branch-checkout --branch issue/201 --base-branch main \
  --working-directory /path/to/repository
lazy-workflow github-branch-verify --branch issue/201 --base-branch main \
  --working-directory /path/to/repository
lazy-workflow github-manifest-info --manifest /path/to/github-completion-manifest.json \
  --working-directory /path/to/repository
lazy-workflow github-manifest-set --issue 201 --branch issue/201 \
  --manifest /path/to/github-completion-manifest.json --summary "Adds the thing" \
  --validation "bun test" --validation-result "198 pass" \
  --evidence docs/evidence/run.json --working-directory /path/to/repository
lazy-workflow github-commit-push --branch issue/201 --commit <sha> \
  --working-directory /path/to/repository
lazy-workflow github-pr-create --issue 201 --branch issue/201 --base-branch main \
  --commit <sha> --working-directory /path/to/repository
lazy-workflow github-pr-merge --pr 9 --issue 201 --branch issue/201 --base-branch main \
  --commit <sha> --working-directory /path/to/repository
lazy-workflow github-issue-close --issue 201 --pr 9 --commit <merge-sha> \
  --working-directory /path/to/repository
lazy-workflow github-branch-cleanup --branch issue/201 --base-branch main --commit <sha> \
  --working-directory /path/to/repository

# Azure operations the ticket-* commands did not yet expose
lazy-workflow hu-children-info --hu 23438
lazy-workflow hu-state-set --hu 23438 --state Done --expected-state "En progreso" --expected-rev 12
lazy-workflow hu-branch-ensure --hu 23438 --base-branch main --working-directory /path/to/repository
lazy-workflow ticket-type-info --ticket 23459
lazy-workflow ticket-pr-create --hu 23438 --ticket 23459
lazy-workflow ticket-branch-checkout --branch ticket/23459 --working-directory /path/to/repository
lazy-workflow ticket-branch-push --branch ticket/23459 --working-directory /path/to/repository
lazy-workflow ticket-manifest-set --ticket 23459 --branch ticket/23459 \
  --manifest /path/to/repository/.git/lazy-workflow/completion-manifest.json \
  --validation "bun test" --validation-result "198 pass" \
  --evidence http-json:/path/to/repository/.git/lazy-workflow/api.json \
  --working-directory /path/to/repository

# git
lazy-workflow git-branch-delete --branch ticket/23459 --base-branch hu/23438 \
  --commit <sha> --working-directory /path/to/repository
```

`--branch` and `--base-branch` accept the short name (`issue/201`) or the full
ref (`refs/heads/issue/201`). `--commit` requires the full object name, because
every tool that takes one compares it against a ref and an abbreviation would
fail that comparison as if the branch had moved. These commands open no session,
so `--cli`, `--model`, `--variant` and `--fallback` do not apply to them.

## Reporter and verbosity

The lazy-workflow Reporter is the typed abstraction that emits operator output.
Four global flags select its mode and propagate through every workflow:

```bash
lazy-workflow code --working-directory /path/to/repository                  # default (info, warn, error)
lazy-workflow code --verbose --working-directory /path/to/repository        # + debug
lazy-workflow code --verbose-output --working-directory /path/to/repository # + debug and trace
lazy-workflow code --quiet   --working-directory /path/to/repository        # error only
lazy-workflow code --no-color --working-directory /path/to/repository       # ANSI stripped
```

`--verbose` and `--quiet` are mutually exclusive. `--verbose-output` is strictly
wider than `--verbose` and turns it on, so it can never show less. `--no-color`
is independent and stacks with any verbosity. The Reporter keeps the existing
`operator-output` file module name as a compat shim, so `reportOperator(...)`
continues to route to `info` regardless of which verbosity flag is active.

### The parsed line

Every line carries the local date, hour, minute and second, then a gutter, then
the glyph of its level, and continuation lines hang from that same gutter. The
palette is Bagels' own default theme (tokyo-night), and a run opens with a
rounded panel naming what it is about to do:

```text
╭──────────────────────────────────────────────────────────╮
│ lazy-workflow · code                                     │
│ alcance    GitHub                                        │
│ agente     opencode · opencode-go/deepseek-v4-pro · high │
│ directorio /repo                                         │
│ salida     parseada                                      │
╰──────────────────────────────────────────────────────────╯
16/08/26 21:03:48 │ ● OpenCode iniciado en /repo
```

The glyphs are `●` info, `▲` warn, `✖` error, `·` debug and `⋮` trace.

A single `code` GitHub run against a delivery that includes one reasoning step,
three tool uses, and one terminal `IMPLEMENTATION_READY` text event produces a
different volume of operator output per mode. The blocks below show what each
flag emits, with ANSI stripped so the examples are copy-pasteable:

**Default** (`code --working-directory /repo`) — info + warn + error only,
5 to 15 lines for a typical ticket delivery:

```text
16/08/26 21:03:48 │ ● OpenCode iniciado en /repo
16/08/26 21:03:49 │ ● OpenCode [sesión ses_delivery] inició un paso
16/08/26 21:04:11 │ ● OpenCode [sesión ses_delivery] terminó un paso (stop)
16/08/26 21:04:11 │ ● OpenCode [sesión ses_delivery]: IMPLEMENTATION_READY
16/08/26 21:04:12 │ ● lazy-workflow: no quedan issues GitHub elegibles.
```

**Verbose** (`code --verbose --working-directory /repo`) — preserves the full
event stream; reasoning and tool calls surface as debug lines that the default
mode hides, each naming the artifact it touches:

```text
16/08/26 21:03:48 │ ● OpenCode iniciado en /repo
16/08/26 21:03:50 │ · OpenCode [sesión ses_delivery] razonando: Analizando cambios pendientes
16/08/26 21:03:52 │ · OpenCode [sesión ses_delivery] herramienta bash (completed): "git status --short"
16/08/26 21:03:55 │ · OpenCode [sesión ses_delivery] herramienta read (completed) en AGENTS.md
16/08/26 21:04:02 │ · OpenCode [sesión ses_delivery] herramienta edit (completed) en src/output/reporter.ts
16/08/26 21:04:11 │ ● OpenCode [sesión ses_delivery]: IMPLEMENTATION_READY
```

**Verbose output** (`code --verbose-output --working-directory /repo`) — adds
the whole input of every tool call, the output it returned, and the raw event
the agent emitted, so nothing the agent streamed is dropped:

```text
16/08/26 21:04:02 │ · OpenCode [sesión ses_delivery] herramienta edit (completed) en src/output/reporter.ts
16/08/26 21:04:02 │ ⋮ OpenCode [sesión ses_delivery] herramienta edit entrada: {"file_path":"src/output/reporter.ts","old_string":"…","new_string":"…"}
16/08/26 21:04:02 │ ⋮ OpenCode [sesión ses_delivery] herramienta edit salida: 1 archivo actualizado
16/08/26 21:04:02 │ ⋮ OpenCode evento crudo: {"type":"tool_use","sessionID":"ses_delivery",…}
```

Long values are shortened before they are printed, so a file rewrite is reported
as a call with its arguments rather than as the file echoed back to the terminal.

**Quiet** (`code --quiet --working-directory /repo`) — only error lines reach
the operator; info, warn, debug, trace and the run panel are silenced, and the
run is silent unless something fails:

```text
16/08/26 21:04:11 │ ✖ lazy-workflow: OpenCode terminó con error.
```

`--no-color` can be stacked on top of any of the modes above and strips ANSI
from every line, leaving the stamp, the gutter, the glyph and the message.

## Run log

Every command also appends to a run log: one JSON Lines file, so a metrics or
monitoring service can tail a run's start, its end, and every `warn`/`error`
between them without parsing operator prose (ADR-0029). It is a description of
a run, never a copy of it — a record carries no credential, no prompt text and
no diff content.

```bash
lazy-workflow code --working-directory /path/to/repository                        # writes to the default path
lazy-workflow code --log-file /path/to/runs.jsonl --working-directory /repo       # writes there instead
lazy-workflow code --no-log-file --working-directory /repo                        # disables the run log for this run
LAZY_WORKFLOW_LOG_FILE=/path/to/runs.jsonl lazy-workflow code --working-directory /repo
```

Where it writes resolves in this order: `--log-file <path>`, then
`LAZY_WORKFLOW_LOG_FILE`, then the default
`~/.local/state/lazy-workflow/runs.jsonl` — consistent with the
`~/.cache/agent-workflow` and `~/.local/bin` paths the installer already uses.
`--no-log-file` disables it outright and is rejected together with
`--log-file`. The file is capped at a fixed size and keeps exactly one previous
generation (`runs.jsonl.1`); reaching the cap renames the current file to
`.1`, replacing whichever generation was there, and starts a fresh one.

Every record is one JSON object per line:

```json
{"schema_version":1,"run_id":"…","ts":"2026-08-20T23:12:04.000Z","severity":"info","event":"run.started","command":"code","workflow":"code","provider":"github","cli":"claudecode","model":"claude-sonnet-5","variant":"high","context":{"issue":263,"ticket":null,"hu":null,"repository":"/path/to/repository","session_id":null,"branch":"issue/263"},"message":"lazy-workflow code iniciado"}
{"schema_version":1,"run_id":"…","ts":"2026-08-20T23:12:41.000Z","severity":"info","event":"run.finished","command":"code","workflow":"code","provider":"github","cli":"claudecode","model":"claude-sonnet-5","variant":"high","outcome":"success","exit_code":0,"duration_ms":37210,"context":{"issue":263,"ticket":null,"hu":null,"repository":"/path/to/repository","session_id":null,"branch":"issue/263"},"message":"lazy-workflow code finalizado (success)"}
```

The first line of a run is always a `run.started` record and the last is
always a `run.finished` one, carrying `outcome`, `exit_code` and `duration_ms`
— including when the run ends on a failure path that returns a non-zero code.
Every `warn` and `error` the Reporter emits in between appears as an `event`
record with the same `run_id`, regardless of `--quiet`: the run log is a
separate seam from the terminal stream, so silencing one never silences the
other.

The record shape splits into **labels** — flattened at the top level, the
low-cardinality axes a dashboard groups by: `schema_version`, `run_id`, `ts`,
`severity`, `event`, `command`, `workflow`, `provider`, `cli`, `model`,
`variant`, and — where they apply — `failure_kind`, `phase`, `checkpoint`,
`outcome`, `exit_code`, `duration_ms`, `session_event`, `reason`, `from_cli` —
and a nested **`context`** carrying the high-cardinality identifiers a single
run has: `issue`, `ticket`, `hu`, `repository`, `session_id`, `branch`,
`stop_reason`. The split is deliberate: a label is a dashboard axis, so it must
stay a small closed set, while an Issue number, a session id or a branch would
explode a time series into one series per issue ever worked, so those stay in
`context`. A failure that leaves durable work for reconciliation carries
`checkpoint: "preserved"`. `message` is the human line and is never what a
dashboard groups by.

`session_event` labels a coding-agent session's own lifecycle (issue #267) —
one rung of a run, not the whole run — from the closed vocabulary
`session_started`, `session_finished`, `session_failed`,
`terminal_marker_missing`, `provider_exhausted`, `fallback_descent`,
`chain_exhausted`, `chain_retry`, `session_close_failed`, `session_not_found`,
`cross_cli_handoff`. `reason` carries the closed exhaustion-cause vocabulary
(`rate_limit`, `billing`, `authentication`, `session_limit`) that explains a
`fallback_descent` or a `chain_exhausted`; it is a label because it is a small
closed set, unlike a finished session's own stop reason (a Claude Code
`result` subtype, an OpenCode `step_finish` reason), which is provider
vocabulary this repo does not bound and therefore travels as `context.stop_reason`
instead. `from_cli` appears only on a `cross_cli_handoff` record, naming the
CLI the work yielded from while `cli` names the one that adopted it.

### Failure kind

`failure_kind` is the closed vocabulary a failure or interruption is
classified into (ADR-0029), so the same failure is always the same value
instead of one a reader infers from prose. Every kind currently routes to
`error` — none is a `warn` — so `--quiet` never drops a failure line:

| `failure_kind` | Severity |
| --- | --- |
| `tracker-read-failure` | error |
| `claim-verification-failure` | error |
| `branch-preparation-failure` | error |
| `session-failure` | error |
| `manifest-not-verifiable` | error |
| `delivery-failure` | error |
| `pull-request-failure` | error |
| `reconciliation-required` | error |
| `parent-reconciliation-failure` | error |
| `deterministic-completion-failure` | error |
| `checkpoint-unreadable` | error |
| `lock-unavailable` | error |
| `argument-error` | error |
| `evidence-not-verifiable` | error |
| `manifest-mismatch` | error |
| `hu-transition-failure` | error |
| `ticket-branch-cleanup-failure` | error |
| `workspace-scope-failure` | error |
| `topology-preparation-failure` | error |
| `deployment-authentication-required` | error |
| `infrastructure-authentication-required` | error |
| `run-interrupted-signal` | error |
| `run-interrupted-failure` | error |

`run-interrupted-signal` and `run-interrupted-failure` are reserved for the
`run.finished` record a signal or an unhandled exception/rejection produces
(see the worked example below); every other kind can appear on either an
`event` record mid-run or on the `run.finished` record that ends the run on
that failure. This table is pinned by a test (`test/run-log.test.ts`): adding,
renaming or removing a kind — or moving one off `error` — fails the suite
until `RUN_LOG_SCHEMA_VERSION` is bumped and this table is updated to match.

### Worked example: a failed `code` run, interrupted

A `code` run that hits a session failure and is then interrupted with
Ctrl-C leaves three records under the same `run_id` — the failure is recorded
where it happened, and the interruption is recorded separately from it:

```json
{"schema_version":1,"run_id":"r-1","ts":"2026-08-20T23:12:04.000Z","severity":"info","event":"run.started","command":"code","workflow":"code","provider":"github","cli":"claudecode","model":"claude-sonnet-5","variant":"high","context":{"issue":268,"ticket":null,"hu":null,"repository":"/path/to/repository","session_id":null,"branch":"issue/268"},"message":"lazy-workflow code iniciado"}
{"schema_version":1,"run_id":"r-1","ts":"2026-08-20T23:12:31.000Z","severity":"error","event":"event","command":"code","workflow":"code","provider":"github","cli":"claudecode","model":"claude-sonnet-5","variant":"high","failure_kind":"session-failure","phase":"implementing","context":{"issue":268,"ticket":null,"hu":null,"repository":"/path/to/repository","session_id":"ses_1","branch":"issue/268"},"message":"no se pudo completar la sesion; ejecucion detenida"}
{"schema_version":1,"run_id":"r-1","ts":"2026-08-20T23:12:47.000Z","severity":"error","event":"run.finished","command":"code","workflow":"code","provider":"github","cli":"claudecode","model":"claude-sonnet-5","variant":"high","outcome":"interrupted","failure_kind":"run-interrupted-signal","checkpoint":"preserved","duration_ms":43210,"context":{"issue":268,"ticket":null,"hu":null,"repository":"/path/to/repository","session_id":"ses_1","branch":"issue/268"},"message":"lazy-workflow interrumpido por SIGINT (checkpoint conservado: manifest)"}
```

The first line is always `run.started`; the last is always `run.finished`,
even on this path — a signal or an unhandled failure above every catch is
caught by handlers installed for the life of the run, which write this final
record and then let the default behavior proceed (ADR-0029), so a preserved
checkpoint is never the only evidence a run stopped.

Writing is best-effort and isolated from the run it describes: a full disk, a
read-only home, or a path that cannot be created emits one `warn` and disables
the run log for the remainder of the run. No exit code, checkpoint, terminal
protocol marker or stdout JSON payload is ever affected by a run log failure —
a run with a broken sink behaves exactly like one started with
`--no-log-file`.

### Scraping it

The run log is a plain newline-delimited JSON file, so any NDJSON-capable
collector — Promtail, Grafana Alloy, Vector, Filebeat — tails it with no
parser and no schema to register beyond what is documented above. A Loki/Grafana
stack via Promtail needs only a scrape config pointed at the file, extracting
the labels a dashboard groups by and leaving `context` and `message` in the
log line:

```yaml
# promtail-config.yaml
scrape_configs:
  - job_name: lazy-workflow
    static_configs:
      - targets: [localhost]
        labels:
          job: lazy-workflow
          __path__: /home/*/.local/state/lazy-workflow/runs.jsonl
    pipeline_stages:
      - json:
          expressions:
            severity: severity
            event: event
            command: command
            workflow: workflow
            provider: provider
            cli: cli
            model: model
            variant: variant
            failure_kind: failure_kind
            outcome: outcome
            session_event: session_event
            reason: reason
      - labels:
          severity:
          event:
          command:
          workflow:
          provider:
          cli:
          model:
          variant:
          failure_kind:
          outcome:
          session_event:
          reason:
      - timestamp:
          source: ts
          format: RFC3339
```

The equivalent Alloy config replaces the two stanzas above with
`loki.source.file` reading the path and `loki.process` running the same
`stage.json` / `stage.labels` / `stage.timestamp` steps, then forwards to
`loki.write`. Either way the file is the integration: no exporter, no agent
running inside `lazy-workflow`, and no new runtime dependency.

## Default GitHub workflows

Without `--hu`, `plan` and `code` run in GitHub-only scope, each receiving the
GitHub scope fragment plus its own workflow's instructions:

```bash
bun run main.ts plan --prompt "plan the requested change" \
  --working-directory /path/to/repository
bun run main.ts plan --normas-sag --working-directory /path/to/repository
bun run main.ts code --working-directory /path/to/repository
```

The default prompt follows the target repository's tracker and delivery
documentation, uses GitHub and `gh`, and forbids Azure DevOps and `az` tools.
These runs do not read Azure, inspect the HU checkpoint, prepare integration
branches, enforce Azure completion gates, or clean Azure ticket branches.
`--branch` and `--base-branch` are rejected in this GitHub scope.

`plan` remains a planning-only workflow, one-shot unless `--interview` asks it to
stop and consult the operator (see [Planning interview](#planning-interview)). `code` refreshes GitHub,
delivers each eligible issue in its own fresh OpenCode session, and coordinates
delivery from `IMPLEMENTATION_READY` through verified merge, issue closure,
parent reconciliation, and branch cleanup. After each verified delivery it
re-selects the next eligible issue in the same run until the queue is empty or
blocked. The coordinator emits
`TICKET_COMPLETED` followed by `WORKFLOW_STEP_FINISHED` only after those gates
pass; the provider cannot declare delivery or queue outcomes. A repository-
scoped GitHub checkpoint and lock preserve a fixed interrupted issue; startup
resumes an active session or reconciles a post-readiness delivery without
selecting replacement work.

GitHub recovery validates the repository and acquires its lock before switching
to the exact local branch recorded by the checkpoint. A dirty worktree, active
Git operation, missing branch, or branch unavailable to the current worktree
stops recovery before OpenCode or queue access. Recovery never creates, guesses,
resets, or force-switches a branch.

When GitHub reports a canonical PR as conflicting with its base, the
coordinator fetches and fixes the exact base commit, then starts a conflict-only
OpenCode session for the same Issue, branch, PR and repository. Delivery
continues only after the new manifest is clean and its commit contains both the
original implementation and fixed base commits. Interrupted reconciliation is
checkpointed and resumes without selecting another Issue; this applies to
single-repository and workspace delivery.

`plan --normas-sag` and `code --normas-sag` are opt-in. They read the canonical SAG `master` branch and
requires `.sag/config.json` with an explicit `tipo` of `api`, `bff`, or
`nextjs`; it never infers the component from source layout. OpenCode receives
the resolved commit, stable normative rule IDs, source URLs, selection reasons,
and explicit `needsDecision` values for unknown applicability. An unavailable
source or invalid configuration stops before OpenCode. Coding selects common
and component rules plus families supported by explicit artifacts and
capabilities. Plain `plan` and `code` do not access SAG sources. If the
canonical source requires authentication, provide
`AZURE_DEVOPS_EXT_PAT`; its value is used only in the request Authorization
header and is never persisted or sent to OpenCode.

`architecture-review-sag` always loads the canonical SAG `master` branch and
requires exactly one explicit `--issue` or `--hu` plus `.sag/config.json`. It
reviews architecture without changing the reviewed code. Numbered norms stay
separate from procedural guidance; findings are synthesized and published as
corrective tracker work with `/to-spec` and `/to-tickets` semantics. A clean
review publishes nothing, and the command never deploys or requires another
SAG workflow.

`deploy-sag` always loads delivery norms and requires exactly one explicit
`--issue` or `--hu`. It reads the explicit `deployment` route in
`.sag/config.json`, asks an authenticated external adapter to verify one
pipeline v7, Release Definition, repository/base branch, and the selected
DEV, TEST, or QA target, then verifies the external deployment state. DEV is
the default. PROD and every production alias fail before external mutation;
ambiguous or unverifiable routes fail closed. Repeated runs reconcile by
environment, route, and scope identity rather than triggering a duplicate.

`infra-sag` always loads infrastructure norms and requires exactly one explicit
`--issue` or `--hu`. It verifies repository identity/base branch, Consul
configuration, and explicitly declared database, pipeline, and Release
Definition prerequisites through a read-only authenticated adapter and records
the versioned config/Consul contracts used. Missing or
unverifiable checks are published as corrective work, and the command never
provisions infrastructure.

The deployment configuration has this shape (identities are examples, not
inferred defaults):

```json
{
  "tipo": "api",
  "deployment": {
    "authentication": "operator",
    "adapter": { "command": [".sag/deploy-adapter"] },
    "route": {
      "repository": "project/repository",
      "baseBranch": "main",
      "pipeline": { "id": "pipeline-7", "version": "v7" },
      "releaseDefinition": { "id": "release-1" },
      "openShift": { "id": "openshift-dev", "evidence": "authoritative-openshift-evidence" },
      "consul": { "deployKey": "project/deploy", "requiredVariables": ["DATABASE_URL"], "evidence": "authoritative-consul-evidence" },
      "target": { "id": "openshift-dev", "environment": "dev", "evidence": "authoritative-target-evidence" }
    }
  }
}
```

The adapter is executed without a shell and receives JSON on stdin with
`--operation discover|reconcile|verify`. It must use operator authentication,
return exactly one route for `discover`, atomically reconcile the idempotency
key, and return independently verified OpenShift, Consul, and target evidence.
Authentication continuation is signaled with exit code 0 and
`{"authenticationRequired":true}`; nonzero exits are terminal adapter errors.

## Azure HU workflows

Before a fresh `code` run selects a ticket or writes a checkpoint, the
coordinator queries the HU's native Branch link. It reuses a valid linked
branch, or verifies/creates `hu/<HU>` in the selected repository. Creating a
missing branch requires the structured `--base-branch <name>` option; the
operator prompt is never parsed for branch selection.

To plan an Azure HU:

```bash
bun run main.ts plan --hu 23438 --working-directory /path/to/repository
```

Planning uses the English autoplan prompt and never implements code. Missing or
unsupported subcommands print help and do not call Azure Boards or OpenCode.
With `--interview` the session stops to put its open decisions to the operator
before it returns the plan; publication is unchanged either way.

The session decides how to slice the User Story and returns a delivery plan
behind a `PLAN_READY` marker; it creates no Azure work items. The coordinator
validates the whole plan first — duplicate titles, unknown blockers, and
blocking cycles are rejected before anything is created — then publishes the
work items in dependency order and records the blocking relations in a second
pass, when it can name real ids. Publication is idempotent, so rerunning a plan
reuses its work items instead of duplicating them, and an empty plan publishes
nothing. The same primitives are available directly:

```bash
bun run main.ts ticket-create --hu 23438 --type Task --title "Slice uno" \
  --description-file ./description.html --estimate 8
bun run main.ts ticket-link-parent --parent 23438 --child 23459
bun run main.ts ticket-link-predecessor --blocker 23459 --blocked 23460
```

Beyond the system fields, name any field explicitly with
`--field <referenceName>=<value>`; reference names are never inferred from
display labels.

To obtain the information of a HU:

```bash
bun run main.ts hu-info --hu 23438
```

To query the HU integration branch without starting OpenCode or changing Git
or Azure:

```bash
bun run main.ts hu-branch-info --hu 23438
```

The command prints one indented JSON object with the HU number and either the
normalized native Azure Git branch (`refs/heads/...`) or `null` when no Branch
ArtifactLink exists. Malformed or multiple distinct Branch links fail with a
nonzero status; the command never proposes `hu/<HU>`.

To inspect one Azure delivery ticket without starting OpenCode:

```bash
bun run main.ts ticket-info --hu 23438 --ticket 23459
bun run main.ts ticket-description-info --ticket 23459
bun run main.ts ticket-state-info --ticket 23459
bun run main.ts ticket-effort-info --ticket 23459
bun run main.ts ticket-attachment-info --ticket 23459
bun run main.ts ticket-evidence-info --ticket 23459
bun run main.ts ticket-description-set --ticket 23459 --description-file ./description.html
bun run main.ts ticket-state-set --ticket 23459 --state "En progreso" --expected-state New
bun run main.ts ticket-effort-set --ticket 23459 --real-effort 6 --real-effort-hh 6 --expected-rev 12
bun run main.ts ticket-completion-apply --hu 23438 --ticket 23459 --pr 123 --manifest /path/to/completion.json
bun run main.ts ticket-pr-link --hu 23438 --ticket 23459 --pr 123
bun run main.ts ticket-commit-link --ticket 23459 --pr 123
bun run main.ts ticket-attachment-add --ticket 23459 --file evidence.json --kind http-json
bun run main.ts ticket-evidence-set --ticket 23459 --evidence-file completion.html
bun run main.ts ticket-branch-info --hu 23438 --ticket 23459
bun run main.ts ticket-branch-set --hu 23438 --ticket 23459 \
  --branch ticket/23459 --working-directory /path/to/repository
bun run main.ts ticket-pr-info --hu 23438 --ticket 23459
bun run main.ts ticket-completion-info --hu 23438 --ticket 23459
```

`ticket-state-set` and `ticket-effort-set` are optimistic writes: the first
requires the `--expected-state` it will find and refuses a transition the board
does not allow, the second requires the `--expected-rev` the ticket was read at.
`Done` is not reachable from `ticket-state-set` — only the coordinator applies
it, after verifying every completion gate.

Each command emits one normalized JSON object. The aggregate response includes
the direct ticket identity, description, state, revision, effort, ticket and
HU branches, pull-request candidates, canonical association, merge commit,
attachments, completion evidence, and all satisfied or unmet completion gates.
Azure CLI reads are attempted first; unsupported or broken read routes use the
authenticated Azure DevOps REST boundary.

To assign an already existing remote branch to an HU, omit `--base-branch`:

```bash
bun run main.ts hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --working-directory /path/to/repository
```

The command normalizes the branch, reads the HU project and the selected
worktree's Azure `origin`, verifies the exact remote ref, and creates the native
Branch ArtifactLink with the resolved project and repository IDs. The same
link is idempotent; a different or ambiguous link fails without replacing it.
Azure is reread before success, the result is one indented JSON object, and
OpenCode is never started.

To create the HU branch on first use, provide an explicit remote base:

```bash
bun run main.ts hu-branch-set --hu 23438 --branch feature/hu-23438 \
  --base-branch main --working-directory /path/to/repository
```

When the desired branch is absent, the command requires `--base-branch`,
creates it from that exact remote commit, publishes it, verifies the remote
ref, and only then creates the Azure link. It does not reset, clean, checkout,
or discard worktree changes; a dirty worktree fails closed.

To drain the HU's direct Task and Bug delivery tickets one at a time:

```bash
bun run main.ts code --hu 23438 --base-branch main \
  --working-directory /path/to/repository
```

Omit `--base-branch` when the HU is already linked or the expected remote
`hu/23438` branch already exists. A branch preflight failure stops once,
without selecting a ticket, writing a checkpoint, or starting OpenCode.

The session produces that manifest with `ticket-manifest-set`, never by writing
the JSON itself: the tool resolves the commit, computes every evidence digest and
validates the result with the coordinator's own code, so the shape is not
something a session has to reproduce from a description.

After `IMPLEMENTATION_READY`, the coordinator closes OpenCode, validates the
manifest from Git common metadata, creates or reuses exactly one HU-targeted
pull request, publishes effort and evidence through typed idempotent commands,
verifies every completion gate, and only then moves the ticket to `Done`.
An already absent session is safe; any other closure failure stops the run with
the pinned ticket in a sessionless checkpoint. A later invocation resumes the
coordinator phase without asking OpenCode to repair Azure metadata, switches to
the updated HU integration branch, deletes the completed ticket branch locally
and remotely, clears the checkpoint, and refreshes Azure before starting the
next eligible ticket. Branch cleanup stops safely when the working tree
contains uncommitted or untracked changes.

To recover an interrupted ticket, use the opaque session identifier printed by
OpenCode. The HU and ticket are restored from the repository checkpoint, so no
`--hu` argument is needed:

```bash
bun run main.ts code --session <session-id> --prompt continue
```

The same recovery path can continue the preserved GitHub or Azure session with
an explicitly selected model:

```bash
bun run main.ts code --session <session-id> \
  --model openai/gpt-5.6-luna --variant high --prompt continue
```

Only explicitly supplied `--model` and `--variant` values override the existing
session. Omitted values remain unchanged. This does not recover a session
removed with `opencode session delete`.

Recovery and sessionless reconciliation first reacquire the HU's native Branch
link through the deterministic branch service, then rebuild the pinned ticket
context. A recovered ticket already in `Done` is verified and reconciled before
OpenCode can be resumed. If the recorded provider session no longer exists,
the checkpoint becomes sessionless and stops without an infinite retry loop.
A missing, malformed, conflicting, or otherwise invalid branch state stops once
with an actionable error; the checkpoint, OpenCode session, and ticket branch
remain untouched. Correct the reported branch state and rerun the same command
to preserve the checkpoint's ticket identity.

The deterministic ownership contract for Azure/Git ticket effects is specified in
[`docs/agents/deterministic-ticket-operations.md`](../../docs/agents/deterministic-ticket-operations.md).

The complete command help is available with an unsupported subcommand or no
subcommand. `--model`, `--variant`, `--prompt`, and `--working-directory` are
forwarded to OpenCode; `--number-of-questions` applies to `plan`. Supplying an
invalid `--hu` fails instead of falling back to GitHub.

Autocode stores a versioned checkpoint in repository Git metadata. It records
the phase, immutable HU/ticket/branch identities, Azure revision, effort
baseline, active duration, opaque OpenCode session, manifest path, pull request,
and verified effect receipts. Legacy four-field checkpoints migrate
conservatively to `implementing`. Failed or incomplete attempts retry the same
ticket every ten seconds; `IMPLEMENTATION_READY` replaces the session with
`null`, and the checkpoint is removed only after live completion verification.

If sessionless reconciliation finds incomplete Azure completion gates, it
prints the pinned ticket followed by stable reasons such as
`pinned-ticket-context`, `ticket-state`, `completion-evidence`, `real-effort`, `real-effort-hours`,
`commit-url`, `attached-capture`, `hu-integration-branch`,
`completed-hu-targeted-pr`, `native-pr-association`, or
`merge-commit-artifact-link`. The checkpoint remains intact: no OpenCode
session, branch cleanup, or later ticket is selected. Correct the reported
Azure data and rerun the same `code` command to reconcile safely; Azure
command or authentication failures remain operational errors and are not
reported as completion gates.

If OpenCode requests `az login`, lazy-workflow keeps the OpenCode session,
prints `az login --use-device-code`, waits until the HU is accessible again,
and resumes that session once with `continue`.

## Multi-repository workspaces

`plan` and `code` accept a comma-separated `--working-directory` list to plan or
deliver one unit of work across several repositories in a single OpenCode
session:

```bash
bun run main.ts plan --working-directory /path/to/repo-a,/path/to/repo-b
bun run main.ts plan --hu 23438 --working-directory /path/to/repo-a,/path/to/repo-b
bun run main.ts code --working-directory /path/to/repo-a,/path/to/repo-b
bun run main.ts code --hu 23438 --ticket 51 \
  --working-directory /path/to/repo-a,/path/to/repo-b
```

`plan` only inspects the declared repositories: it prepares no branches, writes
no workspace state, and mutates no tracker item, with or without `--hu`.

**Scope.** Each entry must be the root of a Git repository with an `origin`
remote and a clean worktree. Entries are canonicalised, duplicates are
rejected, and the declared order is the delivery order. All repositories must
belong to the same provider: GitHub for the default scope, Azure DevOps when
`--hu` is given (`code` also requires `--ticket`). A single path keeps the existing
single-repository behavior unchanged — no workspace state is created and no
aggregate checkpoint is read or written.

**Workspace state.** The coordinator resolves a common parent directory of the
declared repositories and keeps aggregate state in `<parent>/.lazy-workflow/`,
outside every source repository. It holds the aggregate checkpoint
(`github-workspace-code-checkpoint.json` or
`azure-workspace-code-checkpoint.json`) and, for GitHub, the delivery manifest.
Per-repository completion manifests stay inside each repository's Git common
directory.

**Serial execution.** One OpenCode session works across the whole workspace.
After `IMPLEMENTATION_READY` the coordinator verifies every per-repository
manifest, then delivers the changed repositories one at a time in the declared
order: push, create or reuse the pull request against that repository's own
base or HU integration branch, associate it with the Issue or ticket, and
merge. Repositories without changes must end clean; their temporary branches
are deleted safely. The Issue is closed — or the Azure ticket completed and the
HU moved from `En Desarrollo` to `Desarrollo Terminado` — only after every
required repository unit and every tracker gate is verified. GitHub parent
reconciliation and the Azure HU transition never run on a partial delivery.

**Azure primary repository.** A ticket carries exactly one native Branch
ArtifactLink. The coordinator prepares the ticket branch in every participant
repository but writes that link only after the session finishes, to the first
repository in declared order that produced a completion manifest. That primary
repository need not be the HU's anchor; its pull request and merge commit are
where the ticket's completion gates are read, and the other changed
repositories stay correlated through their own native PR and merge-commit
associations. The choice is recorded in the checkpoint so recovery reuses it.

**Recovery.** Rerun the same command to resume an interrupted workspace run.
Recovery requires the exact same normalized repository list, in the same
declared order, with the same remote identities, and — for Azure — the same HU
and ticket. An added, removed, reordered or remote-changed repository stops the
run before any external effect and leaves the checkpoint untouched. A pull
request that was already created, associated and merged is reused through its
recorded receipt rather than created twice; a failure in one repository leaves
the later ones pending and preserves the aggregate checkpoint. Nothing is
rolled back or reverted after a partial merge — fix the cause and rerun.
`--session <id>` must match the session stored in the checkpoint.

## Coding agent CLI

Every workflow command — `plan`, `code`, and the three SAG-scoped ones — resolves
one coding agent CLI per run with `--cli`, and every session it opens runs
through that one. The default is `opencode`; omitting the flag behaves exactly as
before.

```bash
lazy-workflow plan --cli claudecode --model claude-opus-5 --variant high \
  --working-directory /path/to/repository
```

`--model` is the model of the selected CLI, and `--variant` is its effort level:
Claude Code accepts `low`, `medium`, `high`, `xhigh`, and `max`, and rejects any
other value before opening the session. When you name a `--cli`, its binary —
`opencode` or `claude` — is verified while the arguments are parsed, so a
missing installation is reported before a session starts.

Claude Code sessions run non-interactively with its JSON event stream, take the
session identifier from the CLI's own initialization event, and never use
`--bare`, so the operator's login and the target repository's `CLAUDE.md` stay
available. Its events reach the Reporter with the same severities as OpenCode's:
assistant text as info, reasoning and tool calls as debug.

The three SAG-scoped workflows accept `--cli` too, and each keeps its own rules
whichever CLI runs it:

```bash
lazy-workflow architecture-review-sag --issue 154 --cli claudecode \
  --working-directory /path/to/repository
lazy-workflow deploy-sag --issue 157 --environment qa --cli claudecode \
  --working-directory /path/to/repository
```

`architecture-review-sag` is the one that opens a session: it runs with the
`lazy-review` authority in the format of its own CLI, so it cannot modify the
reviewed tree in either. `infra-sag` and `deploy-sag` verify and deploy through
their own adapters without opening a session, so `--cli` only names the CLI their
run resolves — and `deploy-sag` refuses PROD and its aliases before any external
effect whichever CLI that is.

Delivery records the owning CLI in its checkpoint, so `--session <id>` resumes
against the CLI that opened the session, and a `--cli` that contradicts the
checkpoint fails closed with the checkpoint preserved, naming the CLI that owns
it so you can resume with that one or drop `--cli`. The exception is a
contradiction the run itself created: when a cross-CLI handoff moved a GitHub
delivery off the `--cli` you declared, relaunching the same command resumes the
work on the CLI holding it instead of failing closed, and the unit after it
starts on your declared CLI again.

## Fallback chain

A run may declare an ordered chain of backup rungs with a repeatable
`--fallback <cli>:<model>:<variant>`. Its primary rung is the run's own `--cli`,
`--model`, and `--variant`, and the order you declare the backups in is the
order they are used:

```bash
lazy-workflow code --working-directory /path/to/repository \
  --model opencode-go/deepseek-v4-pro --variant high \
  --fallback opencode:openai/gpt-5.6-luna:high \
  --fallback claudecode:claude-opus-5:high
```

Every rung's binary is verified while the arguments are parsed, so a typo or a
missing installation is reported before the primary spends any usage, and the
resolved chain is reported at start-up so you know what the run will end on.

The chain descends only on **provider exhaustion** — usage or rate limit, quota,
billing, or authentication — as each CLI's own adapter classifies it. A session
that merely fails its task never descends (ADR-0024). Each descent is reported
with the rung it left, the rung it moved to, and the cause.

A backup that shares the active CLI resumes the same session with the new model
and variant, so the context already built survives. A backup naming another CLI
has no session to resume: the work continues through a **handoff**, a fresh
session in the new CLI that receives the coordinator's own prompt for the same
fixed unit of work — same issue, branch, manifest path, marker contract, and
authority profile in the new CLI's format — plus a progress section built from
verified state: checkpoint phase, branch, last commit, uncommitted worktree, and
the manifest if it exists. Nothing the exhausted session said travels with it
(ADR-0025). The checkpoint records the new CLI and the new session identifier in
a single write, so recovery resumes against the CLI that actually holds the work.

The descent is sticky for the unit of work in progress and no further: the next
issue in the managed queue starts again at the primary rung, so the run returns
to your preferred model as soon as its quota renews.

### When the whole chain is exhausted

With every rung exhausted for the unit in progress, the run waits at a fixed
interval and retries the chain from its primary rung, up to a total bound:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--fallback-wait <seconds>` | `300` | Interval between retries of the primary rung. |
| `--fallback-wait-max <seconds>` | `3600` | Total bound of the wait-and-retry cycle, from the first wait. |

The bound is wall-clock time from the first wait, so it covers the retries as
well as the waits: it is how long the run may spend trying to outlast the
limit, not a count of intervals. Each wait is reported with the exhausted rung,
its cause, and the time left until the bound; the last one is skipped when what
remains no longer covers a full interval. A bound smaller than one interval is
an argument error, since it could never retry anything. When the bound is spent the run fails closed:
the message names the last rung attempted and its cause, and the checkpoint is
left intact, so `--session <id>` resumes exactly where the work stopped.

### End to end: an OpenCode run that finishes the issue in Claude Code

```bash
lazy-workflow code --working-directory /path/to/repository \
  --model opencode-go/deepseek-v4-pro --variant high \
  --fallback claudecode:claude-opus-5:high \
  --fallback-wait 300 --fallback-wait-max 3600
```

1. The chain is reported: rung 1/2 `opencode`, rung 2/2 `claudecode`.
2. The run selects and claims an issue, prepares its branch and manifest path,
   and starts an OpenCode session on the primary rung.
3. Mid-implementation the OpenCode account hits its usage limit. The adapter
   classifies it as exhaustion, and the descent is reported: `escalón
   opencode:opencode-go/deepseek-v4-pro:high agotado (rate_limit); desciendo a
   claudecode:claude-opus-5:high traspasando el trabajo a una sesión nueva`.
4. Claude Code has no session to resume, so a fresh one starts with the same
   delivery prompt for the same issue, branch, and manifest, plus the progress
   already on disk — phase `implementing`, the branch, the last commit, the
   uncommitted worktree, the manifest if written. The checkpoint now names
   `claudecode` and the new session identifier.
5. Claude Code finishes the implementation and emits `IMPLEMENTATION_READY`; the
   coordinator completes the delivery deterministically as always.
6. The next issue in the queue starts again on OpenCode, the primary rung.

Had Claude Code been exhausted too, the run would have waited 300s, reported
`quedan 3600s hasta el tope`, and retried from OpenCode — and, after 3600s of
waiting without a rung recovering, failed closed with the checkpoint preserved.

### End to end: Claude Code on Sonnet 5, backed by GitHub Copilot

The same model can be reached through two different accounts. Running Sonnet 5
at high effort on a Claude Code subscription, with the identical model billed to
a GitHub Copilot seat as the backup, means the run keeps its model when the
first account hits its limit and only changes which account pays for it:

```bash
lazy-workflow code --working-directory /path/to/repository \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high
```

1. Both binaries are verified while the arguments are parsed — `claude` for the
   primary rung, `opencode` for the backup — and the chain is reported: rung 1/2
   `claudecode` with `claude-sonnet-5`, rung 2/2 `opencode` with
   `github-copilot/claude-sonnet-5`.
2. The run claims an issue and implements it in a Claude Code session at `high`
   effort.
3. The Claude subscription hits its usage limit. Claude Code's adapter
   classifies the exhaustion from its own event stream, and the descent is
   reported with the rung left, the rung taken, and the cause.
4. The backup names a different CLI, so there is no session to resume: a fresh
   OpenCode session starts on the Copilot-provided Sonnet 5 with the same
   delivery prompt for the same issue, branch and manifest path, the equivalent
   authority profile in OpenCode's format, and the progress already verified on
   disk. The checkpoint is rewritten to `opencode` and the new session id, so
   `--session <id>` later resumes against the CLI that actually holds the work.
5. The next issue in the queue starts again on Claude Code, the primary rung, so
   the run returns to the subscription as soon as its quota renews.

Both rungs run at `high` because the variant is per rung: `high` is a Claude Code
effort level on the primary and the OpenCode variant on the backup. Write each
rung's model id exactly as its own CLI exposes it — `claude-sonnet-5` for Claude
Code, and the `<provider>/<model>` id OpenCode lists for the Copilot-backed one,
which is why the backup rung carries the `github-copilot/` prefix and the primary
does not.

## Planning interview

A planning run answers its own clarifying questions by default: it takes the
recommendation it would have offered and continues, which is what an unattended
run needs. With `--interview <channel>` those decisions become yours. The session
states the questions it cannot settle alone, stops, and the coordinator carries
them to you; your answers resume that same session, until the plan is final
(ADR-0027).

```bash
lazy-workflow plan --interview http --working-directory /path/to/repository
lazy-workflow plan --hu 23438 --interview terminal --working-directory /path/to/repository
lazy-workflow plan --interview file --interview-dir /tmp/entrevista \
  --working-directory /path/to/repository
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interview <off\|http\|terminal\|file>` | `off` | The channel you answer through. `off` is the historical run. |
| `--interview-timeout <seconds>` | `900` | Deadline per round; once spent, the session's own recommendations are taken and the run continues. |
| `--interview-rounds <n>` | `8` | Bound on round trips. The last round is told to deliver the plan; one that asks again stops the run. |
| `--interview-host <host>` | `127.0.0.1` | `http` only. |
| `--interview-port <n>` | `0` (ephemeral) | `http` only, so two runs never collide. |
| `--interview-dir <path>` | — | `file` only, and required for it. |

`--number-of-questions` is unchanged: it is the budget for the whole interview,
which the session spends across as many rounds as it needs. `--interview` only
changes who answers them.

The three channels:

- **`http`** serves a page on loopback and prints its URL. The page shows the
  round with each recommendation prefilled, so submitting it unchanged is the
  same as not answering. The URL carries a per-run token and is the only
  credential; a host outside loopback is allowed and reported as the exposure it
  is. Answer from a browser, or with `curl` against `<url>/round` and
  `<url>/answers`.
- **`terminal`** asks in the terminal you launched the run from, reading
  `/dev/tty` so it still works when the JSON result is piped somewhere. An empty
  line accepts the recommendation; a number picks from the offered options.
- **`file`** writes `ronda-<n>.preguntas.json` and waits for
  `ronda-<n>.respuestas.json` in `--interview-dir`. It is the channel for
  everything else — your own UI, a mail bridge, a bot, another agent — and the
  files stay on disk as the record of what was decided.

`--interview` applies to `plan` only, and is rejected together with `--quiet`,
since every channel announces itself through the operator output that `--quiet`
silences. An unusable channel — a taken port, no terminal, a directory that
belongs to another interview — stops the run before a session opens, so nothing
is spent on a run that could not have been answered. If the round expires or the
channel goes away mid-interview, the run reports it and continues with the
recommendations rather than failing; the interview is a chance to intervene, not
a new way for planning to die.

`plan` still writes no state. An interrupted interview loses the round in
flight and nothing else, and the session id is reported at every round, so an
Azure planning session can be resumed by hand with `--session <id>`.

## Agent authority

Every run carries an agent authority profile alongside its prompt. The prompt
states what the coding agent should decide; the profile states what it may
execute. The same five profiles exist in both formats, one per CLI, and neither
file is generated from the other: each provider validates and enforces its own.

For OpenCode the profiles live in `opencode/authority.json`, injected per run
through `OPENCODE_CONFIG`, which merges with the target repository's own OpenCode
configuration rather than replacing it — enforcement does not require the target
repository to be configured for lazy-workflow. For Claude Code each profile is
its own settings file under `claudecode/<profile>.json`, injected per run by path
with `--settings`.

| Profile | Used by | Denies |
|---|---|---|
| `lazy-github-plan` | `plan` without `--hu` | pushes, branch and remote mutation, `gh pr`/`gh api`, all `az` |
| `lazy-github-code` | `code` without `--hu` | the above plus every `gh issue` mutation |
| `lazy-azure-plan` | `plan --hu` | pushes, branch and remote mutation, all `az` and `gh` |
| `lazy-azure-code` | `code --hu` | the above; the coordinator owns every Azure and remote effect |
| `lazy-review` | `architecture-review-sag` | edits, and every mutating `git`, `gh`, and `az` command |

OpenCode runs with `--auto` and Claude Code with `--permission-mode
bypassPermissions`, which auto-approve only what is not explicitly denied, so
these deny rules are the enforcement surface. A denied command fails
as a permission error rather than relying on the model to obey prose; compound
commands are matched per sub-command, so `cd x && git push` is denied too.
Committing stays allowed in the delivery profiles because the completion
manifest names a commit the session must produce.

## Structure

```text
main.ts                 CLI entrypoint
prompts/                OpenCode prompt assets (composed by src/prompts/)
opencode/authority.json Agent permission profiles injected per run (OpenCode)
claudecode/             One settings file per profile, injected per run (Claude Code)
src/prompts/            Prompt composition, contract vocabulary, authority profiles
src/interaction/        Planning interview: question rounds and the channels that carry them
src/azure/              Azure Boards model and service
src/github/             GitHub tracker boundaries for SAG review publication
src/sag/                SAG norm retrieval and deployment coordination
src/cli/                Workflow coordination
src/git/                Verified ticket-branch cleanup
src/coding-agent/       Coding agent seam: contract, result, process and CLI selection
src/opencode/           OpenCode execution and JSONL result
src/claude-code/        Claude Code execution and stream JSON result
test/                   Bun tests
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
