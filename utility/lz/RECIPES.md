# Recipes

In PowerShell, use `scripts/preflight.ps1` wherever an example uses
`scripts/preflight.sh`; the flags and JSON result are the same.

One intent per section, stated the way an operator states it, answered with the
commands to run in order. Replace `/repo`, the HU and the issue numbers.

## "Run HU 23438: plan and then code, with the SAG norms and my own prompt"

The whole shape of the request in the order it executes.

```bash
# 1. Read the HU before planning it — no session, no cost
scripts/preflight.sh --hu 23438 --working-directory /repo
#   (equivalently: hu-info, hu-children-info and hu-branch-info one by one)

# 2. Plan: the session slices the HU, the coordinator publishes the work items
lz plan --hu 23438 --normas-sag \
  --prompt "Prioritize the read paths before the write paths; keep ticket titles in Spanish." \
  --working-directory /repo

# 3. Confirm what was published, and whether the HU has an integration branch:
#    a "branch": null in the preflight means step 4 will create hu/23438 itself
scripts/preflight.sh --hu 23438 --working-directory /repo

# 4. Deliver the published Task and Bug tickets, one fresh session each
lz code --hu 23438 --normas-sag --base-branch main \
  --prompt "Cover every acceptance criterion with a test before closing the ticket." \
  --working-directory /repo
```

Drop `--base-branch` once `hu/23438` exists, the HU is already linked, or the HU
should simply branch from `master`/`main` — it is only needed to branch from
something else, such as `develop`. Drop
`--normas-sag` on either run to keep that phase away from SAG sources entirely —
it is opt-in per run, and `plan --normas-sag` does not imply `code --normas-sag`.

## "…taking HU 23300 as the reference"

The planning session cannot read Azure — `lazy-azure-plan` denies `az` and `gh`.
Materialize the reference first, then point the prompt at the file:

```bash
lz hu-info --hu 23300 > /tmp/ref-23300.json
lz hu-children-info --hu 23300 >> /tmp/ref-23300.json

lz plan --hu 23438 --normas-sag \
  --prompt "Read /tmp/ref-23300.json first: it is HU 23300 and its published tickets. Slice HU 23438 with the same granularity, ticket titles and estimate scale." \
  --working-directory /repo
```

The same holds in GitHub scope for another issue: capture it with
`github-issue-info --issue <id> > /tmp/ref.json` and reference the path.

## "Let me answer the planning questions myself"

```bash
lz plan --interview http --working-directory /repo   # in a browser page it opens
```

`--number-of-questions 8` widens the budget for the whole interview.
`--interview` is `plan`-only and cannot be combined with `--quiet`.

## "Drain the GitHub backlog of this repository"

```bash
scripts/preflight.sh --working-directory /repo   # auth, repository, queue and the next selection
lz code --working-directory /repo     # deliver them, one fresh session each
```

`code` re-selects the next eligible issue after every verified delivery until the
queue is empty or blocked. `plan` in this scope maps the requested work without
touching branches or tracker state.

## "Resume the run that was interrupted"

The HU or issue, the ticket and the branch come from the checkpoint, so no
`--hu` and no `--working-directory` are needed:

```bash
lz code --session <session-id> --prompt continue
lz code --session <session-id> --model claude-sonnet-5 --variant high --prompt continue
```

If git already verified the session's commits — the run had moved on to pushing,
the pull request or the tracker — rerun the **original** command instead: it
resumes the coordinator phase rather than selecting replacement work.

```bash
lz code --hu 23438 --working-directory /repo
```

## "Keep the run alive when the account runs out"

```bash
# Same model, second account paying for it
lz code --working-directory /repo \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high

# Several rungs across three CLIs; declaration order is the descent order
lz code --working-directory /repo \
  --cli claudecode --model claude-sonnet-5 --variant high \
  --fallback opencode:github-copilot/claude-sonnet-5:high \
  --fallback codex:gpt-5.6-sol:high \
  --fallback-wait 300 --fallback-wait-max 3600
```

