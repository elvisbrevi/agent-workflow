# agent-workflow

**Reusable skills and a CLI to plan and deliver software work with AI agents.**

Use the skills in your coding assistant, or run **`lz`** to turn a
GitHub backlog or an Azure DevOps User Story (HU) into verified deliveries.
It supports **OpenCode**, **Claude Code**, and **Codex**.

[Install](#install) · [Quick start](#quick-start) · [Examples](#examples) ·
[Deterministic commands](#deterministic-commands) · [Skills](#skills) ·
[Documentation](#documentation)

## Install

Install **Git** and **Bun** first. Choose the command for your shell:

### Bash

```bash
curl -fsSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh \
  | bash -s -- --all-global
```

### Zsh

```zsh
curl -fsSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh \
  | zsh -s -- --all-global
```

### PowerShell (Windows)

```powershell
$installer = Join-Path $env:TEMP 'agent-workflow-install.ps1'
Invoke-WebRequest https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer --all-global
```

`--all-global` installs the skills, agent entries, and CLI, and prepares its
locked Bun dependencies. Add `~/.local/bin` to `PATH` (`$HOME\.local\bin` on
Windows), then check the installation with `lz --help`.

Windows installs `lz.cmd`; use `lz-powershell.ps1` for
quoted or multiline PowerShell prompts, with a script execution policy that
permits local scripts.
The previous `lazy-workflow` launcher remains available for existing scripts.
The skill is named `lz`; reinstalling removes the old `lazy-workflow` skill link.

<details>
<summary>Other installation modes</summary>

| Option | Installs into |
|---|---|
| `--claude-global` | Global Claude Code skills, agents, and CLI |
| `--claude-local` | Project-local Claude Code skills, agents, and CLI |
| `--global` | Shared global skills and agents |
| `--local` | Shared project-local skills and agents |
| `--opencode` | Project-local OpenCode skills and agents |
| `--both` | Shared and OpenCode project-local entries |
| `--codex` | Global Codex skills |

Use `--target <directory>` for local modes. Run `./install.sh --help` or
`./install.ps1 --help` for all installer options.

</details>

## Quick start

Install and authenticate your coding CLI and the tracker CLI: **`gh`** for
GitHub, or **`az` with the Azure DevOps extension** for Azure.
Replace `/path/to/repository` with your local checkout.

```bash
# Plan the requested work and publish GitHub issues with their dependencies.
lz plan --prompt "Add pagination to the API" --working-directory /path/to/repository

# Deliver eligible GitHub issues: implement, verify, push, merge, and close.
lz code --working-directory /path/to/repository

# Show every command and its required options.
lz --help

# Reinstall the latest tool and global integrations.
lz update
```

| Command | Purpose |
|---|---|
| `plan` | Create a plan and publish its issues or Azure work items. |
| `code` | Deliver eligible work, one unit at a time. |
| `update` | Run the platform installer; defaults to `--all-global`. |

Without `--hu`, workflows use GitHub. `code` selects open, unassigned,
non-epic issues labelled `ready-for-agent` with no open blockers. Each delivery
must pass Git verification before it is pushed and merged.

## Examples

### Choose a coding agent

OpenCode is the default. Both `plan` and `code` accept `--cli`, `--model`, and
`--variant`; the selected CLI must be installed and authenticated.

| `--cli` | Executable | Default model |
|---|---|---|
| `opencode` | `opencode` | `opencode-go/deepseek-v4-pro` |
| `claudecode` | `claude` | `claude-sonnet-5` |
| `codex` | `codex` | `gpt-5.6-sol` |

```bash
# Plan with Claude Code at high effort.
lz plan --cli claudecode --variant high --working-directory /path/to/repository

# Deliver with Codex and an explicit model.
lz code --cli codex --model gpt-5.6-sol --working-directory /path/to/repository
```

### Plan interactively or apply SAG norms

```bash
# Answer the planning questions in a browser.
lz plan --interview http --working-directory /path/to/repository

# Load the component's SAG norms while planning.
lz plan --normas-sag --working-directory /path/to/repository
```

SAG norms require `.sag/config.json` (`tipo`: `api`, `bff`, or `nextjs`) and
`LAZY_WORKFLOW_SAG_NORMS_REPOSITORY`. The flag also works with `code`.

### Work with Azure DevOps

Set `LAZY_WORKFLOW_AZURE_ORGANIZATION` to `https://dev.azure.com/<organization>`.

```bash
# Split a User Story into linked work items.
lz plan --hu 23438 --working-directory /path/to/repository

# Deliver the HU's Task and Bug tickets; use main to create its integration branch.
lz code --hu 23438 --base-branch main --working-directory /path/to/repository
```

### Resume work or use several repositories

```bash
# Reconcile a verified GitHub delivery interrupted during publication.
lz code --working-directory /path/to/repository

# Resume an Azure delivery from its preserved session and checkpoint.
lz code --session SESSION_ID --prompt continue

# Deliver one unit across the listed repositories, in order.
lz code --working-directory /path/to/api,/path/to/web
```

Replace `SESSION_ID` with the preserved session ID. Multi-repository workflows
require all listed repositories to use the same tracker provider.

### Configure a fallback

```bash
# Switch from Claude Code to Codex if the provider is exhausted or the session stalls.
lz code --cli claudecode --fallback codex:gpt-5.6-sol:high \
  --idle-timeout 30 --working-directory /path/to/repository
```

Repeat `--fallback <cli>:<model>:<variant>` to add alternatives in order.
Task failures do not trigger fallback. Provider exhaustion retries every
`--fallback-wait` seconds (300), up to `--fallback-wait-max` seconds (3600).
See [fallback behavior](agent/lazy-workflow/README.md#fallback-chain).

### Inspect output or shut down after a run

```bash
# Include full tool inputs, outputs, and raw agent events.
lz code --verbose-output --working-directory /path/to/repository

# Write the run log to a chosen file.
lz code --log-file /path/to/runs.jsonl --working-directory /path/to/repository

# Power down after delivery; on Unix, set LAZY_WORKFLOW_OFF_PASSWORD beforehand.
lz code --off --off-delay 60 --working-directory /path/to/repository
```

`--off` also shuts down after a failed run, except argument errors; Ctrl-C
cancels during the delay. Windows needs no password.
See [shutdown details](agent/lazy-workflow/README.md#unattended-shutdown).

## Deterministic commands

These commands run individual operations **without opening an AI session**.
They use the same adapters as the workflows. Tracker and Git operations return
JSON; credential reads return names or a value.

Use `lz --help` for required arguments. The tables list subcommands;
invoke them as `lz <command> [options]`.

### GitHub

| Command | Purpose |
|---|---|
| `github-auth-info` | Check the authenticated GitHub identity. |
| `github-repo-info` | Validate the repository and read its configuration. |
| `github-issue-list` | List managed issues, eligibility, and blocking reasons. |
| `github-issue-select` | Find the next eligible issue without claiming it. |
| `github-issue-info` | Read an issue and explain its eligibility. |
| `github-issue-claim` | Assign an eligible issue to the authenticated user. |
| `github-issue-release` | Remove the authenticated user's claim from an issue. |
| `github-issue-close` | Record the supplied PR and merge commit, then close the issue. |
| `github-branch-prepare` | Prepare the issue branch from the refreshed base. |
| `github-branch-checkout` | Switch to an existing delivery branch. |
| `github-branch-verify` | Check the active branch and its remote commit, if present. |
| `github-branch-cleanup` | Delete delivery branches after checking the expected commit. |
| `github-session-verify` | Verify a clean delivery branch with commits ahead of the base. |
| `github-commit-push` | Push the verified branch commit. |
| `github-pr-create` | Create or reuse the issue's pull request. |
| `github-pr-merge` | Merge the matching pull request and return its merge commit. |

### Azure DevOps — read

| Command | Purpose |
|---|---|
| `hu-info` | Read the User Story's details. |
| `hu-children-info` | List the HU's direct child work items. |
| `hu-branch-info` | Read the HU's linked integration branch. |
| `ticket-info` | Read the ticket with its HU, branches, and delivery context. |
| `ticket-type-info` | Read and validate the ticket's Task or Bug type. |
| `ticket-description-info` | Read the ticket description. |
| `ticket-state-info` | Read the ticket state. |
| `ticket-effort-info` | Read the ticket's effort fields. |
| `ticket-branch-info` | Read the ticket's linked branch in its HU context. |
| `ticket-pr-info` | Read the ticket's pull requests in its HU context. |
| `ticket-completion-info` | Check the ticket's completion evidence and gates. |

### Azure DevOps — write and verify

| Command | Purpose |
|---|---|
| `hu-state-set` | Change the HU state with expected-state and revision checks. |
| `hu-branch-set` | Link an integration branch, creating it from an explicit base if needed. |
| `hu-branch-ensure` | Ensure the HU has its integration branch. |
| `ticket-create` | Create a Task or Bug under an HU. |
| `ticket-link-parent` | Link a child work item to its parent. |
| `ticket-link-predecessor` | Add a blocking dependency between work items. |
| `ticket-description-set` | Replace the description from a file. |
| `ticket-state-set` | Change state after checking the expected current state. |
| `ticket-effort-set` | Set effort fields after checking the expected revision. |
| `ticket-branch-set` | Link an existing ticket branch to its work item. |
| `ticket-branch-checkout` | Switch to the ticket branch. |
| `ticket-branch-push` | Push the ticket branch. |
| `ticket-session-verify` | Verify a clean ticket branch ahead of the integration branch. |
| `ticket-pr-create` | Create or reuse a PR and complete its merge into the HU branch. |
| `ticket-pr-link` | Associate the validated pull request with the ticket. |
| `ticket-commit-link` | Link the pull request's merge commit to the ticket. |
| `ticket-completion-apply` | Apply completion evidence and state after validating delivery gates. |

### Pull requests (GitHub and Azure DevOps)

`yp pr` without its menu or its AI description. The tracker is the one the
repository's `origin` names; the description is passed in, so an agent can
write it and hand it over.

| Command | Purpose |
|---|---|
| `pr-list` | List the open pull requests. |
| `pr-info` | Show one pull request with its description, status, and reviewers. |
| `pr-thread-list` | List its discussion threads and code comments, with file and line. |
| `pr-thread-reply` | Reply to one thread. |
| `pr-create` | Open a pull request with a title and an inline or file description. |

### Git and credentials

| Command | Purpose |
|---|---|
| `git-branch-list` | List local and remote branches newest first, with the active one apart (`yp checkout`'s menu). |
| `git-branch-checkout` | Fetch, switch to a local or remote branch, and fast-forward it (`yp checkout` without the menu). |
| `git-branch-delete` | Delete the local and remote delivery branch with verification. |
| `credentials-audit` | Report which secrets files and Keychain contain a credential, without its value. |
| `credentials-list` | Print the names stored in the local secrets files. |
| `credentials-get` | Print one credential; piping requires `--force`. |
| `credentials-set` | Store or rotate a credential using a hidden prompt or `--stdin`. |
| `credentials-migrate` | Copy a legacy macOS Keychain credential into the secrets files. |
| `credentials-update` | Pull the chezmoi source and apply its secrets, replacing local changes. |

Credentials live in `~/.config/secrets/*.env`. When chezmoi manages the file,
`credentials-set` and `credentials-migrate` also commit and push its encrypted
source.

### Common operations

```bash
# See which GitHub issues are eligible and why others are blocked.
lz github-issue-list --working-directory /path/to/repository

# Inspect an Azure ticket and its delivery context.
lz ticket-info --hu 23438 --ticket 23459

# Create a Task from an HTML description file.
lz ticket-create --hu 23438 --type Task --title "Add pagination" --description-file ./description.html

# Link an existing integration branch to an HU.
lz hu-branch-set --hu 23438 --branch hu/23438 --working-directory /path/to/repository

# Prompt for a credential value and store it.
lz credentials-set --name OPENAI_API_KEY

# Check where a credential exists without showing its value.
lz credentials-audit --name CARGO_REGISTRY_TOKEN

# Open a pull request whose description an agent wrote.
lz pr-create --branch feature/x --base-branch main --title "feat: x" --description-file ./pr.md

# Copy a legacy macOS Keychain item into the secrets files.
lz credentials-migrate --name CARGO_REGISTRY_TOKEN --service crates-io
```

See [all command examples](agent/lazy-workflow/README.md#practical-examples)
and the [deterministic tools design](docs/adr/0026-run-deterministic-tools-as-standalone-commands.md).

## Skills

Skills are reusable `SKILL.md` workflows. Invoke them with your coding client's
syntax, or let the client select a matching skill. Skills marked
`disable-model-invocation: true` require explicit invocation.

| Phase | Skills | Purpose |
|---|---|---|
| Discovery | `zoom-out` | Understand unfamiliar code or problems. |
| Design | `domain-modeling`, `grill-with-docs`, `prototype`, `improve-codebase-architecture` | Refine concepts, prototypes, and architecture. |
| Planning | `wayfinder`, `to-spec`, `to-tickets`, `triage` | Turn requests into scoped, actionable work. |
| Implementation | `implement`, `tdd` | Deliver a ticket or specification. |
| Diagnosis | `diagnose` | Reproduce defects and verify fixes. |
| Review | `code-review`, `handoff` | Review changes or transfer a session. |
| Utility | `caveman`, `credentials`, `grilling`, `lz`, `ponytail`, `setup-elvis-brevi-skills`, `write-a-skill`, `writing-great-skills` | Control communication, credentials, setup, and workflows. |

`writing-great-skills` comes from [Matt Pocock's skills collection](https://github.com/AIGeniusInstitute/mattpocock-skills/tree/main/skills/productivity/writing-great-skills) under the MIT license included with the skill.

## Documentation

| Reference | Contents |
|---|---|
| [Agent guide](agent/lazy-workflow/README.md) | Detailed CLI behavior, recovery, configuration, and examples. |
| [AGENTS.md](AGENTS.md) | Modification map and validation rules. |
| [CONTEXT.md](CONTEXT.md) | Domain vocabulary. |
| [Issue tracker](docs/agents/issue-tracker.md) | Tracker conventions. |
| [Triage labels](docs/agents/triage-labels.md) | Canonical labels. |
| [Architecture decisions](docs/adr/) | Design decisions and their rationale. |

### Development checks

```bash
# Run the agent's tests.
(cd agent/lz && bun test)

# Verify the installer in Bash.
bash tests/install_test.sh

# Verify the installer in Zsh.
BASH_BIN=zsh bash tests/install_test.sh

# Check the patch for whitespace errors.
git diff --check
```
