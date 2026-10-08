---
name: lz
description: Route lz requests through deterministic tools, workflows, configuration, or the desktop GUI. Use for GitHub issue queues, Azure HUs and tickets, planning, delivery, recovery of an interrupted lazy-workflow run, configuring the lz CLI (environment, credentials, installation, defaults), or building, launching and configuring the lz GUI.
---

# lz

`lz` is the repository's executable workflow
([agent/lazy-workflow](../../agent/lazy-workflow/README.md)), and its desktop GUI
([agent/lazy-workflow/gui](../../agent/lazy-workflow/gui/README.md)) renders the
same commands as forms. Route each request by the effect it needs:

- **Tool:** one deterministic read or repair operation; no coding-agent session.
  Use [TOOLS.md](TOOLS.md) to choose a command.
- **Workflow:** `plan` publishes work and `code` delivers it, each opening
  coding-agent sessions. Use [COMMANDS.md](COMMANDS.md) for their flags.
- **Configuration:** environment variables, credentials, installation modes and
  defaults, for the CLI and the GUI alike. Use [CONFIGURATION.md](CONFIGURATION.md).
- **GUI:** building or launching the window, its settings file, or what one of
  its forms will run. Use [GUI.md](GUI.md).

`lz catalog` prints, as JSON, every command the installed binary accepts with its
flags, value kinds, defaults, requirements and effect; it is the authority when a
reference and the binary disagree, and it is what the GUI renders. `lz --help`
prints the same surface as text. From `agent/lazy-workflow/`,
`bun run main.ts <command> [flags]` is equivalent to the installed launcher.

## Route the request

1. **Choose the operation.** For status, eligibility, branch, completion-gate,
   or failure questions, select the smallest read tool in [TOOLS.md](TOOLS.md).
   For planning or delivery, select the workflow in [COMMANDS.md](COMMANDS.md).
   For a repair, use the specific write tool after its read tool identifies the
   missing effect. For "set up", "configure", "make it use", or "where does it
   read", find the setting in [CONFIGURATION.md](CONFIGURATION.md); for anything
   about the window, [GUI.md](GUI.md). This step ends when the requested outcome
   has a command, a sequence of commands, or a setting.
2. **Fix the scope.** No `--hu` means GitHub scope; `--hu <id>` means Azure HU
   scope. Set `--working-directory` to the target repository even though it
   defaults to the current directory. A comma-separated list is a
   multi-repository `plan` or `code` run, delivered in the listed order. A GUI
   setting is the operator's (`~/.config/lazy-workflow/gui.json`), never a
   repository's. This step ends when the target tracker, repository, or settings
   file is unambiguous.
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
   [scope and context](COMMANDS.md#scope-and-context). Before changing the GUI,
   read its current settings with `bun scripts/gui-settings.ts show`. This step
   ends when the live state supports the chosen command, or the failure itself
   answers the request.
4. **Compose and run or answer.** Add `--cli`, `--model`, `--variant`, or
   `--fallback` only when requested or needed for a known runtime constraint;
   their defaults and recovery behavior are in
   [CODING-AGENTS.md](CODING-AGENTS.md). Add `--normas-sag` separately to each
   `plan` or `code` run that needs SAG norms. Change GUI settings only through
   `scripts/gui-settings.ts`, which validates each write. Execute an authorized
   action; if the user asked only how, give the exact command — the one the GUI
   would show above its **Ejecutar** button — and explain any non-obvious flag.
   This step ends when the command has run or the operator has a runnable
   command.
5. **Verify the result.** Read how the workflow ended in
   [CODING-AGENTS.md#markers](CODING-AGENTS.md#markers), then use the relevant
   read tool to confirm published items, delivery gates, or queue state. A
   planning run and a delivery run are separate; inspect the items published
   by `plan` before starting `code`. If a run stopped, follow
   [TROUBLESHOOTING.md](TROUBLESHOOTING.md) using its output and checkpoint. After
   a configuration change, run the check in
   [CONFIGURATION.md#checking-the-result](CONFIGURATION.md#checking-the-result).
   This step ends when the requested effect is confirmed or the exact blocker
   and recovery command are known.

## Boundaries that change the command

- Tool results are JSON on stdout; operator messages and errors are on stderr.
  A failed tool leaves stdout empty. Keep stderr visible when diagnosing a
  failure. The GUI shows the two streams side by side.
- `--prompt` supplements the workflow's fixed identities and authority
  profile. A session cannot directly read its tracker or perform the
  coordinator's push, PR, or tracker updates. Capture external reference data
  with a tool before the run and point the prompt at the saved file. See
  [the authority profiles](CODING-AGENTS.md#authority-what-a-session-may-execute).
- SAG norms load through `--normas-sag`, not prompt text.
- To continue an interrupted coding-agent session, use
  `lz code --session <id> --prompt continue`. Once git has verified the
  session's commits, rerun the original `code` command to resume coordinator
  work. See [sessions and checkpoints](CODING-AGENTS.md#sessions-and-checkpoints).
- A workflow or write tool can change a live backlog, repository, or the
  secrets files. Run it when the request authorizes that effect. Read tools,
  preflight and `lz catalog` are available for diagnosis. The GUI asks before
  every such command unless `confirmWrites` is off.
- Secrets never go on a command line, in a prompt, or in `gui.json`: store them
  with `lz credentials-set` and let the GUI resolve them through
  `secretEnvironment`.

For complete sequences, including Azure branch selection, fallback chains and
GUI setup, open [RECIPES.md](RECIPES.md). For flag validation errors, use
[COMMANDS.md](COMMANDS.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
