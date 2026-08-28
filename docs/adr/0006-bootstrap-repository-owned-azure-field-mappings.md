# Bootstrap repository-owned Azure field mappings

When required completion or effort mappings are absent, the first Azure HU execution will query the Azure field catalog, resolve the intended fields to their exact editable `referenceName` values, validate compatible types, and persist those mappings in `docs/agents/issue-tracker.md`. Later ticket workers reuse the validated mappings instead of rediscovering display names; missing or ambiguous matches stop before ticket mutation.

## Implementation status

Partially implemented. Ticket creation queries the field catalog: before
creating a delivery ticket, `createTicket` reads the work-item type's fields and
writes the creation defaults in `CREATION_DEFAULTS`
(`src/azure/ticket-info-service.ts`) only for those the project defines,
validating a pick list's value against its `allowedValues` and stopping before
the creation when it cannot be resolved. The trigger is that the type defines
the field, not that the catalog marks it `alwaysRequired`: a project rule can
require a field the catalog does not, which is how `TF401320` reached a plan
publication in `Cobro Pago y Tarifas`.

The rest stands as written. No mapping is persisted into
`docs/agents/issue-tracker.md`, and the completion and effort `referenceName`
values are still fixed in the code (`Custom.CompletionEvidence` and its GUID
equivalent in `src/azure/autocode-service.ts`, `Custom.Desarrollador1` in
`src/azure/hu-info-service.ts`). The way to reach any other field remains
`--field <referenceName>=<value>` per invocation, which outranks every default.

This note describes the code; it does not revisit the decision. Whoever picks
it up can implement it or mark it `superseded`.
