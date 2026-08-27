# Bootstrap repository-owned Azure field mappings

When required completion or effort mappings are absent, the first Azure HU execution will query the Azure field catalog, resolve the intended fields to their exact editable `referenceName` values, validate compatible types, and persist those mappings in `docs/agents/issue-tracker.md`. Later ticket workers reuse the validated mappings instead of rediscovering display names; missing or ambiguous matches stop before ticket mutation.

## Implementation status

Not implemented as of today. The Azure adapter neither queries the field
catalog nor persists any mapping into `docs/agents/issue-tracker.md`: the
`referenceName` values are fixed in the code (`Custom.CompletionEvidence` and
its GUID equivalent in `src/azure/autocode-service.ts`, `Custom.Desarrollador1`
in `src/azure/hu-info-service.ts`), and the way to reach a different field is
to declare it per invocation with `--field <referenceName>=<value>`.

This note describes the code; it does not revisit the decision. Whoever picks
it up can implement it or mark it `superseded`.
