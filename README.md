# Workflow Skills

A curated subset of 18 skills + 1 autonomous agent adapted from [mattpocock/skills](https://github.com/mattpocock/skills), organized into a logical workflow pipeline for software engineering with AI agents. Skills are grouped by their phase in the development lifecycle; `setup-elvis-brevi-skills` is the namespaced setup entry point for this distribution. The agent (`afk-issuemerger`) is original to this repo.

## Philosophy

These skills form a **discipline stack** — each one solves a specific problem at a specific phase. They chain together into workflows, but each is independently useful. The core insight: **separate understanding from designing, designing from planning, planning from implementing, and implementing from reviewing.** Mixing phases produces rework.

All skills share a common thread: they are **prompt-driven, not script-driven**. They give the agent a structured process to follow, not a deterministic algorithm to execute. The agent is the executor; the skill is the process.

---

## Installation

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh | bash
```

This opens an interactive menu to choose where to install:

```
¿Dónde instalar las skills y agents del workflow?
  1) Global              → ~/.agents/skills/ + ~/.agents/agents/
  2) Local .agents/      → {proyecto}/.agents/skills/ + {proyecto}/.agents/agents/
  3) Local .opencode/    → {proyecto}/.opencode/skills/ + {proyecto}/.opencode/agent/
  4) Ambas locales       → .agents/ + .opencode/
```

### Non-Interactive Usage

```bash
# Global (available to all projects)
./install.sh --global

# Local to a project
./install.sh --local --target ~/my-project
./install.sh --opencode --target ~/my-project

# Both local directories at once
./install.sh --both

# Preview without changes
./install.sh --dry-run --local

# Uninstall
./install.sh --uninstall --global
```

### Options

| Flag | Description |
|------|-------------|
| `--global` | Install to `~/.agents/skills/` and `~/.agents/agents/` |
| `--local` | Install to `{target}/.agents/skills/` and `{target}/.agents/agents/` |
| `--opencode` | Install to `{target}/.opencode/skills/` and `{target}/.opencode/agent/` |
| `--both` | Install to both local directories |
| `--target DIR` | Project directory (default: cwd) |
| `--uninstall` | Remove installed symlinks |
| `--dry-run` | Preview without making changes |
| `--force` | Overwrite existing without asking |
| `--ref REF` | Branch or tag (default: main) |

### How It Works

1. Clones `elvisbrevi/agent-workflow` to `~/.cache/agent-workflow/`
2. Creates symlinks from the target `skills/` directory to the cached repo
3. Skills are always up-to-date — run `./install.sh` again to pull latest changes

### Install from Specific Version

```bash
# Install from a specific tag or branch
./install.sh --global --ref v1.0.0
./install.sh --local --ref develop
```

---

## Quick Start: Using the Skills

Skills are **prompt templates** that the AI agent reads and follows. They are not executable scripts — the agent is the executor, the skill is the process.

### How Skills Are Discovered

Once installed, the agent automatically reads skill descriptions from the `skills/` directory. When your request matches a skill's trigger phrases, the agent loads and follows it.

### Manual Invocation

You can always invoke a skill explicitly by name:

```
Use the grill-with-docs skill on my current plan
Run the tdd workflow for this feature
Diagnose this bug using the diagnose skill
```

### Auto-Trigger Phrases

Each skill has trigger phrases in its description. Examples:

| Skill | Trigger Phrases |
|-------|----------------|
| **zoom-out** | "zoom out", "map the modules", "what calls this" |
| **grill-with-docs** | "challenge this plan", "interview my design", "validate against domain" |
| **prototype** | "prototype this", "let me play with it", "try a few designs" |
| **implement** | "implement this spec", "build these tickets", "implement the work" |
| **tdd** | "use tdd", "red-green-refactor", "test-driven" |
| **diagnose** | "debug this", "find the bug", "diagnose the issue" |
| **triage** | "show items needing attention", "triage #42", "move to ready-for-agent" |
| **wayfinder** | "map this huge effort", "chart the decisions", "work through this map" |
| **code-review** | "review this diff", "check against spec", "code review" |
| **handoff** | "handoff session", "transfer context", "summarize for next agent" |
| **caveman** | "caveman mode", "talk like caveman", "be brief" |

### Choosing a Workflow

Not sure which workflow to use? Here's a decision guide:

```
Do you understand the code?
  ├─ No  → zoom-out (DISCOVERY)
  └─ Yes
      │
      Are you fixing a bug?
      ├─ Yes → diagnose (DIAGNOSIS)
      └─ No
          │
          Are you refactoring?
          ├─ Yes → improve-codebase-architecture → grill-with-docs → implement (DESIGN→IMPLEMENT)
          └─ No
              │
              Is the effort too large or uncertain for one session?
              ├─ Yes → wayfinder → to-spec → to-tickets (PLANNING)
              └─ No
                  │
                  Do you have a clear plan?
                  ├─ No  → grill-with-docs → prototype (DESIGN)
                  └─ Yes → to-spec → to-tickets → implement (PLANNING→IMPLEMENT)

