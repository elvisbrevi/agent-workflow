import type { CommandRunnerPort, TrackerPort } from "../domain/ports"
import type { HuNumber, TicketNumber } from "../domain/checkpoint"
import { asHuNumber, asTicketNumber } from "../domain/checkpoint"
import type { AzureDeliveryScope, TrackerIdentity, TrackerSelection } from "../domain/tracker"
import {
  AZURE_HIERARCHY_FORWARD,
  computeAzureHuBranch,
  evaluateAzureChild,
  inferAzureHuCategory,
  selectAzureDeliveryTicket,
  validateAzureMapping,
  type AzureChildCandidate,
  type AzureHuCategory,
  type AzureMapping,
  type AzureRelation,
  type AzureWorkItem,
} from "../domain/azure"

const MAPPING_KEYS = new Set([
  "organization",
  "project",
  "repository",
  "eligible_work_item_types",
  "epic_work_item_types",
  "delivery_hu_work_item_types",
  "delivery_ticket_work_item_types",
  "open_states",
  "closed_states",
  "ready_tag",
  "claim_identity",
  "predecessor_relation",
  "closed_state",
  "completion_evidence_field",
  "real_effort_field",
  "completion_evidence_field_name",
  "real_effort_field_name",
])

const REQUIRED_KEYS = [
  "organization",
  "project",
  "repository",
  "eligible_work_item_types",
  "epic_work_item_types",
  "delivery_hu_work_item_types",
  "delivery_ticket_work_item_types",
  "open_states",
  "closed_states",
  "ready_tag",
  "claim_identity",
  "predecessor_relation",
  "closed_state",
  "completion_evidence_field",
  "real_effort_field",
] as const

const parseDocumentValue = (value: string): unknown => {
  if (!value.startsWith('"') && !value.startsWith("[")) throw new Error("value must be a quoted string or array")
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed === "string" || Array.isArray(parsed)) return parsed
  throw new Error("value must be a quoted string or array")
}

const toMapping = (raw: Record<string, unknown>): unknown => ({
  organization: raw["organization"],
  project: raw["project"],
  repository: raw["repository"],
  eligibleWorkItemTypes: raw["eligible_work_item_types"],
  epicWorkItemTypes: raw["epic_work_item_types"],
  deliveryHuWorkItemTypes: raw["delivery_hu_work_item_types"],
  deliveryTicketWorkItemTypes: raw["delivery_ticket_work_item_types"],
  openStates: raw["open_states"],
  closedStates: raw["closed_states"],
  readyTag: raw["ready_tag"],
  claimIdentity: raw["claim_identity"],
  predecessorRelation: raw["predecessor_relation"],
  closedState: raw["closed_state"],
  completionEvidenceField: raw["completion_evidence_field"],
  realEffortField: raw["real_effort_field"],
  ...(raw["completion_evidence_field_name"] === undefined
    ? {}
    : { completionEvidenceFieldName: raw["completion_evidence_field_name"] }),
  ...(raw["real_effort_field_name"] === undefined ? {} : { realEffortFieldName: raw["real_effort_field_name"] }),
})

export type AzureDocumentParse =
  | { readonly kind: "ok"; readonly mapping: AzureMapping }
  | { readonly kind: "invalid"; readonly reason: string }

export const parseAzureTrackerDocument = (document: string): AzureDocumentParse => {
  const lines = document.split(/\r?\n/)
  const heading = lines.findIndex((line) => line.trim() === "## Azure DevOps configuration")
  if (heading < 0) return { kind: "invalid", reason: "Azure DevOps configuration section is missing" }
  const raw: Record<string, unknown> = {}
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ""
    if (line.startsWith("## ")) break
    if (line.length === 0 || line.startsWith("#") || line === "```") continue
    const match = line.match(/^([a-z_]+)\s*=\s*(.+)$/)
    if (match === null) continue
    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined || !MAPPING_KEYS.has(key)) {
      return { kind: "invalid", reason: `unknown Azure mapping key: ${key ?? ""}` }
    }
    if (Object.hasOwn(raw, key)) return { kind: "invalid", reason: `duplicate Azure mapping key: ${key}` }
    try {
      raw[key] = parseDocumentValue(value)
    } catch (error) {
      return { kind: "invalid", reason: `invalid value for Azure mapping key ${key}: ${String(error)}` }
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(raw, key)) return { kind: "invalid", reason: `missing Azure mapping key: ${key}` }
  }
  const validation = validateAzureMapping(toMapping(raw))
  return validation.kind === "ok" ? validation : { kind: "invalid", reason: validation.reason }
}

