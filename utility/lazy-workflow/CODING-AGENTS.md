# The coding-agent layer

A workflow command opens exactly one coding-agent session per unit of work. This
file is what changes when you pick a CLI, a model, an effort or a fallback chain —
and what the session is allowed to do once it is running, which is usually the
part that decides whether a request is even expressible as a prompt.

Contents: [One CLI per run](#one-cli-per-run) · [Authority](#authority-what-a-session-may-execute) ·
[The division of labour](#the-division-of-labour) · [Sessions and checkpoints](#sessions-and-checkpoints) ·
[Fallback and handoff](#fallback-and-handoff) · [Markers](#markers) · [Watching a run](#watching-a-run)

## One CLI per run

`--cli` resolves the CLI once, and every session the run opens uses it.

| Flag | Default | Notes |
|---|---|---|
| `--cli opencode\|claudecode` | `opencode` | Naming one verifies its binary (`opencode` / `claude`) while parsing, so a missing install is an argument error, not a dead session |
| `--model <id>` | `opencode-go/deepseek-v4-pro` | Written exactly as the selected CLI exposes it — `claude-sonnet-5` for Claude Code, `<provider>/<model>` for OpenCode |
| `--variant <effort>` | `high` | The effort of the selected CLI; Claude Code accepts `low`, `medium`, `high`, `xhigh`, `max` and rejects anything else before opening a session |

```bash
lazy-workflow plan --cli claudecode --model claude-opus-5 --variant high --working-directory /repo
lazy-workflow code --cli opencode --model opencode-go/deepseek-v4-pro --variant high --working-directory /repo
```

Claude Code sessions run non-interactively over its JSON event stream, take the
session id from the CLI's own initialization event, and never use `--bare`, so
the operator's login and the target repository's `CLAUDE.md` stay in play. Both
CLIs' events reach the reporter with the same severities: assistant text as info,
reasoning and tool calls as debug.

The SAG workflows accept `--cli` too and keep their own rules whichever CLI runs
them — `architecture-review-sag` is the only one that opens a session, and it
cannot modify the reviewed tree in either CLI.

## Authority: what a session may execute

Every run carries an authority profile beside its prompt. The prompt states what
the agent should decide; the profile states what it may execute. Denied commands
fail as permission errors rather than relying on the model to obey prose, and
compound commands are matched per sub-command, so `cd x && git push` is denied too.

| Profile | Used by | Denies |
|---|---|---|
| `lazy-github-plan` | `plan` without `--hu` | pushes, branch/remote mutation, `gh pr`, `gh repo`, `gh api`, all `az` |
| `lazy-github-code` | `code` without `--hu` | the above plus every `gh issue` mutation |
| `lazy-azure-plan` | `plan --hu` | pushes, branch/remote mutation, all `az` and all `gh` |
| `lazy-azure-code` | `code --hu` | the above; the coordinator owns every Azure and remote effect |
| `lazy-review` | `architecture-review-sag` | edits, and every mutating `git`, `gh` and `az` command |

Committing stays allowed in the delivery profiles, because the completion
manifest names a commit the session must produce.

**This is the constraint that shapes prompts.** A session cannot read the tracker,
push, open a PR or move a work item, whatever `--prompt` asks of it. So anything
the session needs from outside the repository has to be on disk before the run
starts — capture it with a tool command and reference the path. OpenCode reads
these profiles from `opencode/authority.json` through `OPENCODE_CONFIG`, which
merges with the target repository's own configuration; Claude Code reads one
settings file per profile from `claudecode/<profile>.json`, injected with
`--settings`. Neither file is generated from the other.

## The division of labour

The coordinator — the lazy-workflow process itself — owns every external effect.
The session implements, validates, commits and writes a completion manifest, then
stops. It is the coordinator that pushes, creates or reuses the pull request,
merges it, closes the issue or completes the ticket, publishes effort and
evidence, verifies every gate, cleans branches and selects the next unit of work.

That boundary explains most surprising behaviour: a session that "finished" but
left nothing merged has done its whole job, and the rest is a coordinator phase to
resume by rerunning the same command.

## Sessions and checkpoints

A delivery run stores a versioned checkpoint in the repository's Git metadata
(workspace runs keep the aggregate one in `<parent>/.lazy-workflow/`, outside every
source repository). It records the phase, the immutable HU/ticket/issue/branch
identities, the tracker revision, the effort baseline, the active duration, the
opaque session id, the manifest path, the pull request, the verified effect
receipts — and the CLI that owns the session.

```bash
lazy-workflow code --session <id> --prompt continue                       # resume the preserved session
lazy-workflow code --session <id> --model claude-sonnet-5 --variant high --prompt continue
lazy-workflow code --hu 23438 --working-directory /repo                   # resume the coordinator phase
```

- The identities come from the checkpoint, so `--session` needs neither `--hu`
  nor `--working-directory`.
- Only explicitly supplied `--model` and `--variant` override the existing
  session; omitted ones stay as they were.
- A `--cli` contradicting the checkpoint fails closed and names the CLI that owns
  the work — resume with that one, or drop the flag. The exception is a
  cross-CLI handoff the run itself performed: relaunching the same command
  resumes on the CLI actually holding the work.
- A session the provider deleted cannot be recovered; the checkpoint becomes
  sessionless and stops rather than retrying forever.

`plan` writes no checkpoint at all — an interrupted planning run loses the round
in flight and nothing else.

## Fallback and handoff

```bash
lazy-workflow code --working-directory /repo \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high \
  --fallback opencode:opencode-go/deepseek-v4-pro:high \
  --fallback-wait 300 --fallback-wait-max 3600
```

The primary rung is the run's own `--cli`/`--model`/`--variant`; declaration order
is descent order; every rung's binary is verified while parsing, so a typo is
caught before the primary spends any usage.

- The chain descends **only on provider exhaustion** — usage or rate limit,
  quota, billing, authentication — as each CLI's adapter classifies it. A session
  that merely fails its task never descends (ADR-0024).
- A backup on the **same CLI** resumes the same session with the new model, so
  the context already built survives.
- A backup on **another CLI** has no session to resume: the work continues
  through a handoff — a fresh session receiving the coordinator's own prompt for
  the same fixed unit of work plus a progress section built from verified state
  (checkpoint phase, branch, last commit, uncommitted worktree, manifest if it
  exists). Nothing the exhausted session said travels with it (ADR-0025).
- The descent is **sticky for the unit in progress only**: the next issue starts
  again at the primary rung, so a run returns to the preferred model as soon as
  quota renews.
- With every rung exhausted, the run waits `--fallback-wait` seconds and retries
  from the primary, bounded by `--fallback-wait-max` wall-clock seconds from the
  first wait. When the bound is spent it fails closed with the checkpoint intact.

Two rungs can name the same model through different accounts — Sonnet 5 on a
Claude subscription backed by the identical model billed to a GitHub Copilot seat
through OpenCode. The model is preserved; only who pays changes.

## Markers

A run ends on a marker, and which one it is says who must act next.

| Marker | Meaning |
|---|---|
| `PLAN_READY` | The planning session returned a plan; the coordinator validates and publishes it |
| `QUESTIONS_PENDING` / `QUESTIONS_ANSWERED` | An interview round is waiting for the operator, or has been answered |
| `IMPLEMENTATION_READY` | The session finished implementing and wrote its manifest; everything after belongs to the coordinator |
| `TICKET_COMPLETED`, `WORKFLOW_STEP_FINISHED` | Coordinator-only, emitted after every gate passed |
| `QUEUE_EMPTY`, `QUEUE_BLOCKED` | Coordinator-owned queue outcomes; a session may not print them |
| `RECONCILIATION_REQUIRED` | A checkpoint survives and must be reconciled before new work is selected |
| `ARCHITECTURE_REVIEW_RESULT` | The review's findings, published as corrective tracker work |

## Watching a run

| Flag | What it adds |
|---|---|
| *(default)* | info, warn and error — 5 to 15 lines for a typical delivery |
| `--verbose` | reasoning and tool calls, each naming the artifact it touches |
| `--verbose-output` | every tool input and output plus the raw agent event; implies `--verbose` |
| `--quiet` | errors only; silences the run panel too |
| `--no-color` | strips ANSI, stacks with any of the above |

All of it goes to stderr, stamped `dd/mm/yy HH:mm:ss`, so a run can be watched and
its JSON result captured at the same time. `--verbose-output` is the right setting
when the question is *what the agent actually did*; the default is right when the
question is whether it finished.