`implement` uses `tdd` where possible and ends with `code-review`.
Need to switch agents? → handoff (REVIEW)
```

### Example: Full Feature Workflow

```
You: I want to add a notification system to the app

Agent: [loads grill-with-docs] Let me challenge this plan against your domain...
       [asks 10 questions, updates CONTEXT.md]

Agent: [loads prototype] Building a throwaway prototype to validate the state machine...
       [creates prototype, tests it, captures answer, deletes code]

Agent: [loads to-spec] Creating a spec on the configured issue tracker...
       [publishes tracker item #42]

Agent: [loads to-tickets] Decomposing into tracer-bullet tickets...
       [publishes issues #43, #44, #45]

Agent: [loads implement] Implementing issue #43...
       [uses tdd at the agreed seams, typechecks, and runs the test suite]

Agent: [loads code-review] Reviewing the diff against spec and standards...
       [reports findings]
```

---

## Classification

### UTILITY (meta / communication)

Skills that modify how the agent operates, not what it produces.

| Skill | Description | I/O |
|-------|-------------|-----|
| **caveman** | Ultra-compressed communication mode. Drops ~75% of tokens by stripping filler, articles, and pleasantries while preserving technical accuracy. Persists across turns until explicitly disabled. Temporarily exits compression for security warnings and destructive operations. | Reads: nothing. Creates: nothing. Modifies: nothing (communication style only). |
| **grilling** | Relentless one-question-at-a-time interview for stress-testing a plan, decision, or idea. Looks up discoverable facts, leaves decisions to the user, and does not act until shared understanding is confirmed. | Reads: conversation and relevant environment facts. Creates: nothing. Modifies: nothing. |
| **setup-elvis-brevi-skills** | Configures a repository's issue tracker, optional triage-role vocabulary, and domain-document layout for the engineering skills. Supports GitHub, GitLab, Azure Boards, local Markdown, or a documented custom tracker; Azure uses `az` canonically with optional `yp` shortcuts. | Reads: repo configuration, agent instructions, domain docs, installed skills. Creates: `docs/agents/*.md` and optionally `AGENTS.md` or `CLAUDE.md`. Modifies: an existing agent-instructions file when present. |
| **write-a-skill** | Creates new agent skills with proper structure, progressive disclosure, and bundled resources. Enforces SKILL.md under 100 lines, description with triggers, and reference docs one level deep. The meta-skill that bootstraps the workflow itself. | Reads: nothing. Creates: `SKILL.md` + reference docs + optional scripts. Modifies: nothing. |

### DISCOVERY (understand / explore)

Skills for building a mental model of unfamiliar code.

| Skill | Description | I/O |
|-------|-------------|-----|
| **zoom-out** | One-line instruction to the agent: "Go up a layer of abstraction. Give me a map of all relevant modules and callers, using the project's domain glossary vocabulary." The simplest and most frequently used skill. Has `disable-model-invocation: true` — never auto-triggers, always manually invoked. | Reads: `CONTEXT.md`, source code in the area of interest. Creates: nothing. Modifies: nothing (output is conversational). |

### DESIGN (explore / validate ideas)

Skills for shaping ideas before committing to code. This is where expensive mistakes are prevented.

| Skill | Description | I/O |
|-------|-------------|-----|
| **domain-modeling** | Actively sharpens the project's ubiquitous language, challenges ambiguous terms and code contradictions, updates `CONTEXT.md` inline, and offers ADRs only for hard-to-reverse, surprising trade-offs. | Reads: `CONTEXT.md`, `CONTEXT-MAP.md`, ADRs and relevant source code. Creates: domain docs lazily. Modifies: `CONTEXT.md`. |
| **grill-with-docs** | User-invoked composition of `grilling` with `domain-modeling`: stress-tests a plan while maintaining the project's glossary and architectural decisions. | Reads and writes through the two composed skills. |
| **prototype** | Builds throwaway code to answer exactly one question, then deletes everything. Two branches: **LOGIC** (interactive terminal app that drives a state machine through hard cases — pure reducer behind a TUI shell) and **UI** (several radically different UI variations on a single route, toggleable via `?variant=` and a floating bottom bar). The answer is captured in a commit/ADR/issue; the code is deleted. | Reads: source code in the area, existing routing/tooling conventions. Creates: prototype files + task runner script + `NOTES.md`. Modifies: `package.json` (temporarily, for run script). Then **deletes everything** except the captured answer. |
| **improve-codebase-architecture** | Three-phase architectural diagnosis: (1) explore codebase for shallow modules, leakage, poor locality; (2) generate a self-contained HTML report with Tailwind+Mermaid diagrams showing before/after for each deepening candidate; (3) grilling loop to design the chosen candidate's new shape. Uses a precise architectural vocabulary (module, interface, seam, adapter, depth, leverage, locality) defined in `LANGUAGE.md`. | Reads: `CONTEXT.md`, `docs/adr/*.md`, entire codebase (via explore sub-agent). Creates: `/tmp/architecture-review-<timestamp>.html` (visual report). Modifies: `CONTEXT.md` (if deepening names new domain concepts). |

**Associated docs for improve-codebase-architecture:**
- **LANGUAGE.md** — Glossary of 8 mandatory architectural terms. Prohibits synonyms (component, service, API, boundary). Defines the deletion test, the interface-as-test-surface principle, and the one-adapter-vs-two-adapters seam rule.
- **DEEPENING.md** — How to safely deepen modules based on their dependency category: in-process (always deepenable), local-substitutable (stand-in required), remote-but-owned (ports & adapters), true external (mock). Testing strategy: replace old shallow tests, don't layer.
- **HTML-REPORT.md** — Full scaffold for the visual report. Mermaid for graph-shaped diagrams; hand-built divs/SVG for editorial visuals (mass diagrams, cross-sections). Style rules: editorial, not corporate; 320px diagram height; glossary-only vocabulary.
- **INTERFACE-DESIGN.md** — Parallel sub-agent pattern for exploring alternative interfaces (Design It Twice). Spawns 3+ sub-agents with different constraints, compares by depth, locality, and seam placement.

### PLANNING (document / decompose)

Skills for turning ideas into actionable, agent-ready work items.

| Skill | Description | I/O |
|-------|-------------|-----|
| **to-spec** | Synthesizes the current conversation into a spec without re-interviewing the user. Confirms the highest practical testing seams, then records the problem, solution, user stories, implementation and testing decisions, out-of-scope, and notes. Publishes a **single tracker item** with the `ready-for-agent` role. | Reads: conversation context, codebase, `CONTEXT.md`, `docs/adr/*.md`, tracker configuration. Creates: 1 item on tracker. Modifies: nothing. |
| **to-tickets** | Decomposes a plan, spec, or conversation into **tracer-bullet tickets** with explicit blocking edges. Supports local ticket files or a real tracker, keeps each slice within one fresh context window, and uses expand–contract sequencing for wide refactors. Quizzes the user before publishing in dependency order. | Reads: conversation context or referenced spec/issue, codebase (optional), `CONTEXT.md`, `docs/adr/*.md`, tracker configuration. Creates: N local ticket files or tracker issues. Modifies: nothing (never closes parent). |
| **triage** | Moves tracker items through category and state roles, verifies claims against the codebase, and writes durable agent briefs. On Azure Boards it uses the configured Tags, fields, states, and discussions while preserving unrelated Tags. | Reads: tracker items and discussion, code, domain docs, ADRs, `.out-of-scope/`. Creates: tracker comments and optional out-of-scope records. Modifies: tracker roles/states and rejected-enhancement records. |
| **wayfinder** | Maps work too large for one session as a parent map plus decision tickets, advances the open frontier one decision at a time, and records durable resolutions. On Azure Boards it uses Parent/Child and Predecessor/Successor relations. | Reads: map, child tickets, dependencies, domain docs. Creates: map and decision work items. Modifies: claims, discussions, states, relations, and the map index. |

**Key distinction:** `wayfinder` resolves uncertainty before execution, `to-spec` produces one panoramic specification (the compass), `to-tickets` produces N executable tickets with explicit blocking edges (the steps), and `triage` controls readiness at tracker intake.

### IMPLEMENTATION (write code)

Skills for producing tested, production-ready code.

| Skill | Description | I/O |
|-------|-------------|-----|
| **implement** | Implements a spec or ticket set, uses `tdd` where possible at pre-agreed seams, runs focused and full validation, invokes `code-review`, then commits to the current branch. | Reads: spec or tickets, codebase, test and typecheck commands. Creates: implementation, tests, and a commit. Modifies: source and tests. |
| **tdd** | Runs the red → green implementation loop one vertical slice at a time. Tests must verify behavior through pre-agreed public seams, use independent expected values, and avoid implementation coupling, tautologies, and horizontal slicing. Refactoring belongs to `code-review`, outside the loop. | Reads: `CONTEXT.md`, ADRs, existing tests, source code. Creates: one test and its minimal implementation per cycle. Modifies: tests and source code. |

**Associated docs for tdd:**
- **tests.md** — Good tests (integration-style, observable behavior, independent expected values) vs bad tests (mock internals, test private methods, tautological assertions).
- **mocking.md** — Mock at system boundaries only (external APIs, DB, time, filesystem). Never mock own modules or internal collaborators. Prefer dependency injection and SDK-style interfaces over generic fetchers.

### DIAGNOSIS (fix bugs)

Skills for finding and fixing defects with scientific rigor.

| Skill | Description | I/O |
|-------|-------------|-----|
| **diagnose** | Six-phase scientific debugging process. Phase 1 (feedback loop) is 90% of the skill — 10 methods ranked from failing test to HITL bash script. Phase 2: reproduce. Phase 3: 3-5 ranked falsifiable hypotheses. Phase 4: instrument one variable at a time (debugger > targeted logs > never log-everything). Phase 5: regression test before fix, but only at a correct seam. Phase 6: cleanup instrumentation, post-mortem in commit message, hand-off to improve-codebase-architecture if architecture prevented a good test seam. | Reads: source code, tests, logs, error traces. Creates: regression test (at correct seam), `NOTES.md` (post-mortem). Modifies: source code (the fix). Deletes: all `[DEBUG-*]` instrumentation, throwaway prototypes. |

**Associated docs for diagnose:**
- **scripts/hitl-loop.template.sh** — Last-resort bash template for human-in-the-loop debugging. Provides `step` (show instruction, wait for Enter) and `capture` (ask question, read response) helpers. Agent runs the script; human follows terminal prompts. Captured values printed as `KEY=VALUE` for the agent to parse.

### REVIEW (validate / hand over)

Skills for validating changes and preserving session continuity.

| Skill | Description | I/O |
|-------|-------------|-----|
| **code-review** | Current upstream two-axis review: checks the diff against documented standards plus a Fowler smell baseline, and independently against the originating spec. Validates the fixed point before launching parallel sub-agents and keeps findings separated by axis. | Reads: diff, commits, issue/spec, tracker configuration, documented standards. Creates: nothing. Modifies: nothing. |
| **handoff** | Compresses the current conversation into a transfer document for another agent. Includes suggested skills for the next session. References existing specs, plans, ADRs, issues, commits, and diffs by path/URL rather than duplicating them. Redacts sensitive information. Saves to the OS temp directory, not the workspace. | Reads: conversation context. Creates: handoff document in OS temp directory. Modifies: nothing. |

---

## Complete Workflows

### WF-1: New Feature (full happy path)

```
UTILITY:   (caveman — optional, enable if token-constrained)

DISCOVERY: (zoom-out — skip if you already know the code)

DESIGN:    grill-with-docs ──→ prototype (LOGIC)
                │                    │
                │   sharpens terms   │   validates state machine
                ▼                    ▼
           CONTEXT.md          throwaway TUI
           (updated)           (deleted after answer)

PLANNING:  to-spec ──→ to-tickets
                │           │
                │  1 spec   │  N tickets (vertical slices)
                ▼           ▼
           Tracker item   Child tracker items
           #100 (spec)    #101, #102, #103...

IMPLEMENT: implement ──→ tdd ──→ tests + code (1 slice at a time)

REVIEW:    code-review ──→ Standards + Spec report
                │
                │   (if changing agents mid-stream)
                ▼
           handoff ──→ transfer doc for next agent
```

### WF-2: Bug in Unfamiliar Code

```
DISCOVERY: zoom-out ──→ map of modules + callers

DIAGNOSIS: diagnose
              │
              ├── Phase 1: feedback loop (failing test)
              ├── Phase 2: reproduce
              ├── Phase 3: 3-5 hypotheses
              ├── Phase 4: instrument
              ├── Phase 5: fix + regression test
              └── Phase 6: cleanup + post-mortem
                             │
                             │   (if architecture prevented good test)
                             ▼
                        improve-codebase-architecture

REVIEW:    code-review ──→ verify fix against spec and standards
```

### WF-3: Structural Refactor

```
DISCOVERY: zoom-out ──→ module map

DESIGN:    improve-codebase-architecture
              │
              ├── Explore codebase
              ├── Generate /tmp/architecture-review-*.html
              ├── User picks candidate
              └── Grilling loop → design new shape
                     │
                     ├── Updates CONTEXT.md
                     └── Optionally creates ADR

DESIGN:    grill-with-docs ──→ validate new design against domain

PLANNING:  to-tickets ──→ N refactor tickets

IMPLEMENT: implement ──→ refactor with test safety net

REVIEW:    code-review ──→ verify refactor matches design
```

### WF-4: Early-Stage Idea (no code yet)

```
DESIGN:    grill-with-docs ──→ clarify domain terms
                │
                ▼
           prototype (UI or LOGIC) ──→ validate concept fast
                │
                ▼
           (capture answer in NOTES.md, delete prototype)

PLANNING:  to-spec ──→ document as a formal spec
                │
                ▼
           to-tickets ──→ decompose into tickets
                │
                ▼
           implement ──→ tdd ──→ code-review
```

### WF-5: Multi-Agent Session

```
[Agent A]
  grill-with-docs ──→ to-spec ──→ to-tickets
                                       │
                                       ▼
                                  handoff ──→ saves to /tmp/
                                                  │
[Agent B]                                         │
  reads handoff doc ◄─────────────────────────────┘
       │
       ▼
  implement ──→ tdd ──→ code-review
```

### WF-6: Token-Constrained Session

```
caveman ──→ [any workflow above]
  │
  │   Active for every response until "stop caveman"
  │   Temporarily exits for security warnings
  │   Cuts ~75% tokens
  ▼
```

---

## Skill I/O Summary

| Skill | Reads | Creates | Modifies | Deletes |
|-------|-------|---------|----------|---------|
| caveman | — | — | — | — |
| grilling | conversation, environment facts | — | — | — |
| setup-elvis-brevi-skills | repo config, agent instructions, domain docs | `docs/agents/*.md`, optionally agent instructions | existing `AGENTS.md` or `CLAUDE.md` | — |
| write-a-skill | — | SKILL.md + docs | — | — |
| zoom-out | CONTEXT.md, code | — | — | — |
| domain-modeling | CONTEXT.md, ADRs, code | CONTEXT.md, ADRs | CONTEXT.md | — |
| grill-with-docs | CONTEXT.md, ADRs, code | CONTEXT.md, ADRs | CONTEXT.md | — |
| prototype | code, tooling | prototype files, script, NOTES.md | package.json (temp) | prototype files |
| improve-codebase-architecture | CONTEXT.md, ADRs, code | HTML report in /tmp | CONTEXT.md | — |
| wayfinder | destination, tracker map, decision tickets | map and child work items | claims, discussions, states, relations, map index | — |
| to-spec | conversation, code, CONTEXT.md | 1 spec issue | — | — |
| to-tickets | conversation or referenced spec/issue, CONTEXT.md | N local files or tracker issues | — | — |
| triage | tracker items, code, domain docs, `.out-of-scope/` | comments, agent briefs, optional rejection records | roles, states, rejection records | — |
| implement | spec or tickets, code, validation commands | implementation, tests, commit | source and tests | — |
| tdd | CONTEXT.md, ADRs, tests, code | tests + code | may delete old tests | — |
| diagnose | code, tests, logs | regression test, NOTES.md | code (fix) | [DEBUG-*], prototypes |
| code-review | diff, commits, spec, standards | — | — | — |
| handoff | conversation | handoff doc in /tmp | — | — |

---

## Dependency Graph

```
write-a-skill ◄── (bootstraps new skills, optional)

caveman ◄──────── (wraps any workflow, optional)

zoom-out ──────── (entry point when code is unfamiliar)
    │
    ▼
grill-with-docs ───── prototype
    │                      │
    │   (domain clarity)    │   (concept validation)
    │                      │
    ├──────────────────────┤
    │                      │
    ▼                      ▼
improve-codebase-architecture
    │   (structural diagnosis)
    │
    ├──────────────────────┐
    │                      │
    ▼                      ▼
wayfinder ───► to-spec ─────► to-tickets
                                  │
                                  ▼
                             implement
                                  │
                                  ▼
                                tdd
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
                diagnose                  code-review
                    │                           │
                    └─────────────┬─────────────┘
                                  ▼
                               handoff
```

---

## Glossary of Key Concepts

**Vertical slice (tracer bullet):** A thin implementation that cuts through ALL layers (schema, API, UI, tests) end-to-end. Each slice is independently demoable. Contrasts with horizontal slicing (doing all of one layer first).

**HITL (Human In The Loop):** A task that requires human judgment — architectural decisions, design reviews, external access. Contrasts with AFK (Away From Keyboard), which an agent can complete autonomously.

**Deep module:** A module with a small interface and a large implementation. High leverage for callers, high locality for maintainers. The ideal building block.

**Shallow module:** A module whose interface is nearly as complex as its implementation. Pass-throughs, thin wrappers, one-liners that add no abstraction. The deletion test reveals them.

**Seam:** A place where behavior can be altered without editing in place. The location where an interface lives. From Michael Feathers' "Working Effectively with Legacy Code."

**CONTEXT.md:** A domain glossary file. Defines the canonical terms for a project's domain concepts and explicitly lists synonyms to avoid. Not a spec, not a scratch pad, not implementation details.

**ADR (Architecture Decision Record):** A short document (often one paragraph) recording that a decision was made and why. Numbered sequentially in `docs/adr/`. Only created when the decision is hard to reverse, surprising without context, and the result of a real trade-off.

---

## File Tree

```
workflow/
├── README.md
├── install.sh
│
├── utility/
│   ├── caveman/
│   │   └── SKILL.md
│   ├── grilling/
│   │   └── SKILL.md
│   ├── setup-elvis-brevi-skills/
│   │   ├── SKILL.md
│   │   ├── agents/openai.yaml
│   │   ├── domain.md
│   │   ├── issue-tracker-azure-devops.md
│   │   ├── issue-tracker-github.md
│   │   ├── issue-tracker-gitlab.md
│   │   ├── issue-tracker-local.md
│   │   └── triage-labels.md
│   └── write-a-skill/
│       └── SKILL.md
│
├── discovery/
│   └── zoom-out/
│       └── SKILL.md
│
├── design/
│   ├── domain-modeling/
│   │   ├── SKILL.md
│   │   ├── ADR-FORMAT.md
│   │   └── CONTEXT-FORMAT.md
│   ├── grill-with-docs/
│   │   ├── SKILL.md
│   │   ├── ADR-FORMAT.md
│   │   └── CONTEXT-FORMAT.md
│   ├── prototype/
│   │   ├── SKILL.md
│   │   ├── LOGIC.md
│   │   └── UI.md
│   └── improve-codebase-architecture/
│       ├── SKILL.md
│       ├── LANGUAGE.md
│       ├── DEEPENING.md
│       ├── HTML-REPORT.md
│       └── INTERFACE-DESIGN.md
│
├── planning/
│   ├── triage/
│   │   ├── SKILL.md
│   │   ├── AGENT-BRIEF.md
│   │   ├── OUT-OF-SCOPE.md
│   │   └── agents/openai.yaml
│   ├── wayfinder/
│   │   ├── SKILL.md
│   │   └── agents/openai.yaml
│   ├── to-spec/
│   │   ├── SKILL.md
│   │   └── agents/openai.yaml
│   └── to-tickets/
│       ├── SKILL.md
│       └── agents/openai.yaml
│
├── implementation/
│   ├── implement/
│   │   ├── SKILL.md
│   │   └── agents/openai.yaml
│   └── tdd/
│       ├── SKILL.md
│       ├── agents/openai.yaml
│       ├── tests.md
│       └── mocking.md
│
├── diagnosis/
│   └── diagnose/
│       ├── SKILL.md
│       └── scripts/
│           └── hitl-loop.template.sh
│
├── review/
│   ├── code-review/
│   │   ├── SKILL.md
│   │   └── agents/openai.yaml
│   └── handoff/
│       ├── SKILL.md
│       └── agents/openai.yaml
│
└── agent/
    └── afk-issuemerger/
        ├── AGENT.md
        └── REFERENCE.md
```

---

## Agents

In addition to the 18 prompt-driven skills above, this repo ships one **autonomous subagent** — a different kind of artifact:

| Type | What it is | Where it lives |
|------|-----------|----------------|
| **Skill** (18) | A prompt template that augments a session. The agent reads it and follows the process. | `category/<skill>/SKILL.md` |
| **Agent** (1) | A self-contained autonomous loop that runs in its own session, takes actions, and clears context between iterations. | `agent/<name>/AGENT.md` |

### `afk-issuemerger` — autonomous issue drainer

Picks the next open, non-blocked issue from GitHub / Azure DevOps / `todo.md`, implements it end-to-end with the `tdd` skill, squash-merges the result into `main`, pushes, closes the issue, clears context with `/clear`, and starts the next iteration. Stops when the queue is empty or when a HITL slice is encountered.

**Invoke** with `/afk-issuemerger` (opencode) or natural language: *"drain the issue queue"*, *"implement the pending issues"*, *"work through the backlog"*.

**Safety** — this agent performs destructive operations: `git push` to the base branch, closes issues, edits `todo.md`. Each iteration's actions are auditable via the resulting commit and issue comment, but a misconfigured run can pollute `main`. Always run from a clean working tree and confirm the base branch before launching.

See [agent/afk-issuemerger/AGENT.md](agent/afk-issuemerger/AGENT.md) for the full per-iteration flow and [agent/afk-issuemerger/REFERENCE.md](agent/afk-issuemerger/REFERENCE.md) for per-source CLI commands.
