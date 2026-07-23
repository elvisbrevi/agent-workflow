# Triage Roles

The skills speak in terms of five canonical triage roles. This file maps those roles to their actual representation in this repo's issue tracker.

**Representation:** labels / Azure Tags / custom field / workflow states

| Canonical role    | Tracker value       | Meaning                                  |
| ----------------- | ------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`      | Maintainer needs to evaluate this item   |
| `needs-info`      | `needs-info`        | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`   | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`   | Requires human implementation            |
| `wontfix`         | `wontfix`           | Will not be actioned                     |

When a skill mentions a role, use the corresponding tracker value and the representation declared above.

For Azure Boards, use Tags by default. When changing a role, merge `System.Tags` so unrelated tags are preserved. A project may instead map roles to a custom field or workflow states, but the exact field and values must be recorded here.

## Category roles

Record how the two canonical categories are represented too:

| Canonical category | Tracker representation |
| ------------------ | ---------------------- |
| `bug`              | label/Tag `bug`, Bug work-item type, or `<custom value>` |
| `enhancement`      | label/Tag `enhancement`, backlog work-item type, or `<custom value>` |

On Azure Boards, prefer the native Bug work-item type where the project's process uses it. Record the exact work-item type, Tag, or custom-field value used for both categories.

Edit the representation and tracker-value column to match whatever vocabulary the project actually uses.
