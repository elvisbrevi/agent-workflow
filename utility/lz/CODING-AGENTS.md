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
| `--cli opencode\|claudecode\|codex` | `opencode` | Naming one verifies its binary (`opencode` / `claude` / `codex`) while parsing, so a missing install is an argument error, not a dead session |
| `--model <id>` | per `--cli`: `opencode-go/deepseek-v4-pro`, `claude-sonnet-5`, or `gpt-5.6-sol` | Resolved after `--cli` from the same table as the binary and the accepted efforts (ADR-0034), so naming a CLI without `--model` never opens a session against a model it cannot resolve; an explicit `--model` always overrides the default, including for a recovery that adopts a checkpoint's CLI |
| `--variant <effort>` | `high` | The effort of the selected CLI, read from that same table; Claude Code accepts `low`, `medium`, `high`, `xhigh`, `max`, and Codex accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

```bash
lz plan --cli claudecode --model claude-opus-5 --variant high --working-directory /repo
lz code --cli opencode --model opencode-go/deepseek-v4-pro --variant high --working-directory /repo
lz plan --cli codex --model gpt-5.6-sol --variant high --working-directory /repo
```

Claude Code sessions run non-interactively over its JSON event stream, take the
session id from the CLI's own initialization event, and never use `--bare`, so
the operator's login and the target repository's `CLAUDE.md` stay in play. Codex
uses `codex exec --json`, reads its session id from `thread.started`, and resumes
with `codex exec resume`. All CLIs' events reach the reporter with the same
severities: assistant text as info, reasoning and tool calls as debug.

## Authority: what a session may execute

Every run carries an authority profile beside its prompt. The prompt states what
the agent should decide; the profile states what it may execute. Denied commands
fail as permission errors rather than relying on the model to obey prose, and
compound commands are matched per sub-command, so `cd x && git push` is denied too.

| Profile | Used by | Denies |
|---|---|---|
| `lazy-github-plan` | `plan` without `--hu` | pushes, branch/remote mutation, `gh issue create`, `gh issue edit`, `gh pr`, `gh repo`, `gh api`, all `az` |
| `lazy-github-code` | `code` without `--hu` | the above plus every `gh issue` mutation |
| `lazy-azure-plan` | `plan --hu` | pushes, branch/remote mutation, all `az` and all `gh` |
| `lazy-azure-code` | `code --hu` | the above; the coordinator owns every Azure and remote effect |

Committing stays allowed in the delivery profiles, because git decides whether a
session delivered: its commits on the fixed branch are the deliverable.

**This is the constraint that shapes prompts.** A session cannot read the tracker,
push, open a PR or move a work item, whatever `--prompt` asks of it. So anything
the session needs from outside the repository has to be on disk before the run
starts — capture it with a tool command and reference the path. The profiles
exist in three formats, one per CLI, and none is generated from another: a rule
lost in translation is a rule that stops enforcing. OpenCode reads them from
`opencode/authority.json` through `OPENCODE_CONFIG`, which merges with the
target repository's own configuration; Claude Code reads one settings file per
profile from `claudecode/<profile>.json`, injected with `--settings`; Codex
reads one execpolicy rules file per profile from `codex/<profile>.rules`,
discovered from a lazy-workflow-owned Codex home that also links in the
operator's `auth.json` and `skills/` — but never their `config.toml` — and is
assembled fresh from the profile the coordinator already fixed.

## The division of labour

The coordinator — the lz process itself — owns every external effect.
The session implements, validates and commits, then exits. It is the coordinator that pushes, creates or reuses the pull request,
merges it, closes the issue or completes the ticket, publishes effort and
evidence, verifies every gate, cleans branches and selects the next unit of work.

That boundary explains most surprising behaviour: a session that "finished" but
left nothing merged has done its whole job, and the rest is a coordinator phase to
resume by rerunning the same command.

The commits are the one artefact that crosses the boundary (ADR-0035): when the
session's process exits, the coordinator asks git whether the fixed branch is
ahead of its base with a clean worktree, and that answer — not anything the
session printed — decides whether the delivery continues. A session that asked
a question, refused, or explored without committing leaves no commits and is an
ordinary unit failure; one that committed part of its work leaves a dirty tree
and fails the same way. `github-session-verify` and `ticket-session-verify` ask
the same question on demand (see `TOOLS.md`).

## Sessions and checkpoints

A delivery run stores a versioned checkpoint in the repository's Git metadata
(workspace runs keep the aggregate one in `<parent>/.lazy-workflow/`, outside every
source repository). It records the phase, the immutable HU/ticket/issue/branch
identities, the tracker revision, the effort baseline, the active duration, the
opaque session id, the pull request, the verified effect receipts — and the CLI
that owns the session.

```bash
lz code --session <id> --prompt continue                       # resume the preserved session
lz code --session <id> --model claude-sonnet-5 --variant high --prompt continue
lz code --hu 23438 --working-directory /repo                   # resume the coordinator phase
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
lz code --working-directory /repo \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high \
  --fallback codex:gpt-5.6-sol:high \
  --fallback-wait 300 --fallback-wait-max 3600
```

The primary rung is the run's own `--cli`/`--model`/`--variant`; declaration order
is descent order; every rung's binary is verified while parsing, so a typo is
caught before the primary spends any usage.

- The chain descends on **provider exhaustion** — usage or rate limit, quota,
  billing, authentication — as each CLI's adapter classifies it, or when a
  session stays silent longer than `--idle-timeout` minutes (default 30). A
  session that merely fails its task never descends (ADR-0024).
- Every descent opens a **fresh session**, on the same CLI or another: the
  coordinator's own prompt for the same fixed unit of work plus a progress
  section with the branch, the commits it carries, and the last three reasoning
  chains of the outgoing session, verbatim (ADR-0039). The commits are what
  landed; the reasoning is context, not a verified account.
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
| `TICKET_COMPLETED`, `WORKFLOW_STEP_FINISHED` | Coordinator-only, emitted after every gate passed |
| `QUEUE_EMPTY`, `QUEUE_BLOCKED` | Coordinator-owned queue outcomes; a session may not print them |
| `RECONCILIATION_REQUIRED` | A checkpoint survives and must be reconciled before new work is selected |

A delivery session prints no marker at all: git decides whether it delivered
(ADR-0035), and the coordinator's stdout carries the outcome above. The GUI's run
panel names the last of these markers next to the run's status.

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
