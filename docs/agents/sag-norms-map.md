# SAG norms workflow map

## Purpose

This map defines which remote SAG sources a lazy-workflow command consults. It
is a retrieval map, not a copy of the norms and not proof that an external SAG
system complies with them.

Canonical repository:
[`sag.desarrollo.ia.rag`](https://dev.azure.com/SubdepartamentoSolucionesTI/Secci%C3%B3n%20Desarrollo/_git/sag.desarrollo.ia.rag)
on `master`. Every run must resolve and report the commit used. Links below use
`version=GBmaster` for current content; stable rule IDs, not line numbers, are
the retrieval anchors.

## Source authority

| Class | Meaning | Use |
|---|---|---|
| `N` | Identified rule under `estandares/` | Compliance and review |
| `W` | Agent or workflow guidance | Procedure, only when backed by applicable rules |
| `I` | Versioned executable implementation | Verification or execution after inspecting its contract |
| `T` | Template | Expected shape, not a rule by itself |
| `G` | Mirror of external governance | Context; verify the upstream authority when material |
| `E` | Referenced but unversioned external asset | Never claim verified behavior from the RAG alone |

Open the full `N` source and locate each selected rule ID. A summary in this
map must never replace its rule, rationale, detection, or severity. Before an
`I` source is executed, verify that current `master` still matches the resolved
commit and that its target and parameters are unambiguous.

## Workflow selection

| Command | Norm phase | Required scope | Intended result |
|---|---|---|---|
| `plan --normas-sag` | planning and conditional architecture | Azure `--hu` or existing GitHub planning scope | Plan cites applicable rules and unresolved applicability decisions |
| `code --normas-sag` | coding and review | Existing Azure/GitHub code scope | Implementation uses only rules applicable to the selected component and change |
| `infra-sag` | infrastructure readiness | Azure `--hu`; otherwise GitHub `--issue` | Verify prerequisites; publish missing or unverifiable work in the source tracker |
| `architecture-review-sag` | architecture review | Azure `--hu`; otherwise GitHub `--issue` | Review without remediation; use architecture/design skills, then `/to-spec` and `/to-tickets` for findings in the source tracker |
| `deploy-sag` | delivery | Azure `--hu`; otherwise GitHub `--issue` | Discover one route and deploy to DEV by default or explicit TEST/QA; reject PROD |

SAG-scoped commands are independent. `deploy-sag` does not require a receipt
from `architecture-review-sag`, and no command silently invokes another.

`plan --normas-sag` passes only retrieval metadata to OpenCode. Each selected
`N` rule includes its stable ID, source URL, resolved `master` commit, and
selection reason; the workflow does not copy rule text into the repository.
Missing `.sag/config.json`, an invalid explicit component, an inaccessible
source, or missing required rule families stops planning before OpenCode.

The coding modifier is reserved for the separate coding slice tracked by #156;
the current command rejects `code --normas-sag` until that slice is delivered.

## Deterministic applicability

Read `.sag/config.json` before selecting component rules. Do not infer `tipo`
from the language or file layout. Build the selection from explicit facts:

```text
phase = planning | coding | infrastructure | architecture-review | delivery
component = api | bff | nextjs
change-kind = new-component | feature | bugfix | contract-change | migration | infrastructure
artifacts = work-item | source | test | config | secret | pr | pipeline | release | consul | database | openshift | document
capabilities = database | admin-endpoints | server-auth | user-session | permissions | forms | realtime | document-processing | sonar
environment = none | dev | test | qa
significant-change = true | false
```

Select a rule only when its phase, component, artifact, and explicit condition
match. An unknown condition is `needs-decision`, never silently false. Each
selection records `rule-id`, `selected-because`, source URL, and resolved
commit. `W`, `I`, `T`, `G`, and `E` results remain separate from selected
norms.

## Normative sources

Base URL:
`https://dev.azure.com/SubdepartamentoSolucionesTI/Secci%C3%B3n%20Desarrollo/_git/sag.desarrollo.ia.rag?path=<PATH>&version=GBmaster`

| Rules | Path | Base applicability |
|---|---|---|
| `com-C1...C5`, `com-G1...G2` | `/estandares/comunes.md` | Coding, planning, Git and delivery as stated by each rule |
| `api-R1...R8` | `/estandares/api.md` | API structure and CRUD |
| `api-R9...R15` | `/estandares/api-adonis-patrones.md` | API infrastructure and cross-cutting capabilities |
| `bff-R1...R8` | `/estandares/bff.md` | BFF structure |
| `bff-R9...R18` | `/estandares/bff-patrones.md` | BFF infrastructure and cross-cutting capabilities |
| `nextjs-R1...R8` | `/estandares/nextjs.md` | Next.js structure |
| `nextjs-R9...R17` | `/estandares/nextjs-patrones.md` | Next.js infrastructure and cross-cutting capabilities |
| `doc-R1...R9` | `/estandares/documentacion.md` | Significant changes and delivery documentation |
| `int-R1...R5` | `/estandares/integraciones.md` | Configuration, integrations, credentials and secrets |
| `pr-R1...R5` | `/estandares/pull-requests.md` | Pull requests and the conditional OpenShift Route check |
| `seg-R1...R11` | `/estandares/seguimiento.md` | Planning, execution and tracker traceability |
| `sonar-R1...R7` | `/estandares/sonarqube.md` | Configured Sonar and delivery quality gates |
| `qa-R1...R7` | `/estandares/qa-hu.md` | Documentary QA of an HU, not general code review |
| `ext-R1...R4` | `/estandares/extraccion-documentos.md` | Document processing only |

Use `/estandares/README.md` to confirm current families, but trust rule files
when its ranges lag behind them. Use `/estandares/revision.md` for review
semantics; it does not create additional numbered norms.

## Phase map

### Planning

Start with `com-G1` and tracker rules relevant to defining work. Include the
component family so constraints are visible in the plan. Select security,
documentation, integration, data, session, realtime, and infrastructure rules
only when explicit scope facts make them applicable. Architecture concerns stay
inside planning; there is no separate pre-code architecture command.

### Coding

Start with `com-C1...C5`, then select the configured component family by changed
artifact and capability. Include `int-R*` for configuration, credentials, or
external adapters and the execution-specific `seg-R*` rules. Review uses the
same selected set against the actual diff.

### Infrastructure readiness

`infra-sag` verifies, but does not create, at least:

- `.sag/config.json` and its repository/component identity;
- existence of the selected repository and expected base branch;
- effective Consul config/deploy keys and required variables for the target project;
- declared database requirement and availability of the associated database;
- discoverable pipeline/release identifiers when required for later development or delivery.

Use `/config/README.md`, `/config/sag.config.schema.json`,
`/scripts/lib/config.py`, `/scripts/lib/consul.py`, and applicable component and
integration norms. Runtime values come from authenticated external systems, not
from the RAG. Missing access, ambiguity, and missing prerequisites are findings
that create tracker work; they are not successful verification. The command
must not provision infrastructure in its initial form.

### Architecture review

Select structural and cross-cutting rules for all components in the scoped HU
or Issue, plus `/core/agents/arquitecto-sag.md` and
`/estandares/revision.md`. Review boundaries, contracts, auth, session, data,
cache, Consul, observability, realtime, and deployment topology only when the
scope touches them. Findings do not mutate reviewed code: synthesize them with
`/to-spec`, split corrective work with `/to-tickets`, and publish to Azure for
`--hu` or GitHub for `--issue`.

### Delivery

Select `com-G2`, applicable `pr-R*`, `doc-R*`, `int-R*`, `seg-R*`, and
`sonar-R*`. Consult `/core/workflows/finalizar.md`,
`/core/agents/despliegue-sag.md`, and versioned scripts only as `W`/`I` sources.
Discover pipeline and release names from `.sag/config.json` and repository
assets; execute only when exactly one route and target are verified. DEV is the
default, TEST and QA require explicit selection, and PROD is always rejected.

The RAG does not version the real pipeline v7, Release Definitions,
`ARODeploy_V7`, deployed OpenShift manifests, or effective Consul payloads.
Ambiguity or inability to inspect those systems must stop deployment rather
than be replaced by inference.

The first executable DEV route is declared under `deployment` in
`.sag/config.json`:

```json
{
  "authentication": "operator",
  "route": {
    "repository": "project/repository",
    "baseBranch": "main",
    "pipeline": { "id": "pipeline-7", "version": "v7" },
    "releaseDefinition": { "id": "release-1" },
    "target": { "id": "openshift-dev", "environment": "dev", "evidence": "authoritative-target-evidence" }
  }
}
```

The coordinator never treats these values as proof: an authenticated external
adapter must return exactly one matching route and verify the resulting state.

## Security and failure rules

- SAG context is opt-in for `plan` and `code`, mandatory for SAG-scoped commands, and absent otherwise.
- Failure to read the remote SAG source stops the run.
- Authenticated checks may use credentials already available to the operator and may pause for login.
- Prompts, logs, evidence, maps, and checkpoints never contain credentials, tokens, cookies, or secret values.
- External reads and mutations must be reread or otherwise verified before success.
- No deployment command accepts, aliases, or infers PROD.
