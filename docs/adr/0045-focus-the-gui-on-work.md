---
status: proposed
---

# Focus the GUI on work, not on the catalog

ADR-0042 had the window draw one form per catalog entry. Operators then met
every deterministic tool as a button, family descriptions instead of their
work, and a settings page that edited launchers, environment variables and
secret names. The catalog was complete; the interface was not useful.

The GUI now offers the operator's work and the three commands that act on it.
**Trabajo** reads `work-assigned` per saved repository and groups Azure tasks
under their verified HU; an HU panel shows its tasks from `hu-children-info`,
and a GitHub panel shows the managed queue from `github-issue-list`. Plan and
Code open one form with the options an operator chooses between runs. The
deterministic tools stay commands of the CLI (ADR-0026) and are not buttons.

ADR-0042's boundary is unchanged: the window holds no workflow logic, reads the
installed `lz catalog` to validate flags and omit defaults, and runs `lz` as a
child process. A GitHub plan from an issue names it in `--prompt`; the session
reads it with `gh issue view`, which its authority already allows. Scoping
`code` to an epic's sub-issues would be a coordinator change, not a GUI one.

Model menus come from `lz agent-models`, which asks each installed CLI — `opencode
models`, `codex debug models`, and Claude Code's cached model catalog, falling
back to its aliases — instead of the single default per CLI the catalog knows.
Efforts are narrowed to those `--variant` accepts.

The window has no credential or environment fields. It derives what a run would
miss from the machine diagnostics, the trackers in use, the installed agents and
failed reads, and offers **Reparar con agente**: `lz setup`, one coding-agent
session under a new `lazy-setup` authority profile that denies file edits, git
and tracker mutation, `lz plan`, `lz code` and `lz credentials-get`. What only
the operator can supply stays in the session's report. Over the web, `setup` is
opt-in through `allowedCommands`, like every other command.

A run is followed in **Ejecuciones**, as a page with its status, interview,
progress and result, instead of a console panel docked under every view: the
operator lines are parsed back into time and message, and a plan waiting for
answers is announced on every screen.

Rejected: keeping the full catalog behind an "advanced" menu, which kept the
noise one click away and made every tool look like an operator action; and a
GUI-side model list, which would drift from the providers as ADR-0034's
defaults already do.
