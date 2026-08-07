# Issue Killer Design

## Goal

`issue-killer` is an autonomous supervisor that completes exactly one tracker item per worker session against GitHub or Azure DevOps. V2 runs on TypeScript under Bun and uses `@opencode-ai/sdk` as the sole agent runtime (ADR 0001, ADR 0014).

Safety guarantees:

- one runner per repository (lock on Git common dir, linked worktrees included)
- one issue per worker (**host-owned issue selection**)
- explicit operator authorization before destructive autonomy
- bounded transport retries, then OpenCode-only **fallback chain**
- durable checkpoint identity; recovery never infers the issue
- **completion verification** before queue advance
- harness-owned audit log that does not consume model tokens

The Bash multi-CLI V1 remains only as rollback until cutover and retirement (M11–M12). Domain language and this design describe V2.

## Source Layout

Composition root: `agent/issue-killer/bin/issue-killer.ts`.

```text
agent/issue-killer/
├── bin/issue-killer.ts
├── src/
│   ├── app/           # queue, attempt, recover
│   ├── domain/        # pure types and decisions
│   ├── config/        # TOML load + strict validate
│   ├── opencode/      # SDK runtime, event pump, session
│   ├── operator/      # args, TTY confirmations
│   ├── state/         # lock, checkpoint, atomic files
│   ├── system/        # command, git, clock, redaction, signals
│   └── tracker/       # GitHub + Azure adapters
└── test/
```

Dependency direction: CLI → app → domain ← ports; adapters implement ports. `domain/` imports no Bun, SDK, filesystem, or CLIs. `command.ts` is the only process spawner; argv arrays only.

## Configuration

Default path: `~/.config/issue-killer/config.toml`. `--config <path>` replaces it. Credential-free. Unknown keys, cycles, duplicate fallbacks, missing references, and control scalars containing `\n`/`\r`/NUL are hard errors. Trailing junk after TOML strings/arrays is a hard error.

```toml
default_profile = "opencode-main"
log_dir = "~/.local/state/issue-killer/logs"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"
fallbacks = ["opencode-backup"]

[profiles.opencode-main.options]
variant = "high"
auto_approve = true

[profiles.opencode-backup]
label = "OpenCode backup"
cli = "opencode"
command = "opencode"
model = "provider/backup-model"
```

Rules:

- every profile `cli` and `command` must be `opencode`
- `model` splits once into `providerID/modelID`
- `log_dir` is required, expanded, and must be writable at startup
- `auto_approve = true` is required for non-interactive destructive runs; `false` fails before session start
- no Claude/Codex profile fields

## Profile Selection

TTY: list OpenCode profiles; build ordered **fallback chain** from remaining profiles; then destructive confirmation showing profile, model, chain, tracker, repo, **autonomous permission mode**, base branch, and `log_dir`.

Non-TTY: `default_profile` + declared `fallbacks`.

## OpenCode Runtime

1. Validate args, config, repo, tracker auth, worktree; resolve Git common dir.
2. Migrate/validate legacy checkpoint without acting on ambiguous state.
3. Acquire repository lock (exclusive dir, ownership token, random temp status files, single in-memory status writer).
4. **Host-owned issue selection**; persist identity before any session.
5. Destructive confirmation unless already authorized.
6. Start local OpenCode via `createOpencode()` on `127.0.0.1` with ephemeral port (port `0` or reserve-and-retry on `EADDRINUSE`).
7. `createOpencodeClient({ baseUrl, directory, throwOnError: true })`; health/version gate.
8. Subscribe to events **before** prompt; create or `session.get()` with directory/issue/branch/base/profile checks.
9. Prompt with pinned issue only; full tool permissions for the run.
10. **Event pump** drains all session-filtered events; updates checkpoint/status; appends **harness execution log**.
11. Read **structured worker outcome** (text marker only while V1 coexists).
12. **Completion verification** live; advance queue only if verified.
13. Delete session only after verified completion or verified empty queue.
14. On signal/error: abort session, close server, keep checkpoint if needed, release lock only if token matches.

**Opaque session id**: `^[A-Za-z0-9_-]+$`, max 128; revalidated before persist/resume/delete.

Fallback continues the **same worker session** when it is still resumable, sending the next profile's model on that session, after persisting failed profile, next profile, chain position, and **provider failure category**. It falls back to a fresh session on the same issue/worktree only when no resumable session exists.

## Harness Execution Log

- written only by the supervisor from the event pump
- never produced by the model and never fed back into the prompt
- all files under required TOML `log_dir`
- one redacted JSONL file per queue run
- records observed commands and file create/edit/delete (and related progress)
- no full file bodies, no secrets, no raw SDK stream by default
- same redaction pipeline as console, including multiline private-key state machine
- no automatic rotation in V2

## Worker Outcome And Completion

Primary: structured output `{ status, issue, summary }` with public statuses `ISSUE_COMPLETED | QUEUE_EMPTY | BLOCKED | FAILED | RECOVERY_REQUIRED`.

Compatibility text marker `ISSUE_KILLER_STATUS=...` only until V1 retirement (M12); contradictions → reject; invalid/missing → malformed; never advance without **completion verification**.

GitHub verification requires all of:

- issue closed (closed after PR merge as part of delivery)
- exactly one attributable PR
- PR merged
- `baseRefName` equals the run base branch

Azure verification is **ticket completion** (PR into **HU integration branch**, evidence, real effort, ticket in configured completed state such as Done). The HU is not auto-closed.

## Tracker Adapters

Tracker from Git remote + `docs/agents/issue-tracker.md`. GitHub via `gh`; Azure via `az`. No extra tracker SDKs. Ambiguity fails before launch.

Normalized operations include select/pin, blockers, claim, PR lookup, merge verify, close/complete, recovery reconcile, and unconditional completion verification for every tracker.

## Checkpoints And Locks

Git common dir: `issue-killer.lock/`, `issue-killer.checkpoint`.

- checkpoint stays `key=value` through cutover (optional `format_version=2`)
- allowlisted keys; reject duplicates where single-valued; reject control chars and oversized values
- atomic write via random temp in same dir + flush + rename
- never persist prompt, credentials, headers, full tools, or full commands
- lock stale only if PID gone and owner unchanged across re-read; release only on matching token

## Installer

- public command remains `issue-killer`
- install V2 with `bun install --frozen-lockfile --production` in managed cache
- `--dry-run` uses temporary staging only; no persistent cache/dest mutations
- `--uninstall` is offline (no repo sync); removes managed symlinks by ownership prefix
- missing required CLI args yield explicit errors, not unbound-variable failures
- V1 entrypoint kept as rollback until M12 approval

## Acceptance Criteria

- OpenCode-only profiles and fallback chains; no Claude/Codex runtime paths in V2
- host-owned selection for GitHub and Azure; model cannot switch issues
- event pump processes every session event; single status writer; random temps
- opaque session id validation prevents path traversal
- TOML loader rejects newline injection and trailing junk
- completion verification blocks false `ISSUE_COMPLETED` on GitHub and Azure
- harness log under `log_dir`, redactable, zero model tokens
- localhost ephemeral OpenCode server; clean abort on signals
- dry-run non-mutating; uninstall offline
- V1 checkpoint fixtures still load; cutover then Bash retirement by explicit approval
