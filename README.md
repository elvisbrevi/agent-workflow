<img width="1280" height="640" alt="banner" src="https://github.com/user-attachments/assets/3a8a2e6d-a721-4aed-af24-6e3f159a0461" />

# agent-workflow

Reusable AI-agent workflows for software engineering: **19 prompt-driven
skills** and one executable agent,
[`lazy-workflow`](agent/lazy-workflow/README.md).

Skills describe a process that an AI session follows. The agent is an
executable workflow that invokes OpenCode and can read Azure DevOps HU data.

## Install

The installer refreshes its managed cache and reconciles repository-owned
links while preserving files and links owned by other tools:

```bash
curl -fsSL https://raw.githubusercontent.com/elvisbrevi/agent-workflow/main/install.sh \
  | bash -s -- --all-global
```

Narrower modes include `--claude-global`, `--global`, `--local`,
`--opencode`, and `--both`. Use `--target <directory>` for local modes
and run `./install.sh --help` for the complete option list.

## Skills

Skills are stored as `SKILL.md` files. Invoke them explicitly with the
client syntax or let the client select them when their trigger matches.

| Phase | Skills | Use when |
|---|---|---|
| Discovery | `zoom-out` | The code or problem is unfamiliar |
| Design | `domain-modeling`, `grill-with-docs`, `prototype`, `improve-codebase-architecture` | Terms, decisions, prototypes, or structure need work |
| Planning | `wayfinder`, `to-spec`, `to-tickets`, `triage` | Work must be mapped, specified, decomposed, or classified |
| Implementation | `implement`, `tdd` | A ticket or specification is ready to build |
| Diagnosis | `diagnose` | A defect needs reproduction and a regression test |
| Review | `code-review`, `handoff` | Changes need review or session transfer |
| Utility | `caveman`, `grilling`, `ponytail`, `setup-elvis-brevi-skills`, `write-a-skill` | Communication, interviewing, setup, or skill authoring |

Skills with `disable-model-invocation: true` are explicit-only. See each
`SKILL.md` for its trigger and output contract.

## Agent

| Agent | Purpose | Source |
|---|---|---|
| `lazy-workflow` | Plans, delivers, and inspects Azure HUs | [`agent/lazy-workflow/`](agent/lazy-workflow/) |

Install dependencies and run it from its directory:

```bash
cd agent/lazy-workflow
bun install
bun run main.ts plan --hu 23438 --working-directory /path/to/repository
```

To drain the HU's direct delivery tickets one at a time:

```bash
bun run main.ts code --hu 23438 --working-directory /path/to/repository
```

To recover the exact interrupted ticket from its repository checkpoint:

```bash
bun run main.ts code --session <session-id> --prompt continue
```

To query HU data without starting OpenCode:

```bash
bun run main.ts hu-info --hu 23438
```

See [the agent README](agent/lazy-workflow/README.md) for behavior and
structure.

## Repository documentation

- [`AGENTS.md`](AGENTS.md): modification map and validation rules.
- [`CONTEXT.md`](CONTEXT.md): domain vocabulary.
- [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md): tracker conventions.
- [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md): canonical labels.

## Tests

```bash
(cd agent/lazy-workflow && bun test)
bash tests/install_test.sh
git diff --check
```
