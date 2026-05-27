# Workflow Skills

A curated subset of 12 skills from [mattpocock/skills](https://github.com/mattpocock/skills), organized into a logical workflow pipeline for software engineering with AI agents. Each skill is copied verbatim from the original repository, grouped by its phase in the development lifecycle.

## Philosophy

These skills form a **discipline stack** — each one solves a specific problem at a specific phase. They chain together into workflows, but each is independently useful. The core insight: **separate understanding from designing, designing from planning, planning from implementing, and implementing from reviewing.** Mixing phases produces rework.

All skills share a common thread: they are **prompt-driven, not script-driven**. They give the agent a structured process to follow, not a deterministic algorithm to execute. The agent is the executor; the skill is the process.

---

## Installation

### Quick Install

```bash
bash <(curl -sSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh)
```

This opens an interactive menu to choose where to install:

```
¿Dónde instalar las skills del workflow?
  1) Global              → ~/.agents/skills/
  2) Local .agents/      → {proyecto}/.agents/skills/
  3) Local .opencode/    → {proyecto}/.opencode/skills/
  4) Ambas locales       → {proyecto}/.agents/skills/ + {proyecto}/.opencode/skills/
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
| `--global` | Install to `~/.agents/skills/` |
| `--local` | Install to `{target}/.agents/skills/` |
| `--opencode` | Install to `{target}/.opencode/skills/` |
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
| **tdd** | "use tdd", "red-green-refactor", "test-driven" |
| **diagnose** | "debug this", "find the bug", "diagnose the issue" |
| **review** | "review this diff", "check against spec", "code review" |
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
          ├─ Yes → improve-codebase-architecture → grill-with-docs → tdd (DESIGN→IMPLEMENT)
          └─ No
              │
              Do you have a clear plan?
              ├─ No  → grill-with-docs → prototype (DESIGN)
              └─ Yes → to-prd → to-issues → tdd (PLANNING→IMPLEMENT)

Always end with: review (REVIEW)
Need to switch agents? → handoff (REVIEW)
```

### Example: Full Feature Workflow

```
You: I want to add a notification system to the app

Agent: [loads grill-with-docs] Let me challenge this plan against your domain...
       [asks 10 questions, updates CONTEXT.md]

Agent: [loads prototype] Building a throwaway prototype to validate the state machine...
       [creates prototype, tests it, captures answer, deletes code]

Agent: [loads to-prd] Creating a PRD as a GitHub issue...
       [publishes issue #42]

Agent: [loads to-issues] Decomposing into vertical slices...
       [publishes issues #43, #44, #45]

Agent: [loads tdd] Implementing issue #43 with TDD...
       [writes test, implements, refactors, repeats]

Agent: [loads review] Reviewing the diff against spec and standards...
       [reports findings]
```

---

## Classification

### UTILITY (meta / communication)

Skills that modify how the agent operates, not what it produces.

| Skill | Description | I/O |
|-------|-------------|-----|
| **caveman** | Ultra-compressed communication mode. Drops ~75% of tokens by stripping filler, articles, and pleasantries while preserving technical accuracy. Persists across turns until explicitly disabled. Temporarily exits compression for security warnings and destructive operations. | Reads: nothing. Creates: nothing. Modifies: nothing (communication style only). |
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
| **grill-with-docs** | Relentless one-question-at-a-time interview that challenges a plan against the existing domain model (`CONTEXT.md`) and architectural decisions (`docs/adr/`). Forces terminological precision, cross-references with actual code, stress-tests with concrete scenarios, and updates domain documentation inline as decisions crystallize. The output is sharper language and a validated plan — not code. | Reads: `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/*.md`, relevant source code. Creates: `CONTEXT.md` (lazily, when first term resolved), `docs/adr/NNNN-slug.md` (only when decision is hard to reverse, surprising, and a real trade-off). Modifies: `CONTEXT.md` (adds/refines terms inline). |
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
| **to-prd** | Synthesizes the current conversation context into a Product Requirements Document without further interviews. Produces: problem statement, solution, extensive user stories, implementation decisions, testing decisions, out-of-scope. Publishes as a **single issue** on the project tracker with the `ready-for-agent` label. | Reads: conversation context, codebase, `CONTEXT.md`, `docs/adr/*.md`, `docs/agents/issue-tracker.md`. Creates: 1 issue on tracker. Modifies: nothing. |
| **to-issues** | Decomposes a plan/PRD into **multiple vertical-slice issues** using tracer bullets. Each slice cuts through ALL layers end-to-end and is independently demoable. Classifies each as HITL (needs human) or AFK (autonomous). Quizzes the user on granularity, dependencies, and classification before publishing in dependency order. | Reads: conversation context + parent issue, codebase (optional), `CONTEXT.md`, `docs/adr/*.md`, `docs/agents/`. Creates: N issues on tracker. Modifies: nothing (never closes parent). |

**Key distinction:** `to-prd` produces 1 panoramic issue (the compass). `to-issues` produces N executable tickets (the steps). Both go to the issue tracker, never to local files.

### IMPLEMENTATION (write code)

Skills for producing tested, production-ready code.

| Skill | Description | I/O |
|-------|-------------|-----|
| **tdd** | Test-Driven Development with a strict red-green-refactor loop. Explicitly prohibits horizontal slicing (all tests first, then all code). Uses tracer bullets: 1 test → 1 implementation → repeat. Tests must verify behavior through public interfaces, never implementation details. Planning phase confirms interface design and behavior priorities before writing. | Reads: `CONTEXT.md`, `docs/adr/*.md`, existing tests (for pattern matching), source code. Creates: test files + implementation code. Modifies: may delete old shallow unit tests replaced by new interface-level tests. |

**Associated docs for tdd:**
- **tests.md** — Good tests (integration-style, observable behavior, survive refactors) vs bad tests (mock internals, test private methods, break on rename). Concrete TypeScript examples of both.
- **mocking.md** — Mock at system boundaries only (external APIs, DB, time, filesystem). Never mock own modules or internal collaborators. Prefer dependency injection and SDK-style interfaces over generic fetchers.
- **deep-modules.md** — Visual explanation of deep (small interface + large implementation) vs shallow (large interface + thin implementation) modules, from Ousterhout's "A Philosophy of Software Design."
- **interface-design.md** — Three rules for testable interfaces: accept dependencies, return results, keep surface area small.
- **refactoring.md** — Post-cycle refactor candidates: duplication, long methods, shallow modules, feature envy, primitive obsession.

### DIAGNOSIS (fix bugs)

Skills for finding and fixing defects with scientific rigor.

| Skill | Description | I/O |
|-------|-------------|-----|
| **diagnose** | Six-phase scientific debugging process. Phase 1 (feedback loop) is 90% of the skill — 10 methods ranked from failing test to HITL bash script. Phase 2: reproduce. Phase 3: 3-5 ranked falsifiable hypotheses. Phase 4: instrument one variable at a time (debugger > targeted logs > never log-everything). Phase 5: regression test before fix, but only at a correct seam. Phase 6: cleanup instrumentation, post-mortem in commit message, hand-off to improve-codebase-architecture if architecture prevented a good test seam. | Reads: source code, tests, logs, error traces. Creates: regression test (at correct seam), `NOTES.md` (post-mortem). Modifies: source code (the fix). Deletes: all `[DEBUG-*]` instrumentation, throwaway prototypes. |

**Associated docs for diagnose:**
- **scripts/hitl-loop.template.sh** — Last-resort bash template for human-in-the-loop debugging. Provides `step` (show instruction, wait for Enter) and `capture` (ask question, read response) helpers. Agent runs the script; human follows terminal prompts. Captured values printed as `KEY=VALUE` for the agent to parse.

### REVIEW (validate / hand over)

Skills for quality assurance and session continuity.

| Skill | Description | I/O |
|-------|-------------|-----|
| **review** | Two-axis parallel review of a git diff: **Standards** (does code follow documented repo conventions?) and **Spec** (does code faithfully implement the originating issue/PRD?). Runs both as parallel sub-agents to prevent context pollution. Reports findings independently — a change can pass one axis and fail the other, and reporting them together would mask this. | Reads: git diff, commit log, issue/PRD, `CLAUDE.md`/`AGENTS.md`, `CONTRIBUTING.md`, `docs/adr/`, config files. Creates: nothing. Modifies: nothing (reports findings conversationally). |
| **handoff** | Compresses the current conversation into a transfer document for another agent. Includes suggested skills for the next session. References external artifacts (PRDs, issues, ADRs) by path/URL rather than duplicating. Redacts sensitive information. Saves to OS temp directory, not the workspace. | Reads: conversation context. Creates: handoff document in OS temp directory. Modifies: nothing. |

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

PLANNING:  to-prd ──→ to-issues
                │           │
                │  1 issue  │  N issues (vertical slices)
                ▼           ▼
           GitHub Issue   GitHub Issues
           #100 (PRD)     #101, #102, #103...

IMPLEMENT: tdd ──→ tests + code (1 slice at a time)

REVIEW:    review ──→ Standards + Spec report
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

REVIEW:    review ──→ verify fix against spec
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

PLANNING:  to-issues ──→ N refactor tickets

IMPLEMENT: tdd ──→ refactor with test safety net

REVIEW:    review ──→ verify refactor matches design
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

PLANNING:  to-prd ──→ document as formal PRD
                │
                ▼
           to-issues ──→ decompose into tickets
                │
                ▼
           tdd ──→ implement
```

### WF-5: Multi-Agent Session

```
[Agent A]
  grill-with-docs ──→ to-prd ──→ to-issues
                                       │
                                       ▼
                                  handoff ──→ saves to /tmp/
                                                  │
[Agent B]                                         │
  reads handoff doc ◄─────────────────────────────┘
       │
       ▼
  tdd ──→ review
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
| write-a-skill | — | SKILL.md + docs | — | — |
| zoom-out | CONTEXT.md, code | — | — | — |
| grill-with-docs | CONTEXT.md, ADRs, code | CONTEXT.md, ADRs | CONTEXT.md | — |
| prototype | code, tooling | prototype files, script, NOTES.md | package.json (temp) | prototype files |
| improve-codebase-architecture | CONTEXT.md, ADRs, code | HTML report in /tmp | CONTEXT.md | — |
| to-prd | conversation, code, CONTEXT.md | 1 issue | — | — |
| to-issues | conversation, parent issue, CONTEXT.md | N issues | — | — |
| tdd | CONTEXT.md, ADRs, tests, code | tests + code | may delete old tests | — |
| diagnose | code, tests, logs | regression test, NOTES.md | code (fix) | [DEBUG-*], prototypes |
| review | diff, commits, spec, standards | — | — | — |
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
to-prd ──────► to-issues
    │              │
    │   (1 issue)  │   (N issues)
    │              │
    ├──────────────┘
    │
    ▼
  tdd
    │
    ├──────────────────────┐
    │                      │
    ▼                      ▼
diagnose                review
    │                      │
    │   (when broken)      │   (when done)
    │                      │
    └──────────────────────┘
              │
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
│   └── write-a-skill/
│       └── SKILL.md
│
├── discovery/
│   └── zoom-out/
│       └── SKILL.md
│
├── design/
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
│   ├── to-prd/
│   │   └── SKILL.md
│   └── to-issues/
│       └── SKILL.md
│
├── implementation/
│   └── tdd/
│       ├── SKILL.md
│       ├── tests.md
│       ├── mocking.md
│       ├── deep-modules.md
│       ├── interface-design.md
│       └── refactoring.md
│
├── diagnosis/
│   └── diagnose/
│       ├── SKILL.md
│       └── scripts/
│           └── hitl-loop.template.sh
│
└── review/
    ├── review/
    │   └── SKILL.md
    └── handoff/
        └── SKILL.md
```
