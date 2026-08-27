---
status: accepted
---

# Carry the Azure field reference names in the code

Every Azure field the workflow reads or writes is named by a `referenceName`
fixed in the adapter — `TICKET_FIELDS` for the state and both effort fields,
`COMPLETION_EVIDENCE_FIELDS` for the evidence field an organization may carry
under either a name or a GUID, plus `Custom.URLCommit` and
`Custom.Desarrollador1` — rather than by a mapping discovered from Azure's
field catalog and persisted in the repository (ADR-0006).

This agent serves one organization, so discovery would buy a portability
nobody has asked for, and it would buy it with the one failure that matters:
a wrong resolution writes to the wrong field on a real ticket. A fixed name
either matches or fails loudly.

`ticket-create` accepts `--field <referenceName>=<value>`, so a field outside
that set costs a flag on one invocation rather than a schema the repository
has to carry and keep true.
