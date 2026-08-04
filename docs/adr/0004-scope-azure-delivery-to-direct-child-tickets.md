# Scope Azure delivery to direct child tickets

An Azure delivery HU contains only its non-completed direct hierarchical children of type Task or Bug for `issue-killer` execution. Related links, indirect descendants, other work-item types, and completed children stay outside the run; eligible children respect their declared dependencies and use creation time plus ID for deterministic ordering. This makes the hierarchy the authoritative scope boundary and prevents informational relations from silently adding work.