type AzureRemote = { readonly organization: string; readonly project: string; readonly repository: string }

const AZURE_REMOTE_PATTERNS: ReadonlyArray<RegExp> = [
  /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i,
  /^https?:\/\/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i,
  /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  /^ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
]

export const parseAzureRemoteUrl = (url: string): AzureRemote | null => {
  const trimmed = url.trim()
  for (const pattern of AZURE_REMOTE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      return { organization: match[1], project: match[2], repository: match[3] }
    }
  }
  return null
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

const run = async (input: {
  readonly runner: CommandRunnerPort
  readonly program: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> =>
  input.runner.spawn({ program: input.program, args: input.args, cwd: input.cwd, env: { AZURE_CORE_ONLY_SHOW_ERRORS: "true" } })

const azureOrganizationUrl = (organization: string): string => `https://dev.azure.com/${organization}`

const remoteFor = async (runner: CommandRunnerPort, cwd: string): Promise<AzureRemote | null> => {
  const remotes = await run({ runner, program: "git", args: ["remote"], cwd })
  if (remotes.exitCode !== 0) return null
  const names = remotes.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  const parsed: AzureRemote[] = []
  for (const name of names) {
    const url = await run({ runner, program: "git", args: ["config", "--get", `remote.${name}.url`], cwd })
    if (url.exitCode !== 0) return null
    const remote = parseAzureRemoteUrl(url.stdout)
    if (remote === null) return null
    parsed.push(remote)
  }
  const first = parsed[0]
  if (first === undefined || !parsed.every((remote) =>
    same(remote.organization, first.organization) && same(remote.project, first.project) && same(remote.repository, first.repository))) return null
  return first
}

export type AzureRemoteInfo = AzureRemote

export type AzurePreflightResult =
  | { readonly kind: "ok"; readonly mapping: AzureMapping; readonly remote: AzureRemoteInfo }
  | { readonly kind: "invalid_document"; readonly message: string }
  | { readonly kind: "az_missing"; readonly message: string }
  | { readonly kind: "extension_missing"; readonly message: string }
  | { readonly kind: "remote_missing"; readonly message: string }
  | { readonly kind: "remote_mismatch"; readonly message: string }
  | { readonly kind: "project_unavailable"; readonly message: string }
  | { readonly kind: "repository_unavailable"; readonly message: string }
  | { readonly kind: "relation_unavailable"; readonly message: string }

export const preflightAzureTracker = async (input: {
  readonly runner: CommandRunnerPort
  readonly cwd: string
  readonly document: string
  readonly azPath?: string
}): Promise<AzurePreflightResult> => {
  const parsed = parseAzureTrackerDocument(input.document)
  if (parsed.kind !== "ok") return { kind: "invalid_document", message: parsed.reason }
  const azPath = input.azPath ?? "az"
  const version = await run({ runner: input.runner, program: azPath, args: ["version"], cwd: input.cwd }).catch((error) => ({ stdout: "", stderr: String(error), exitCode: 1 }))
  if (version.exitCode !== 0) return { kind: "az_missing", message: version.stderr || "az CLI is unavailable" }
  const extension = await run({ runner: input.runner, program: azPath, args: ["extension", "show", "--name", "azure-devops", "--output", "json"], cwd: input.cwd })
  if (extension.exitCode !== 0) return { kind: "extension_missing", message: extension.stderr || "azure-devops extension is unavailable" }
  const remote = await remoteFor(input.runner, input.cwd)
  if (remote === null) return { kind: "remote_missing", message: "no unambiguous Azure remote is configured" }
  if (!same(remote.organization, parsed.mapping.organization) || !same(remote.project, parsed.mapping.project) || !same(remote.repository, parsed.mapping.repository)) {
    return { kind: "remote_mismatch", message: "Azure remote does not match repository-owned mapping" }
  }
  const org = azureOrganizationUrl(parsed.mapping.organization)
  const project = await run({ runner: input.runner, program: azPath, args: ["devops", "project", "show", "--organization", org, "--project", parsed.mapping.project, "--output", "json"], cwd: input.cwd })
  const projectJson = parseJson(project.stdout)
  if (project.exitCode !== 0 || typeof projectJson !== "object" || projectJson === null) return { kind: "project_unavailable", message: project.stderr || "Azure project preflight failed" }
  const repository = await run({ runner: input.runner, program: azPath, args: ["repos", "show", "--repository", parsed.mapping.repository, "--organization", org, "--project", parsed.mapping.project, "--output", "json"], cwd: input.cwd })
  const repositoryJson = parseJson(repository.stdout)
  if (repository.exitCode !== 0 || typeof repositoryJson !== "object" || repositoryJson === null) return { kind: "repository_unavailable", message: repository.stderr || "Azure repository preflight failed" }
  const relation = await run({ runner: input.runner, program: azPath, args: ["boards", "work-item", "relation", "list-type", "--organization", org, "--output", "json"], cwd: input.cwd })
  const relationJson = parseJson(relation.stdout)
  if (relation.exitCode !== 0 || !Array.isArray(relationJson) || !relationJson.some((entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["referenceName"] === parsed.mapping.predecessorRelation)) {
    return { kind: "relation_unavailable", message: "configured Azure predecessor relation is unavailable" }
  }
  return { kind: "ok", mapping: parsed.mapping, remote }
}

type AzureTrackerOptions = {
  readonly runner: CommandRunnerPort
  readonly cwd: string
  readonly mapping: AzureMapping
  readonly azPath?: string
  readonly huCandidates?: ReadonlyArray<number>
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const field = (fields: Record<string, unknown>, name: string): unknown => fields[`System.${name}`]

const parseRelation = (value: unknown): AzureRelation | null => {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const relation = typeof record["rel"] === "string" ? record["rel"] : null
  const rawUrl = typeof record["url"] === "string" ? record["url"] : ""
  const match = rawUrl.match(/\/([1-9][0-9]*)$/)
  const targetId = match?.[1] === undefined ? null : Number(match[1])
  return relation === null || targetId === null || !Number.isSafeInteger(targetId) ? null : { relation, targetId }
}

export const parseAzureWorkItem = (value: unknown): AzureWorkItem | null => {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const rawFields = record["fields"]
  if (typeof rawFields !== "object" || rawFields === null) return null
  const fields = rawFields as Record<string, unknown>
  const rawId = record["id"] ?? fields["System.Id"]
  const id = typeof rawId === "number" ? rawId : Number(rawId)
  const type = field(fields, "WorkItemType")
  const state = field(fields, "State")
  const title = field(fields, "Title")
  const createdAt = field(fields, "CreatedDate")
  if (!Number.isSafeInteger(id) || typeof type !== "string" || typeof state !== "string" || typeof title !== "string" || typeof createdAt !== "string") return null
  const rawTags = field(fields, "Tags")
  const tags = typeof rawTags === "string" ? rawTags.split(";").map((tag) => tag.trim()).filter(Boolean) : Array.isArray(rawTags) && rawTags.every((tag) => typeof tag === "string") ? rawTags as string[] : []
  const rawAssigned = field(fields, "AssignedTo")
  const assigned = rawAssigned !== undefined && rawAssigned !== null && rawAssigned !== ""
  const rawRelations = Array.isArray(record["relations"]) ? record["relations"] : []
  const relations: AzureRelation[] = []
  for (const rawRelation of rawRelations) {
    const relation = parseRelation(rawRelation)
    if (relation === null) return null
    relations.push(relation)
  }
  const description = field(fields, "Description")
  return {
    id,
    type,
    state,
    tags,
    title,
    ...(typeof description === "string" ? { description } : {}),
    createdAt,
    assigned,
    relations,
  }
}

export type AzureBranchPreparation =
  | { readonly kind: "ready"; readonly branch: string; readonly category: AzureHuCategory; readonly origin: string; readonly reused: boolean }
  | { readonly kind: "blocked"; readonly reason: string }

export const prepareAzureHuBranch = (input: {
  readonly hu: HuNumber
  readonly type: string
  readonly title: string
  readonly description: string
  readonly existingBranches: ReadonlyArray<string>
  readonly interactive: boolean
  readonly origin?: string
}): AzureBranchPreparation => {
  const category = inferAzureHuCategory({ type: input.type, title: input.title, description: input.description })
  const branch = computeAzureHuBranch({ hu: input.hu, category, title: input.title })
  if (input.existingBranches.includes(branch)) return { kind: "ready", branch, category, origin: "existing", reused: true }
  if (!input.interactive) return { kind: "blocked", reason: "operator origin is required before creating an Azure HU integration branch" }
  if (input.origin !== "master" && input.origin !== "develop") return { kind: "blocked", reason: "Azure HU branch origin must be master or develop" }
  return { kind: "ready", branch, category, origin: input.origin, reused: false }
}

export const createAzureTracker = (options: AzureTrackerOptions): TrackerPort => {
  const azPath = options.azPath ?? "az"
  const runAz = (args: ReadonlyArray<string>) => run({ runner: options.runner, program: azPath, args, cwd: options.cwd })
  const org = azureOrganizationUrl(options.mapping.organization)
  const show = async (id: number): Promise<AzureWorkItem> => {
    const result = await runAz(["boards", "work-item", "show", "--id", String(id), "--expand", "relations", "--organization", org, "--project", options.mapping.project, "--output", "json"])
    if (result.exitCode !== 0) throw new Error(`Azure work item ${id} could not be read`)
    const parsed = parseAzureWorkItem(parseJson(result.stdout))
    if (parsed === null || parsed.id !== id) throw new Error(`Azure work item ${id} returned an invalid identity`)
    return parsed
  }
  const openPredecessor = async (item: AzureWorkItem): Promise<boolean> => {
    for (const relation of item.relations) {
      if (relation.relation !== options.mapping.predecessorRelation) continue
      const predecessor = await show(relation.targetId)
      if (options.mapping.openStates.includes(predecessor.state)) return true
    }
    return false
  }
  const huIds = async (requested?: number): Promise<ReadonlyArray<number>> => {
    if (requested !== undefined) return [requested]
    if (options.huCandidates !== undefined) return options.huCandidates
    const result = await runAz(["boards", "query", "--wiql", "SELECT [System.Id] FROM WorkItems", "--organization", org, "--project", options.mapping.project, "--output", "json"])
    if (result.exitCode !== 0) throw new Error("Azure HU query failed")
    const parsed = parseJson(result.stdout)
    if (!Array.isArray(parsed)) throw new Error("Azure HU query returned invalid JSON")
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return []
      const id = (entry as Record<string, unknown>)["id"]
      const numeric = typeof id === "number" ? id : Number(id)
      return Number.isSafeInteger(numeric) && numeric > 0 ? [numeric] : []
    })
  }
  const huIsEligible = async (item: AzureWorkItem): Promise<boolean> => {
    return options.mapping.deliveryHuWorkItemTypes.includes(item.type) && options.mapping.openStates.includes(item.state) && !item.assigned && !Number.isNaN(Date.parse(item.createdAt)) && item.tags.some((tag) => tag.toLowerCase() === options.mapping.readyTag.toLowerCase()) && !options.mapping.epicWorkItemTypes.includes(item.type) && !item.title.startsWith("[Epic]") && !(await openPredecessor(item))
  }
  const childrenFor = async (hu: AzureWorkItem): Promise<ReadonlyArray<AzureChildCandidate>> => {
    const candidates: AzureChildCandidate[] = []
    for (const relation of hu.relations) {
      if (relation.relation !== AZURE_HIERARCHY_FORWARD) continue
      const child = await show(relation.targetId)
      candidates.push({ item: child, directChild: true, openPredecessor: await openPredecessor(child) })
    }
    return candidates
  }
  const selectForHu = async (huId: number): Promise<{ readonly hu: AzureWorkItem; readonly ticket?: AzureWorkItem; readonly selection: ReturnType<typeof selectAzureDeliveryTicket> }> => {
    const hu = await show(huId)
    if (!(await huIsEligible(hu))) return { hu, selection: { kind: "empty", reason: "Azure HU is not eligible" } }
    const selection = selectAzureDeliveryTicket({ mapping: options.mapping, children: await childrenFor(hu) })
    return { hu, ...(selection.kind === "selected" ? { ticket: selection.item } : {}), selection }
  }
  const select = async (requested?: number): Promise<TrackerSelection> => {
    const records = []
    for (const id of await huIds(requested)) records.push(await selectForHu(id))
    records.sort((left, right) => Date.parse(left.hu.createdAt) - Date.parse(right.hu.createdAt) || left.hu.id - right.hu.id)
    for (const record of records) {
      if (record.ticket !== undefined) {
        const hu = asHuNumber(record.hu.id)
        const ticket = asTicketNumber(record.ticket.id)
        if (hu === null || ticket === null) return { kind: "blocked", reason: "Azure work-item identity is outside the supported range" }
        return { kind: "selected", identity: { kind: "azure_ticket", hu, ticket } }
      }
      if (record.selection.kind === "blocked") return { kind: "blocked", reason: record.selection.reason }
      if (requested !== undefined && record.selection.kind === "empty" && record.selection.reason === "Azure HU is not eligible") {
        return { kind: "blocked", reason: record.selection.reason }
      }
    }
    return { kind: "empty", reason: requested === undefined ? "no eligible Azure delivery HU remains" : "no eligible direct ticket remains in the pinned HU" }
  }
  const scopeFor = async (huId: number): Promise<AzureDeliveryScope> => {
    const record = await selectForHu(huId)
    const hu = asHuNumber(record.hu.id)
    if (hu === null) throw new Error("Azure HU identity is invalid")
    const category = inferAzureHuCategory({ type: record.hu.type, title: record.hu.title, description: record.hu.description ?? "" })
    const tickets: TicketNumber[] = []
    for (const candidate of await childrenFor(record.hu)) {
      if (evaluateAzureChild({ ...candidate, mapping: options.mapping }).kind !== "eligible") continue
      const ticket = asTicketNumber(candidate.item.id)
      if (ticket === null) throw new Error("Azure ticket identity is invalid")
      tickets.push(ticket)
    }
    return { hu, tickets, integrationBranch: computeAzureHuBranch({ hu, category, title: record.hu.title }), category }
  }
  return {
    kind: "azure",
    selectEligibleIssue: async (input): Promise<TrackerSelection> => select(input.hu),
    claimIssue: async (input): Promise<void> => {
      if (input.identity.kind !== "azure_ticket") throw new Error("claimIssue called with a non-Azure identity")
      const result = await runAz(["boards", "work-item", "update", "--id", String(input.identity.ticket), "--assigned-to", options.mapping.claimIdentity, "--organization", org, "--project", options.mapping.project, "--output", "json"])
      const body = parseJson(result.stdout)
      const responseId = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["id"] : undefined
      if (result.exitCode !== 0 || (typeof responseId !== "number" && String(responseId) !== String(input.identity.ticket))) throw new Error("Azure ticket claim returned an invalid response")
    },
    verifyCompletion: async (input) => ({ kind: "drift", identity: input.identity, details: "Azure ticket completion belongs to the Azure II adapter" }),
    closeIssue: async (input): Promise<void> => {
      throw new Error(`Azure HU lifecycle is external; refusing to close ${input.identity.kind}`)
    },
    readEvidenceScope: async (input): Promise<AzureDeliveryScope> => scopeFor(input.hu),
    evidenceForCompletion: async (): Promise<void> => undefined,
  }
}
