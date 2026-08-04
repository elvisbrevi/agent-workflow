# Bootstrap repository-owned Azure field mappings

When required completion or effort mappings are absent, the first Azure HU execution will query the Azure field catalog, resolve the intended fields to their exact editable `referenceName` values, validate compatible types, and persist those mappings in `docs/agents/issue-tracker.md`. Later ticket workers reuse the validated mappings instead of rediscovering display names; missing or ambiguous matches stop before ticket mutation.
