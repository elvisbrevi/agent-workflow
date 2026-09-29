---
name: lz
description: Route lz requests through deterministic tools or workflows. Use for GitHub issue queues, Azure HUs and tickets, planning, delivery, SAG checks, or recovery of an interrupted lazy-workflow run.
---

# lz

`lz` is the repository's executable workflow
([agent/lazy-workflow](../../agent/lazy-workflow/README.md)). Route each request
by the effect it needs:

- **Tool:** one deterministic read or repair operation; no coding-agent session.
  Use [TOOLS.md](TOOLS.md) to choose a command.
- **Workflow:** `plan` publishes work, `code` delivers it, and the SAG commands
  review, verify, or deploy. `plan`, `code`, and `architecture-review-sag` open
  coding-agent sessions; `infra-sag` and `deploy-sag` use adapters. Use
  [COMMANDS.md](COMMANDS.md) for their flags.

Run `lz` without arguments for current CLI help if a reference and the binary
disagree. From `agent/lazy-workflow/`, `bun run main.ts <command> [flags]` is
equivalent to the installed launcher.

## Route the request

1. **Choose the operation.** For status, eligibility, branch, completion-gate,
   or failure questions, select the smallest read tool in [TOOLS.md](TOOLS.md).
   For planning, delivery, review, infrastructure verification, or deployment,
   select the workflow in [COMMANDS.md](COMMANDS.md). For a repair, use the
   specific write tool after its read tool identifies the missing effect. This
   step ends when the requested outcome has a command or sequence of commands.
2. **Fix the scope.** No `--hu` means GitHub scope; `--hu <id>` means Azure HU
   scope. SAG commands require exactly one of `--hu` or `--issue`. Set
   `--working-directory` to the target repository even though it defaults to
   the current directory. A comma-separated list is a multi-repository `plan`
   or `code` run, delivered in the listed order. This step ends when the target
   tracker and repository are unambiguous.
3. **Read the state that can change the command.** Before a workflow run,
   execute the read-only preflight from this skill's directory (PowerShell:
   `scripts/preflight.ps1`):

   ```bash
   scripts/preflight.sh --working-directory /repo
   scripts/preflight.sh --hu 23438 --working-directory /repo
   ```

   For one item, add `--issue <id>` or `--hu <id> --ticket <id>`. Inspect
   `allOk`, each probe's `ok` and `error`, and `notes`; exit `0` means the
   report was produced, not that every probe passed. Resolve a failed probe
   before selecting a write. For Azure delivery, use the HU branch probe and
   its notes to decide whether `--base-branch` is needed; see
   [scope and context](COMMANDS.md#scope-and-context). This step ends when the
   live state supports the chosen command, or the failure itself answers the
   request.
4. **Compose and run or answer.** Add `--cli`, `--model`, `--variant`, or
   `--fallback` only when requested or needed for a known runtime constraint;
   their defaults and recovery behavior are in
   [CODING-AGENTS.md](CODING-AGENTS.md). Add `--normas-sag` separately to each
   `plan` or `code` run that needs SAG norms. Execute an authorized action; if
   the user asked only how, give the exact command and explain any non-obvious
   flag. This step ends when the command has run or the operator has a runnable
   command.
5. **Verify the result.** Read the workflow's final marker in
   [CODING-AGENTS.md#markers](CODING-AGENTS.md#markers), then use the relevant
   read tool to confirm published items, delivery gates, or queue state. A
   planning run and a delivery run are separate; inspect the items published
   by `plan` before starting `code`. If a run stopped, follow
   [TROUBLESHOOTING.md](TROUBLESHOOTING.md) using its marker and checkpoint.
   This step ends when the requested effect is confirmed or the exact blocker
   and recovery command are known.

## Boundaries that change the command

- Tool results are JSON on stdout; operator messages and errors are on stderr.
  A failed tool leaves stdout empty. Keep stderr visible when diagnosing a
  failure.
- `--prompt` supplements the workflow's fixed identities and authority
  profile. A session cannot directly read its tracker or perform the
  coordinator's push, PR, or tracker updates. Capture external reference data
  with a tool before the run and point the prompt at the saved file. See
  [the authority profiles](CODING-AGENTS.md#authority-what-a-session-may-execute).
- SAG norms load through `--normas-sag`, not prompt text. The SAG commands load
  their norms themselves.
- To continue an interrupted coding-agent session, use
  `lz code --session <id> --prompt continue`. Once implementation has reached
  `IMPLEMENTATION_READY`, rerun the original `code` command to resume
  coordinator work. See [sessions and checkpoints](CODING-AGENTS.md#sessions-and-checkpoints).
- A workflow or write tool can change a live backlog, repository, or
  deployment. Run it when the request authorizes that effect. Read tools and
  preflight are available for diagnosis.

For complete sequences, including Azure branch selection and fallback chains,
open [RECIPES.md](RECIPES.md). For flag validation errors, use
[COMMANDS.md](COMMANDS.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
