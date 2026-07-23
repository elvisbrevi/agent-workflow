# Issue Tracker: Azure Boards

Work is tracked as Azure Boards work items in:

- **Organization:** `https://dev.azure.com/<organization>`
- **Project:** `<project>`
- **Default Area Path:** `<project or area path>`
- **Default Iteration Path:** `<project or iteration path>`
- **Wayfinder claim identity:** `<Azure DevOps identity>`

## Tooling

Use the Azure CLI with the `azure-devops` extension as the canonical interface:

```bash
az login
az extension add --name azure-devops
az devops configure --defaults organization=https://dev.azure.com/<organization> project="<project>"
```

`az` is required for generic work-item creation, WIQL queries, discussions, pull requests, and arbitrary work-item relations. `yp` may be used as an optional convenience layer for supported Azure DevOps operations, but it is not required and must fall back to `az` when an operation is unavailable.

Azure CLI `--query` expressions use JMESPath. Use `jq` only as an optional second-stage formatter for JSON output; it is not required for Azure Boards access.

## Project mapping

Fill this table with the process vocabulary used by this project before creating work:

| Semantic role | Azure Boards representation |
| --- | --- |
| Spec or wayfinder map | Work item type: `<Feature, Epic, User Story, Product Backlog Item, ...>` |
| Executable ticket or decision | Work item type: `<User Story, Product Backlog Item, Task, ...>` |
| Bug | Work item type: `<Bug>` |
| Ready/open | State: `<New, Active, Approved, ...>` |
| Closed/done | State: `<Closed, Done, Resolved, ...>` |
| Triage roles | Tags (recommended), or `<custom field / states>` |
| Category roles | Tags (recommended), or `<work item type / custom field>` |

The canonical triage-role mapping lives in `docs/agents/triage-labels.md`. With Tags, preserve every unrelated value in `System.Tags`: read the current field, remove only conflicting canonical role values, add the new value, and write back the merged set.

## Core operations

Use the configured defaults unless a command explicitly needs `--organization` or `--project`.

```bash
# Create and read
az boards work-item create --type "<type>" --title "<title>" --description "<markdown>"
az boards work-item show --id <id> --expand relations

# Query
az boards query --wiql "<WIQL>"

# Add a discussion entry or update fields
az boards work-item update --id <id> --discussion "<markdown>"
az boards work-item update --id <id> --fields "System.State=<closed-state>"

# Discover supported relation names
az boards work-item relation list-type
```

Use `az repos pr list`, `az repos pr show`, and related `az repos pr` commands when pull requests are configured as a triage request surface.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external Azure Repos pull requests as feature requests; `/triage` reads this flag.)_

When enabled, record how an external contributor is distinguished from a project member, then use `az repos pr list/show` for metadata and diff context. Azure Boards work-item roles do not automatically apply to PRs, so also record whether the triage outcome belongs on a linked work item or in the PR discussion.

## Hierarchy and blocking

Use native Azure Boards relations:

- Parent/Child expresses a spec or map containing its tickets.
- Predecessor/Successor expresses dependency order.

Create all work items first, then wire relations in a second pass:

```bash
# Parent contains child
az boards work-item relation add --id <parent-id> --relation-type Child --target-id <child-id>

# A blocks B: B is A's successor
az boards work-item relation add --id <A-id> --relation-type Successor --target-id <B-id>
```

The inverse blocking view is `Predecessor` from B to A. Check `az boards work-item relation list-type` if a project's process or CLI version exposes localized or qualified relation names.

## `to-spec` and `to-tickets`

- `to-spec` creates one work item using the configured spec type.
- `to-tickets` creates work items using the configured executable-ticket type.
- Link each executable ticket to the spec with Parent/Child.
- Publish in dependency order, then add Successor relations from each blocker to the work it unlocks.
- Never encode dependency order only in prose when native relations are available.

## Triage operations

- Read the full work item, discussion, Tags, relations, author, and dates before recommending a transition.
- Apply exactly one canonical state role and one category role using the configured representation.
- With Tags, preserve all unrelated Tags.
- Post triage notes and agent briefs through `--discussion`.
- Close a `wontfix` item using the configured closed state after posting the reason.
- If pull requests are in scope, use `az repos pr` for their metadata and diff context, while keeping the triage outcome on the configured request surface.

## Wayfinding operations

- Create the map with the configured map work-item type and the `wayfinder:map` Tag.
- Create decision tickets with the configured ticket type and one `wayfinder:<type>` Tag: `research`, `prototype`, `grilling`, or `task`.
- Link map and tickets with Parent/Child.
- Represent blocking with Successor/Predecessor relations.
- Claim a ticket by assigning `System.AssignedTo` to the configured identity before doing work.
- To find the frontier, inspect the map's child relations, then keep only children that are open, unassigned, and whose predecessor work items are closed.
- Record each resolution in a discussion entry, move the ticket to the configured closed state, and append its linked one-line result to the map's `Decisions so far`.

Azure Boards does not expose the complete wayfinder frontier as one universal command across all process customizations. Combine `az boards work-item relation show` or `show --expand relations` with `az boards work-item show`/`query`, using the mapping in this file.

## Optional `yp` shortcuts

When `yp` is installed and authenticated, it may simplify supported reads, child-task operations, attachments, or links under `yp azure-devops`. Use `yp --help` and the relevant subcommand help as the source of truth for the installed version.

Keep `az` as the fallback for:

- Creating arbitrary work-item types
- WIQL queries
- Adding arbitrary Parent/Child or Predecessor/Successor relations
- Pull-request operations when the exact repository and branches are known

Do not make project configuration depend on `yp`; it is a convenience, not a different tracker.