Write each rung's model id exactly as its own CLI exposes it. The descent lasts
only for the unit of work in progress; the next one starts at the primary rung.

## "One unit of work across several repositories"

```bash
lz plan --working-directory /repo-a,/repo-b
lz code --working-directory /repo-a,/repo-b
lz code --hu 23438 --working-directory /repo-a,/repo-b            # drains the HU
lz code --hu 23438 --ticket 51 --working-directory /repo-a,/repo-b  # one unit only
```

Every entry must be a Git repository root with an `origin` remote and a clean
worktree, all on the same provider, and the declared order is the delivery
order. Azure workspace `code` drains the HU's eligible children unless `--ticket`
narrows it to one; recovery needs the exact same list, in the same order.

## "Publish tickets by hand, without planning"

```bash
lz ticket-create --hu 23438 --type Task --title "Slice uno" \
  --description-file ./description.html --estimate 8 \
  --assignee persona@empresa.cl --field Custom.Componente=api
lz ticket-link-parent --parent 23438 --child 23459
lz ticket-link-predecessor --blocker 23459 --blocked 23460
```

These are the same primitives the plan publication uses, so a hand-published
ticket is indistinguishable from a planned one.

## "Show me everything the agent is doing"

```bash
lz code --verbose        --working-directory /repo   # + reasoning and tool calls
lz code --verbose-output --working-directory /repo   # + every tool input/output and the raw event
lz code --quiet          --working-directory /repo   # errors only
```

## "Open the GUI on my repositories, with Claude Code by default"

```bash
cd agent/lazy-workflow/gui && bun install && bun run build   # once; installers land in src-tauri/target/release/bundle/

# From this skill's directory:
bun scripts/gui-settings.ts add repositories /path/to/api
bun scripts/gui-settings.ts add repositories /path/to/web
bun scripts/gui-settings.ts set flagDefaults.--cli claudecode
bun scripts/gui-settings.ts set flagDefaults.--variant high
bun scripts/gui-settings.ts set commandDefaults.plan.--interview http
```

Every form now opens on the active repository with `--cli claudecode`, and
`plan` with the browser interview; the line above **Ejecutar** shows each of them
as an explicit flag. Nothing here changes a terminal run.

## "The GUI says lz is not found" / "it works in the terminal but not in the GUI"

```bash
bun scripts/gui-settings.ts set inheritShellEnvironment true
bun scripts/gui-settings.ts add extraPath ~/.local/bin
bun scripts/gui-settings.ts add extraPath ~/.bun/bin
# or run a checkout directly, without the installed launcher:
bun scripts/gui-settings.ts set lzCommand /path/to/agent-workflow/agent/lazy-workflow/main.ts
```

Then **Inicio → Diagnostico → Actualizar** lists the launcher and every tool the
run will find. A missing `LAZY_WORKFLOW_*` variable is the same problem: export
it from the shell profile, or set it for GUI runs only with
`bun scripts/gui-settings.ts set environment.<NAME> <value>`.

## "Give the GUI my Azure PAT and the shutdown password"

```bash
lz credentials-set --name AZURE_DEVOPS_EXT_PAT
lz credentials-set --name LAZY_WORKFLOW_OFF_PASSWORD
bun scripts/gui-settings.ts add secretEnvironment AZURE_DEVOPS_EXT_PAT
bun scripts/gui-settings.ts add secretEnvironment LAZY_WORKFLOW_OFF_PASSWORD
```

Each GUI run reads them with `lz credentials-get` as it starts; neither value is
written to `gui.json`, shown in a form, or placed on a command line. `--off` in
the GUI is a checkbox that sends a bare `--off`, which takes the password from
that variable.

## "What exactly will this GUI form run?"

The dark line above **Ejecutar** is the command, with secrets masked; **Copiar**
puts it on the clipboard for a terminal. To reason about a form without the
window, read the command's definition from the installed binary:

```bash
lz catalog | jq '.commands[] | select(.name == "code")'
```

Fields left empty are not sent, so the CLI's defaults apply; a greyed field's
flag is not sent either, because the flag it `requires` is missing.
