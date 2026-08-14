import { HuInfo, type HuInfoData } from "./hu-info.ts";
import { reportOperator } from "../output/operator-output.ts";
import { checkoutGitBranch, pushGitBranch, runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import {
  AzureTicketInfoService,
  runAzureCommand,
  type CompletionManifest,
  type EvidenceKind,
  type TicketInfo,
  type TicketAttachment,
  type IntegratedPullRequest,
  type AzurePullRequestTarget,
} from "./ticket-info-service.ts";
import type { InfrastructurePublication } from "../sag/infrastructure-service.ts";

const ORGANIZATION = "https://dev.azure.com/SubdepartamentoSolucionesTI";
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const WORK_ITEM_API_VERSION = "7.1";
const COMPLETED_STATES = new Set(["Done", "Closed", "Removed", "Resolved"]);
const COMPLETION_EVIDENCE_FIELDS = [
  "Custom.CompletionEvidence",
  "Custom.b505c83e-3745-4d8b-b76b-b3086a0c4c71",
] as const;

export interface DeliveryTicket {
  id: number;
  title?: string;
  type: "Task" | "Bug";
  state?: string;
  createdDate?: string;
  revision?: number;
  effort?: { real?: number; realHours?: number };
}

export interface AutocodeContext {
  hu: { id: number; title?: string };
  ticket: DeliveryTicket;
  integrationBranch: string;
  project?: string;
}

export interface AutocodeState {
  context: AutocodeContext | null;
  pending: boolean;
}

export interface IntegrationBranchInfo {
  hu: number;
  branch: string | null;
}

export interface AzureWorkspaceRepositoryIdentity {
  workingDirectory: string;
  remote: string;
  repository: string;
  project: string;
  projectId: string;
  repositoryId: string;
}

export interface AzureWorkspaceBranchUnit {
  path: string;
  remote: string;
  repository: string;
  project: string;
  /** Azure GUIDs; identity comparisons against pull-request payloads use these, never the names. */
  repositoryId: string;
  projectId: string;
  integrationBranch: string;
  ticketBranch: string | null;
  integrationBranchCreated: boolean;
  ticketBranchCreated: boolean;
  ticketBranchAnchor: string | null;
}

export interface AzureWorkspaceBranchTopology {
  hu: number;
  ticket: number | null;
  integrationBranch: string;
  ticketBranch?: string;
  anchor: AzureWorkspaceRepositoryIdentity;
  ticketBranchAnchor: string | null;
  units: AzureWorkspaceBranchUnit[];
}

export interface AzureWorkspaceRepositoryInput {
  readonly path: string;
  readonly remote: string;
}

export type { AzurePullRequestTarget } from "./ticket-info-service.ts";

export const COMPLETION_GATE = {
  pinnedTicketContext: "pinned-ticket-context",
  ticketState: "ticket-state",
  completionEvidence: "completion-evidence",
  realEffort: "real-effort",
  realEffortHours: "real-effort-hours",
  commitUrl: "commit-url",
  attachedCapture: "attached-capture",
  huIntegrationBranch: "hu-integration-branch",
  completedHuPullRequest: "completed-hu-targeted-pr",
  nativePullRequestAssociation: "native-pr-association",
  mergeCommitArtifact: "merge-commit-artifact-link",
} as const;

export type CompletionGate = typeof COMPLETION_GATE[keyof typeof COMPLETION_GATE];

export interface VerifiedTicketCompletion {
  ticketBranch: string;
}

export interface IncompleteTicketCompletion {
  ticketId: number;
  unmetGates: CompletionGate[];
}

export type TicketCompletionVerification = VerifiedTicketCompletion | IncompleteTicketCompletion;

export interface AutocodeAzureService {
  getHuInfo(hu: number): Promise<HuInfo>;
  getIntegrationBranchInfo(hu: number): Promise<IntegrationBranchInfo>;
  setIntegrationBranch(hu: number, branch: string, workingDirectory: string, baseBranch?: string | null): Promise<{ hu: number; branch: string }>;
  setTicketBranch(hu: number, ticket: number, branch: string, workingDirectory: string): Promise<{ hu: number; ticket: number; branch: string }>;
  pushTicketBranch(branch: string, workingDirectory: string): Promise<void>;
  checkoutTicketBranch(branch: string, workingDirectory: string): Promise<void>;
  ensureIntegrationBranch(hu: number, workingDirectory: string, baseBranch?: string | null): Promise<string | null>;
  getAutocodeState(hu: number, integrationBranch?: string): Promise<AutocodeState>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  getAutocodeContextForTicket(hu: number, ticket: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<TicketCompletionVerification>;
  getCompletedTicketBranch(context: AutocodeContext): Promise<string | null>;
  getTicketInfo(hu: number, ticket: number): Promise<TicketInfo>;
  getCompletionManifestPath(workingDirectory: string): Promise<string>;
  createOrReusePullRequest(hu: number, ticket: number, participant?: AzurePullRequestTarget): Promise<IntegratedPullRequest>;
  validateDirectTicketContext(hu: number, ticket: number): Promise<void>;
  getCompletionInfo(hu: number, ticket: number): Promise<{ hu: number; ticket: number; gates: TicketInfo["gates"] }>;
  readCompletionManifest(path: string, workingDirectory: string): Promise<CompletionManifest>;
  validateCompletionManifest(manifest: CompletionManifest, info: TicketInfo, ticket: number, workingDirectory: string): Promise<void>;
  validateEvidenceFile(filePath: string, kind: EvidenceKind): Promise<void>;
  validateEvidence(ticket: number, filePath: string): Promise<void>;
  getBranch(hu: number, ticket: number): Promise<{ hu: number; ticket: number; branch: string | null; integrationBranch: string | null }>;
  getTicket(ticket: number): Promise<DeliveryTicket>;
  getDescription(ticket: number): Promise<{ ticket: number; description: string | null }>;
  getState(ticket: number): Promise<{ ticket: number; state: string | null; revision: number | null }>;
  getEffort(ticket: number): Promise<{ ticket: number; effort: { estimated?: number; real?: number; realHours?: number } }>;
  getAttachments(ticket: number): Promise<{ ticket: number; attachments: TicketAttachment[] }>;
  getEvidence(ticket: number): Promise<{ ticket: number; completionEvidence: string | null }>;
  setDescription(ticket: number, filePath: string): Promise<unknown>;
  setState(ticket: number, desiredState: string, expectedState: string, allowCompletion?: boolean, expectedRevision?: number): Promise<unknown>;
  setEffort(ticket: number, realEffort: number, realEffortHours: number, expectedRevision: number): Promise<unknown>;
  setHuState(hu: number, desiredState: string, expectedState: string, expectedRevision: number): Promise<{ hu: number; state: string; revision: number }>;
  getHuChildren(hu: number): Promise<Array<{ id: number; type: string; state: string; title?: string }>>;
  hasOpenDeliveryChildren(hu: number): Promise<boolean>;
  linkPullRequest(hu: number, ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown>;
  linkCommit(ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown>;
  addAttachment(ticket: number, filePath: string, kind: EvidenceKind): Promise<unknown>;
  setEvidence(ticket: number, filePath: string): Promise<unknown>;
  waitForAccess(hu: number): Promise<void>;
  publishInfrastructureFindings(hu: number, specification: { title: string; body: string }, tickets: Array<{ title: string; body: string }>): Promise<InfrastructurePublication>;
}

interface WorkItem {
  id: number;
  rev?: number;
  fields?: Record<string, unknown>;
  relations?: Array<{
    rel?: string;
    url?: string;
    attributes?: { name?: string; comment?: string; digest?: string };
  }>;
}

interface AzureRepository {
  id?: string;
  name?: string;
  remoteUrl?: string;
  project?: { id?: string; name?: string };
}

interface CompletedPullRequest {
  status?: string;
  mergeStatus?: string;
  target?: string;
  source?: string;
  id?: number;
  projectId?: string;
  repositoryId?: string;
  mergeCommit?: string;
}

type AzRunner = (args: string[]) => Promise<string>;

const field = (item: WorkItem, name: string): string | undefined => {
  const value = item.fields?.[name];
  return typeof value === "string" ? value : undefined;
};

const firstField = (item: WorkItem, names: readonly string[]): string | undefined =>
  names.map((name) => field(item, name)).find((value) => value?.trim());

const positiveNumberField = (item: WorkItem, name: string): boolean => {
  const value = item.fields?.[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0;
};

async function show(id: number, expandRelations: boolean, az: AzRunner): Promise<WorkItem> {
  const args = [
    "boards", "work-item", "show", "--id", `${id}`, "--organization", ORGANIZATION,
    ...(expandRelations ? ["--expand", "relations"] : []),
    "--output", "json",
  ];
  const payload = JSON.parse(await az(args)) as WorkItem;
  if (payload.id !== id) throw new Error(`Respuesta de work item malformada: no coincide con el ID solicitado ${id}`);
  return payload;
}

function relationId(url: string | undefined): number | undefined {
  const id = url?.match(/workItems\/(\d+)$/)?.[1];
  return id ? Number(id) : undefined;
}

function integrationBranchFrom(item: WorkItem): string | undefined {
  const relation = item.relations?.find(({ rel, attributes }) =>
    rel === "ArtifactLink" && attributes?.name === "Branch"
  );
  if (!relation?.url) return undefined;
  const decoded = decodeURIComponent(relation.url);
  const marker = "/GB";
  const markerIndex = decoded.lastIndexOf(marker);
  const name = markerIndex >= 0 ? decoded.slice(markerIndex + marker.length) : "";
  return name ? `refs/heads/${name}` : undefined;
}

interface BranchLink {
  ref: string;
  project: string;
  repository: string;
}

function branchLinksFrom(item: WorkItem): BranchLink[] {
  return (item.relations ?? [])
    .filter(({ rel, attributes }) => rel === "ArtifactLink" && attributes?.name === "Branch")
    .map((relation) => {
      if (!relation.url) throw new Error("Branch ArtifactLink sin URI");
      let decoded: string;
      try {
        decoded = decodeURIComponent(relation.url);
      } catch {
        throw new Error("Branch ArtifactLink con URI malformada");
      }
      const match = decoded.match(/^vstfs:\/\/\/Git\/Ref\/[^/]+\/[^/]+\/GB(.+)$/);
      const branch = match?.[1];
      if (!branch || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
        throw new Error("Branch ArtifactLink con URI de rama Azure Git malformada");
      }
      const parts = decoded.match(/^vstfs:\/\/\/Git\/Ref\/([^/]+)\/([^/]+)\/GB(.+)$/);
      if (!parts?.[1] || !parts[2] || parts[3] !== branch) {
        throw new Error("Branch ArtifactLink con URI de rama Azure Git malformada");
      }
      return { ref: `refs/heads/${branch}`, project: parts[1], repository: parts[2] };
    });
}

function integrationBranchesFrom(item: WorkItem): string[] {
  return branchLinksFrom(item).map(({ ref }) => ref);
}

function uniqueBranchLinks(item: WorkItem): BranchLink[] {
  const unique = [...new Map(branchLinksFrom(item).map((link) => [`${link.project}/${link.repository}/${link.ref}`, link])).values()];
  if (unique.length > 1) throw new Error("existen multiples Branch ArtifactLink distintos");
  return unique;
}

function belongsToTicket(source: string | undefined, ticket: number): boolean {
  if (!source?.startsWith("refs/heads/")) return false;
  return new RegExp(`(?:^|[/_.-])${ticket}(?:$|[/_.-])`).test(source.slice("refs/heads/".length));
}

function hasArtifactLink(item: WorkItem, expectedDecodedUri: string): boolean {
  return (item.relations ?? []).some((relation) =>
    relation.rel === "ArtifactLink"
      && typeof relation.url === "string"
      && decodeURIComponent(relation.url) === expectedDecodedUri
  );
}

function createdWorkItemId(output: string): number {
  const id = (JSON.parse(output) as { id?: unknown }).id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) throw new Error("Azure no devolvio el work item creado");
  return id;
}

export class AzureAutocodeService implements AutocodeAzureService {
  private readonly ticketInfoService: AzureTicketInfoService;

  constructor(
    private readonly az: AzRunner = runAzureCommand,
    private readonly git: GitRunner = runGit,
  ) {
    this.ticketInfoService = new AzureTicketInfoService(az, git);
  }

  async getHuInfo(hu: number): Promise<HuInfo> {
    const item = await show(hu, false, this.az);
    return new HuInfo({
      id: item.id,
      title: field(item, "System.Title"),
      description: field(item, "System.Description"),
      criterioDeAceptacion: field(item, "Microsoft.VSTS.Common.AcceptanceCriteria"),
      state: field(item, "System.State"),
      project: field(item, "System.TeamProject"),
      assignedTo: item.fields?.["System.AssignedTo"],
      desarrollador: field(item, "Custom.Desarrollador1"),
    } satisfies HuInfoData);
  }

  async publishInfrastructureFindings(
    hu: number,
    specification: { title: string; body: string },
    tickets: Array<{ title: string; body: string }>,
  ): Promise<InfrastructurePublication> {
    const parent = await this.getHuInfo(hu);
    if (!parent.project?.trim()) throw new Error(`La HU ${hu} no tiene proyecto Azure verificable`);
    const create = async (title: string, body: string): Promise<number> => {
      const output = await this.az([
        "boards", "work-item", "create", "--type", "Task", "--title", title,
        "--fields", `System.Description=${body}`,
        "--organization", ORGANIZATION, "--project", parent.project!, "--output", "json",
      ]);
      const id = createdWorkItemId(output);
      await this.az([
        "boards", "work-item", "relation", "add", "--id", `${id}`,
        "--relation-type", "parent", "--target-id", `${hu}`,
        "--organization", ORGANIZATION, "--output", "json",
      ]);
      const verified = await show(id, true, this.az);
      if (!verified.relations?.some(({ rel, url }) => rel === "System.LinkTypes.Hierarchy-Reverse" && relationId(url) === hu)) {
        throw new Error(`No se pudo verificar la relacion del work item ${id} con la HU ${hu}`);
      }
      return id;
    };
    const specificationId = await create(specification.title, `${specification.body}\n\nSource HU: ${hu}`);
    const ticketIds: number[] = [];
    for (const ticket of tickets) ticketIds.push(await create(ticket.title, `${ticket.body}\n\nSource HU: ${hu}\nSpecification: ${specificationId}`));
    return { specification: specificationId, tickets: ticketIds };
  }

  getTicketInfo(hu: number, ticket: number): Promise<TicketInfo> {
    return this.ticketInfoService.getTicketInfo(hu, ticket);
  }

  getCompletionManifestPath(workingDirectory: string): Promise<string> {
    return this.ticketInfoService.getCompletionManifestPath(workingDirectory);
  }

  createOrReusePullRequest(hu: number, ticket: number, participant?: AzurePullRequestTarget): Promise<IntegratedPullRequest> {
    return this.ticketInfoService.createOrReusePullRequest(hu, ticket, participant);
  }

  validateDirectTicketContext(hu: number, ticket: number): Promise<void> {
    return this.ticketInfoService.validateDirectTicketContext(hu, ticket);
  }

  getCompletionInfo(hu: number, ticket: number): Promise<{ hu: number; ticket: number; gates: TicketInfo["gates"] }> {
    return this.ticketInfoService.getCompletionInfo(hu, ticket);
  }

  readCompletionManifest(path: string, workingDirectory: string) {
    return this.ticketInfoService.readCompletionManifest(path, workingDirectory);
  }

  validateCompletionManifest(manifest: CompletionManifest, info: TicketInfo, ticket: number, workingDirectory: string): Promise<void> {
    return this.ticketInfoService.validateCompletionManifest(manifest, info, ticket, workingDirectory);
  }

  validateEvidenceFile(filePath: string, kind: EvidenceKind): Promise<void> {
    return this.ticketInfoService.validateEvidenceFile(filePath, kind);
  }

  validateEvidence(ticket: number, filePath: string): Promise<void> {
    return this.ticketInfoService.validateEvidence(ticket, filePath);
  }

  getBranch(hu: number, ticket: number): Promise<{ hu: number; ticket: number; branch: string | null; integrationBranch: string | null }> {
    return this.ticketInfoService.getBranch(hu, ticket);
  }

  getTicket(ticket: number): Promise<DeliveryTicket> {
    return this.ticketInfoService.getTicket(ticket);
  }

  getDescription(ticket: number): Promise<{ ticket: number; description: string | null }> {
    return this.ticketInfoService.getDescription(ticket);
  }

  getState(ticket: number): Promise<{ ticket: number; state: string | null; revision: number | null }> {
    return this.ticketInfoService.getState(ticket);
  }

  getEffort(ticket: number): Promise<{ ticket: number; effort: { estimated?: number; real?: number; realHours?: number } }> {
    return this.ticketInfoService.getEffort(ticket);
  }

  getAttachments(ticket: number): Promise<{ ticket: number; attachments: TicketAttachment[] }> {
    return this.ticketInfoService.getAttachments(ticket);
  }

  getEvidence(ticket: number): Promise<{ ticket: number; completionEvidence: string | null }> {
    return this.ticketInfoService.getEvidence(ticket);
  }

  setDescription(ticket: number, filePath: string): Promise<unknown> {
    return this.ticketInfoService.setDescription(ticket, filePath);
  }

  setState(ticket: number, desiredState: string, expectedState: string, allowCompletion = false, expectedRevision?: number): Promise<unknown> {
    return this.ticketInfoService.setState(ticket, desiredState, expectedState, allowCompletion, expectedRevision);
  }

  setEffort(ticket: number, realEffort: number, realEffortHours: number, expectedRevision: number): Promise<unknown> {
    return this.ticketInfoService.setEffort(ticket, realEffort, realEffortHours, expectedRevision);
  }

  setHuState(hu: number, desiredState: string, expectedState: string, expectedRevision: number): Promise<{ hu: number; state: string; revision: number }> {
    return this.ticketInfoService.setHuState(hu, desiredState, expectedState, expectedRevision);
  }

  getHuChildren(hu: number): Promise<Array<{ id: number; type: string; state: string; title?: string }>> {
    return this.ticketInfoService.getHuChildren(hu);
  }

  hasOpenDeliveryChildren(hu: number): Promise<boolean> {
    return this.ticketInfoService.hasOpenDeliveryChildren(hu);
  }

  linkPullRequest(hu: number, ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown> {
    return this.ticketInfoService.linkPullRequest(hu, ticket, pullRequest, participant);
  }

  linkCommit(ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown> {
    return this.ticketInfoService.linkCommit(ticket, pullRequest, participant);
  }

  addAttachment(ticket: number, filePath: string, kind: EvidenceKind): Promise<unknown> {
    return this.ticketInfoService.addAttachment(ticket, filePath, kind);
  }

  setEvidence(ticket: number, filePath: string): Promise<unknown> {
    return this.ticketInfoService.setEvidence(ticket, filePath);
  }

  async getIntegrationBranchInfo(hu: number): Promise<IntegrationBranchInfo> {
    if (!Number.isInteger(hu) || hu <= 0) {
      throw new Error(`La HU debe ser un entero positivo: ${hu}`);
    }
    const branches = [...new Set(integrationBranchesFrom(await show(hu, true, this.az)))];
    if (branches.length > 1) {
      throw new Error(`La HU ${hu} tiene multiples Branch ArtifactLink distintos`);
    }
    return { hu, branch: branches[0] ?? null };
  }

  async setIntegrationBranch(
    hu: number,
    requestedBranch: string,
    workingDirectory: string,
    requestedBaseBranch?: string | null,
  ): Promise<{ hu: number; branch: string }> {
    if (!Number.isInteger(hu) || hu <= 0) {
      throw new Error(`La HU debe ser un entero positivo: ${hu}`);
    }
    const normalized = normalizeBranch(requestedBranch);
    const parent = await show(hu, true, this.az);
    const projectName = field(parent, "System.TeamProject");
    if (!projectName) throw new Error("La HU no tiene proyecto Azure");

    const origin = parseAzureOrigin(await this.git(["remote", "get-url", "origin"], workingDirectory));
    if (!same(origin.project, projectName)) {
      throw new Error(`El origen Azure pertenece al proyecto ${origin.project}, no al proyecto ${projectName}`);
    }
    const repositoryOutput = await this.az([
      "repos", "show", "--organization", ORGANIZATION,
      "--project", projectName, "--repository", origin.repository, "--output", "json",
    ]);
    const repository = JSON.parse(repositoryOutput) as AzureRepository;
    if (
      !repository.id
      || !repository.name
      || !repository.project?.id
      || !repository.project.name
      || !same(repository.name, origin.repository)
      || !same(repository.project.name, projectName)
    ) {
      throw new Error("El repositorio Azure del origen no coincide con la HU");
    }
    if (!repository.remoteUrl) throw new Error("Azure no devolvió la URL del repositorio");
    const resolvedOrigin = parseAzureOrigin(repository.remoteUrl);
    if (
      !same(resolvedOrigin.organization, origin.organization)
      || !same(resolvedOrigin.project, origin.project)
      || !same(resolvedOrigin.repository, origin.repository)
    ) {
      throw new Error("El repositorio Azure resuelto no coincide con origin");
    }

    const linkedBranches = [...new Set(integrationBranchesFrom(parent))];
    if (linkedBranches.length > 1) {
      throw new Error(`La HU ${hu} tiene conflicto por multiples Branch ArtifactLink distintos`);
    }
    if (linkedBranches[0] && linkedBranches[0] !== normalized.ref) {
      throw new Error(`La HU ${hu} ya tiene vinculada la rama ${linkedBranches[0]}; conflicto`);
    }

    const remoteSha = await remoteBranchSha(this.git, normalized.ref, workingDirectory);
    if (remoteSha) {
      if (linkedBranches[0] === normalized.ref) return { hu, branch: normalized.ref };
    } else {
      if (!requestedBaseBranch?.trim()) {
        throw new Error(`La rama ${normalized.ref} no existe remotamente; indique --base-branch <name>`);
      }
      const base = normalizeBranch(requestedBaseBranch);
      if (base.ref === normalized.ref) throw new Error("La base remota no puede ser la rama HU");
      const baseSha = await remoteBranchSha(this.git, base.ref, workingDirectory);
      if (!baseSha) throw new Error(`La rama base ${base.ref} no existe remotamente`);
      const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--ignored"], workingDirectory);
      if (status.trim()) throw new Error("El repositorio tiene cambios sin guardar; no se creará la rama HU");
      const localBaseRef = `refs/lazy-workflow/${crypto.randomUUID()}`;
      try {
        const existingRef = (await this.git(["for-each-ref", "--format=%(refname)", localBaseRef], workingDirectory)).trim();
        if (existingRef) throw new Error(`El ref temporal local ${localBaseRef} ya existe`);
        await this.git(["fetch", "--no-tags", "origin", `+${base.ref}:${localBaseRef}`], workingDirectory);
        const fetchedSha = (await this.git(["rev-parse", `${localBaseRef}^{commit}`], workingDirectory)).trim();
        if (fetchedSha !== baseSha) throw new Error(`La base remota ${base.ref} cambió durante la preparación`);
        await this.git(["push", "origin", `${localBaseRef}:${normalized.ref}`], workingDirectory);
        const publishedSha = await remoteBranchSha(this.git, normalized.ref, workingDirectory);
        if (publishedSha !== baseSha) {
          throw new Error(`No se pudo verificar remotamente la rama ${normalized.ref} desde ${base.ref}`);
        }
      } finally {
        await this.git(["update-ref", "-d", localBaseRef], workingDirectory);
      }
    }

    if (linkedBranches[0] === normalized.ref) return { hu, branch: normalized.ref };

    const artifactUrl = `vstfs:///Git/Ref/${encodeURIComponent(`${repository.project.id}/${repository.id}/GB${normalized.name}`)}`;
    const patchBody = JSON.stringify([{
      op: "add",
      path: "/relations/-",
      value: { rel: "ArtifactLink", url: artifactUrl, attributes: { name: "Branch" } },
    }]);
    await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE,
      "--method", "patch",
      "--uri", `${ORGANIZATION}/${repository.project.id}/_apis/wit/workitems/${hu}?api-version=${WORK_ITEM_API_VERSION}`,
      "--headers", "Content-Type=application/json-patch+json",
      "--body", patchBody,
      "--output", "json",
    ]);

    const verified = await this.getIntegrationBranchInfo(hu);
    if (verified.branch !== normalized.ref) {
      throw new Error(`No se pudo verificar en Azure la rama ${normalized.ref}`);
    }
    return { hu, branch: normalized.ref };
  }

  async setTicketBranch(
    hu: number,
    ticket: number,
    requestedBranch: string,
    workingDirectory: string,
  ): Promise<{ hu: number; ticket: number; branch: string }> {
    if (!Number.isInteger(hu) || hu <= 0) throw new Error(`La HU debe ser un entero positivo: ${hu}`);
    if (!Number.isInteger(ticket) || ticket <= 0) throw new Error(`El ticket debe ser un entero positivo: ${ticket}`);
    const normalized = normalizeBranch(requestedBranch);
    const [parent, item] = await Promise.all([show(hu, true, this.az), show(ticket, true, this.az)]);
    const isDirectChild = (parent.relations ?? []).some((relation) =>
      relation.rel === "System.LinkTypes.Hierarchy-Forward" && relationId(relation.url) === ticket
    );
    const reverseParents = (item.relations ?? [])
      .filter((relation) => relation.rel === "System.LinkTypes.Hierarchy-Reverse")
      .map((relation) => relationId(relation.url));
    if (!isDirectChild || reverseParents.length !== 1 || reverseParents[0] !== hu) {
      throw new Error(`El ticket ${ticket} no es hijo directo único de la HU ${hu}`);
    }
    const type = field(item, "System.WorkItemType");
    if (type !== "Task" && type !== "Bug") throw new Error(`El work item ${ticket} no es un Task o Bug de entrega`);
    const revision = item.rev;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision <= 0) {
      throw new Error(`El ticket ${ticket} no tiene una revisión Azure válida`);
    }

    const integration = uniqueBranchLinks(parent)[0];
    if (!integration) throw new Error(`La HU ${hu} no tiene una rama de integración vinculada`);
    if (integration.ref === normalized.ref) throw new Error("La rama del ticket no puede ser la rama de integración");

    const linked = uniqueBranchLinks(item)[0];
    if (linked && (
      linked.ref !== normalized.ref
      || linked.project !== integration.project
      || linked.repository !== integration.repository
    )) throw new Error(`El ticket ${ticket} ya tiene una rama vinculada; conflicto`);

    const projectName = field(parent, "System.TeamProject");
    if (!projectName) throw new Error("La HU no tiene proyecto Azure");
    const origin = parseAzureOrigin(await this.git(["remote", "get-url", "origin"], workingDirectory));
    if (!same(origin.project, projectName)) {
      throw new Error(`El origen Azure pertenece al proyecto ${origin.project}, no al proyecto ${projectName}`);
    }
    const repositoryOutput = await this.az([
      "repos", "show", "--organization", ORGANIZATION,
      "--project", projectName, "--repository", origin.repository, "--output", "json",
    ]);
    const repository = JSON.parse(repositoryOutput) as AzureRepository;
    if (
      !repository.id || !repository.name || !repository.project?.id || !repository.project.name
      || !same(repository.name, origin.repository) || !same(repository.project.name, projectName)
      || repository.project.id !== integration.project || repository.id !== integration.repository
    ) throw new Error("El repositorio Azure no coincide con la rama de integración de la HU");
    if (!repository.remoteUrl) throw new Error("Azure no devolvió la URL del repositorio");
    const resolvedOrigin = parseAzureOrigin(repository.remoteUrl);
    if (
      !same(resolvedOrigin.organization, origin.organization)
      || !same(resolvedOrigin.project, origin.project)
      || !same(resolvedOrigin.repository, origin.repository)
    ) throw new Error("El repositorio Azure resuelto no coincide con origin");

    const integrationSha = await remoteBranchSha(this.git, integration.ref, workingDirectory);
    if (!integrationSha) throw new Error(`La rama de integración ${integration.ref} no existe remotamente`);
    const ticketSha = await remoteBranchSha(this.git, normalized.ref, workingDirectory);
    if (ticketSha && ticketSha !== integrationSha) {
      throw new Error(`La rama del ticket ${normalized.ref} no coincide con la rama de integración de la HU`);
    }
    if (!ticketSha) {
      const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--ignored"], workingDirectory);
      if (status.trim()) throw new Error("El repositorio tiene cambios sin guardar; no se creará la rama del ticket");
      const temporaryRef = `refs/lazy-workflow/${crypto.randomUUID()}`;
      try {
        const existingRef = (await this.git(["for-each-ref", "--format=%(refname)", temporaryRef], workingDirectory)).trim();
        if (existingRef) throw new Error(`El ref temporal local ${temporaryRef} ya existe`);
        await this.git(["fetch", "--no-tags", "origin", `+${integration.ref}:${temporaryRef}`], workingDirectory);
        const fetchedSha = (await this.git(["rev-parse", `${temporaryRef}^{commit}`], workingDirectory)).trim();
        if (fetchedSha !== integrationSha) throw new Error(`La rama de integración ${integration.ref} cambió durante la preparación`);
        await this.git(["push", "origin", `${temporaryRef}:${normalized.ref}`], workingDirectory);
        const publishedSha = await remoteBranchSha(this.git, normalized.ref, workingDirectory);
        if (publishedSha !== integrationSha) throw new Error(`No se pudo verificar remotamente la rama ${normalized.ref}`);
      } finally {
        await this.git(["update-ref", "-d", temporaryRef], workingDirectory);
      }
    } else {
      const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--ignored"], workingDirectory);
      if (status.trim()) throw new Error("El repositorio tiene cambios sin guardar; no se vinculará la rama del ticket");
    }

    const verifyRemoteBranches = async (): Promise<void> => {
      const currentIntegrationSha = await remoteBranchSha(this.git, integration.ref, workingDirectory);
      const currentTicketSha = await remoteBranchSha(this.git, normalized.ref, workingDirectory);
      if (currentIntegrationSha !== integrationSha || currentTicketSha !== integrationSha) {
        throw new Error(`Las ramas remotas cambiaron antes de vincular ${normalized.ref}`);
      }
    };

    if (!linked) {
      await verifyRemoteBranches();
      const artifactUrl = `vstfs:///Git/Ref/${encodeURIComponent(`${repository.project.id}/${repository.id}/GB${normalized.name}`)}`;
      const patch = [
        { op: "test", path: "/rev", value: revision },
        {
          op: "add",
          path: "/relations/-",
          value: { rel: "ArtifactLink", url: artifactUrl, attributes: { name: "Branch" } },
        },
      ];
      await this.az([
        "rest", "--resource", AZURE_DEVOPS_RESOURCE,
        "--method", "patch",
        "--uri", `${ORGANIZATION}/${repository.project.id}/_apis/wit/workitems/${ticket}?api-version=${WORK_ITEM_API_VERSION}`,
        "--headers", "Content-Type=application/json-patch+json",
        "--body", JSON.stringify(patch),
        "--output", "json",
      ]);
    }

    await verifyRemoteBranches();
    const verified = await this.getBranch(hu, ticket);
    if (verified.branch !== normalized.ref) throw new Error(`No se pudo verificar en Azure la rama ${normalized.ref}`);
    return { hu, ticket, branch: normalized.ref };
  }

  pushTicketBranch(branch: string, workingDirectory: string): Promise<void> {
    return pushGitBranch(this.git, branch, workingDirectory);
  }

  checkoutTicketBranch(branch: string, workingDirectory: string): Promise<void> {
    return checkoutGitBranch(this.git, branch, workingDirectory);
  }

  async ensureIntegrationBranch(
    hu: number,
    workingDirectory: string,
    baseBranch?: string | null,
  ): Promise<string | null> {
    const linked = await this.getIntegrationBranchInfo(hu);
    if (linked.branch) {
      return (await this.setIntegrationBranch(hu, linked.branch, workingDirectory)).branch;
    }
    return (await this.setIntegrationBranch(hu, `refs/heads/hu/${hu}`, workingDirectory, baseBranch)).branch;
  }

  async prepareWorkspaceBranches(options: {
    hu: number;
    repositories: readonly AzureWorkspaceRepositoryInput[];
    baseBranch?: string | null;
    integrationBranch?: string;
  }): Promise<AzureWorkspaceBranchTopology> {
    if (!Number.isInteger(options.hu) || options.hu <= 0) {
      throw new Error(`La HU debe ser un entero positivo: ${options.hu}`);
    }
    if (options.repositories.length === 0) throw new Error("El alcance multi-repositorio no puede ser vacío");
    const identities = await Promise.all(options.repositories.map((repository) => this.resolveRepositoryIdentity(repository)));

    const parent = await show(options.hu, true, this.az);
    const existingLinks = uniqueBranchLinks(parent);
    const projectName = field(parent, "System.TeamProject");
    if (!projectName) throw new Error("La HU no tiene proyecto Azure");
    const integrationBranch = normalizeBranch(options.integrationBranch ?? `refs/heads/hu/${options.hu}`).ref;

    const matchedAnchor = existingLinks.length === 1
      ? identities.find((identity) => identity.repositoryId === existingLinks[0]!.repository && identity.projectId === existingLinks[0]!.project)
      : undefined;
    if (existingLinks.length > 0 && !matchedAnchor) {
      throw new Error(existingLinks.length > 1
        ? `La HU ${options.hu} tiene multiples Branch ArtifactLink distintos; no se puede elegir un ancla única`
        : `La HU ${options.hu} tiene una Branch ArtifactLink vinculada fuera del alcance declarado`);
    }

    const anchor = matchedAnchor ?? identities[0]!;
    const baseBranch = options.baseBranch?.trim() ? normalizeBranch(options.baseBranch).ref : null;
    if (!matchedAnchor && !baseBranch) {
      throw new Error(`La HU ${options.hu} no tiene una rama de integración vinculada; indique --base-branch <name>`);
    }

    const plan = await Promise.all(identities.map(async (identity) => {
      const isAnchor = identity.workingDirectory === anchor.workingDirectory;
      const effectiveBase = matchedAnchor && isAnchor ? null : baseBranch;
      const existed = !!(await remoteBranchSha(this.git, integrationBranch, identity.workingDirectory));
      const requiresBase = !existed && !!effectiveBase;
      const baseSha = requiresBase
        ? await remoteBranchSha(this.git, normalizeBranch(effectiveBase!).ref, identity.workingDirectory)
        : null;
      const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--ignored"], identity.workingDirectory);
      return { identity, isAnchor, effectiveBase, existed, baseSha, status };
    }));

    for (const { identity, existed, effectiveBase, baseSha, status } of plan) {
      if (!existed && !effectiveBase) {
        throw new Error(`La rama ${integrationBranch} no existe en ${identity.workingDirectory} y no se proporcionó base`);
      }
      if (!existed && !baseSha) {
        throw new Error(`La rama base ${normalizeBranch(effectiveBase!).ref} no existe remotamente`);
      }
      if (status.trim()) {
        throw new Error(`El repositorio ${identity.workingDirectory} tiene cambios sin guardar; no se creará la rama HU`);
      }
    }

    await this.verifyRemoteIdentities(identities);

    const units: AzureWorkspaceBranchUnit[] = [];
    for (const { identity, isAnchor, effectiveBase, existed } of plan) {
      const created = existed
        ? false
        : await this.createIntegrationBranchInRepository({
            hu: options.hu,
            identity,
            integrationBranch,
            baseBranch: effectiveBase,
            existingLink: existingLinks[0] ?? null,
            isAnchor,
          });
      const shouldLink = isAnchor && !existingLinks[0];
      if (shouldLink) {
        await this.linkIntegrationBranchArtifact({
          hu: options.hu,
          identity,
          integrationBranch,
        });
      }
      units.push({
        path: identity.workingDirectory,
        remote: identity.remote,
        repository: identity.repository,
        repositoryId: identity.repositoryId,
        projectId: identity.projectId,
        project: identity.project,
        integrationBranch,
        ticketBranch: null,
        integrationBranchCreated: created,
        ticketBranchCreated: false,
        ticketBranchAnchor: null,
      });
    }

    await this.verifyRemoteBranches(units);

    return {
      hu: options.hu,
      ticket: null,
      integrationBranch,
      anchor: {
        workingDirectory: anchor.workingDirectory,
        remote: anchor.remote,
        repository: anchor.repository,
        project: anchor.project,
        projectId: anchor.projectId,
        repositoryId: anchor.repositoryId,
      },
      ticketBranchAnchor: null,
      units,
    };
  }

  /**
   * Commits the ticket's single native Branch ArtifactLink to one participant repository. Branch
   * preparation cannot do this: the primary repository is the first one that actually changes, and
   * that is only known once the implementation session has produced its completion manifests.
   */
  async linkTicketBranch(hu: number, ticket: number, ticketBranch: string, workingDirectory: string): Promise<{ ticket: number; branch: string; workingDirectory: string }> {
    if (!Number.isInteger(hu) || hu <= 0) throw new Error(`La HU debe ser un entero positivo: ${hu}`);
    if (!Number.isInteger(ticket) || ticket <= 0) throw new Error(`El ticket debe ser un entero positivo: ${ticket}`);
    const branch = normalizeBranch(ticketBranch).ref;
    const identity = await this.resolveRepositoryIdentity({
      path: workingDirectory,
      remote: (await this.git(["remote", "get-url", "origin"], workingDirectory)).trim(),
    });
    const existing = uniqueBranchLinks(await show(ticket, true, this.az))[0] ?? null;
    if (existing) {
      if (existing.ref !== branch || existing.repository !== identity.repositoryId || existing.project !== identity.projectId) {
        throw new Error(`El ticket ${ticket} ya tiene una rama vinculada distinta; conflicto`);
      }
      return { ticket, branch, workingDirectory: identity.workingDirectory };
    }
    await this.linkTicketBranchArtifact({ hu, ticket, identity, ticketBranch: branch });
    const verified = uniqueBranchLinks(await show(ticket, true, this.az))[0] ?? null;
    if (!verified || verified.ref !== branch || verified.repository !== identity.repositoryId) {
      throw new Error(`No se pudo verificar la rama vinculada del ticket ${ticket}`);
    }
    return { ticket, branch, workingDirectory: identity.workingDirectory };
  }

  async prepareWorkspaceTicketBranches(options: {
    hu: number;
    ticket: number;
    integrationBranch: string;
    repositories: readonly AzureWorkspaceRepositoryInput[];
    ticketBranch?: string;
    ticketBranchAnchor?: string | null;
  }): Promise<AzureWorkspaceBranchTopology> {
    if (!Number.isInteger(options.hu) || options.hu <= 0) {
      throw new Error(`La HU debe ser un entero positivo: ${options.hu}`);
    }
    if (!Number.isInteger(options.ticket) || options.ticket <= 0) {
      throw new Error(`El ticket debe ser un entero positivo: ${options.ticket}`);
    }
    const identities = await Promise.all(options.repositories.map((repository) => this.resolveRepositoryIdentity(repository)));
    const parent = await show(options.hu, true, this.az);
    const projectName = field(parent, "System.TeamProject");
    if (!projectName) throw new Error("La HU no tiene proyecto Azure");
    const integrationBranch = normalizeBranch(options.integrationBranch).ref;
    const ticketBranch = normalizeBranch(options.ticketBranch ?? `refs/heads/ticket/${options.ticket}`).ref;
    const anchorPath = options.ticketBranchAnchor ?? null;
    const anchorIndex = anchorPath ? identities.findIndex((identity) => identity.workingDirectory === anchorPath) : -1;
    const anchor = anchorIndex >= 0 ? identities[anchorIndex]! : identities[0]!;

    const ticketItem = await show(options.ticket, true, this.az);
    const isDirectChild = (parent.relations ?? []).some((relation) =>
      relation.rel === "System.LinkTypes.Hierarchy-Forward" && relationId(relation.url) === options.ticket
    );
    if (!isDirectChild) throw new Error(`El ticket ${options.ticket} no es hijo directo de la HU ${options.hu}`);
    const existingTicketLinks = uniqueBranchLinks(ticketItem);
    const existingTicketLink = existingTicketLinks[0] ?? null;
    if (existingTicketLink && existingTicketLink.ref !== ticketBranch) {
      throw new Error(`El ticket ${options.ticket} ya tiene una rama vinculada distinta; conflicto`);
    }

    const plan = await Promise.all(identities.map(async (identity) => {
      const integrationBranchSha = await remoteBranchSha(this.git, integrationBranch, identity.workingDirectory);
      const ticketBranchSha = await remoteBranchSha(this.git, ticketBranch, identity.workingDirectory);
      const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--ignored"], identity.workingDirectory);
      return { identity, integrationBranchSha, ticketBranchSha, status };
    }));

    for (const { identity, integrationBranchSha, ticketBranchSha, status } of plan) {
      if (!integrationBranchSha) throw new Error(`La rama de integración ${integrationBranch} no existe remotamente en ${identity.workingDirectory}`);
      if (ticketBranchSha && ticketBranchSha !== integrationBranchSha) {
        throw new Error(`La rama del ticket ${ticketBranch} no coincide con la rama de integración de la HU`);
      }
      if (!ticketBranchSha && status.trim()) {
        throw new Error(`El repositorio ${identity.workingDirectory} tiene cambios sin guardar; no se creará la rama del ticket`);
      }
    }

    const units: AzureWorkspaceBranchUnit[] = [];
    for (const { identity, ticketBranchSha, integrationBranchSha } of plan) {
      const created = ticketBranchSha === integrationBranchSha
        ? false
        : await this.createTicketBranchInRepository({
            hu: options.hu,
            ticket: options.ticket,
            identity,
            integrationBranch,
            ticketBranch,
          });
      units.push({
        path: identity.workingDirectory,
        remote: identity.remote,
        repository: identity.repository,
        repositoryId: identity.repositoryId,
        projectId: identity.projectId,
        project: identity.project,
        integrationBranch,
        ticketBranch,
        integrationBranchCreated: false,
        ticketBranchCreated: created,
        ticketBranchAnchor: null,
      });
    }

    const anchorUnit = units.find((unit) => unit.path === anchor.workingDirectory);
    if (!anchorUnit) throw new Error(`El ancla del ticket ${options.ticket} no pertenece al alcance`);
    anchorUnit.ticketBranchAnchor = anchor.workingDirectory;
    for (const unit of units) {
      if (unit.path !== anchor.workingDirectory) unit.ticketBranchAnchor = anchor.workingDirectory;
    }

    return {
      hu: options.hu,
      ticket: options.ticket,
      integrationBranch,
      ticketBranch,
      anchor: {
        workingDirectory: anchor.workingDirectory,
        remote: anchor.remote,
        repository: anchor.repository,
        project: anchor.project,
        projectId: anchor.projectId,
        repositoryId: anchor.repositoryId,
      },
      ticketBranchAnchor: anchor.workingDirectory,
      units,
    };
  }

  private async resolveRepositoryIdentity(repository: AzureWorkspaceRepositoryInput): Promise<AzureWorkspaceRepositoryIdentity> {
    const origin = parseAzureOrigin(await this.git(["remote", "get-url", "origin"], repository.path));
    const repositoryOutput = await this.az([
      "repos", "show", "--organization", ORGANIZATION,
      "--project", origin.project, "--repository", origin.repository, "--output", "json",
    ]);
    const azure = JSON.parse(repositoryOutput) as AzureRepository;
    if (!azure.id || !azure.name || !azure.project?.id || !azure.project.name) {
      throw new Error(`El repositorio Azure ${origin.repository} no es identificable`);
    }
    if (!same(azure.name, origin.repository) || !same(azure.project.name, origin.project)) {
      throw new Error(`El repositorio Azure no coincide con el origen declarado: ${repository.path}`);
    }
    return {
      workingDirectory: repository.path,
      remote: repository.remote,
      repository: azure.name,
      project: azure.project.name,
      projectId: azure.project.id,
      repositoryId: azure.id,
    };
  }

  private async createIntegrationBranchInRepository(options: {
    hu: number;
    identity: AzureWorkspaceRepositoryIdentity;
    integrationBranch: string;
    baseBranch: string | null;
    existingLink: BranchLink | null;
    isAnchor: boolean;
  }): Promise<boolean> {
    if (!options.baseBranch) {
      throw new Error(`La rama ${options.integrationBranch} no existe en ${options.identity.workingDirectory} y no se proporcionó base`);
    }
    const base = normalizeBranch(options.baseBranch);
    if (base.ref === options.integrationBranch) throw new Error("La base remota no puede ser la rama HU");
    const baseSha = await remoteBranchSha(this.git, base.ref, options.identity.workingDirectory);
    if (!baseSha) throw new Error(`La rama base ${base.ref} no existe remotamente`);
    const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--ignored"], options.identity.workingDirectory);
    if (status.trim()) throw new Error(`El repositorio ${options.identity.workingDirectory} tiene cambios sin guardar; no se creará la rama HU`);
    const localBaseRef = `refs/lazy-workflow/${crypto.randomUUID()}`;
    try {
      const existingRef = (await this.git(["for-each-ref", "--format=%(refname)", localBaseRef], options.identity.workingDirectory)).trim();
      if (existingRef) throw new Error(`El ref temporal local ${localBaseRef} ya existe`);
      await this.git(["fetch", "--no-tags", "origin", `+${base.ref}:${localBaseRef}`], options.identity.workingDirectory);
      const fetchedSha = (await this.git(["rev-parse", `${localBaseRef}^{commit}`], options.identity.workingDirectory)).trim();
      if (fetchedSha !== baseSha) throw new Error(`La base remota ${base.ref} cambió durante la preparación`);
      await this.git(["push", "origin", `${localBaseRef}:${options.integrationBranch}`], options.identity.workingDirectory);
      const publishedSha = await remoteBranchSha(this.git, options.integrationBranch, options.identity.workingDirectory);
      if (publishedSha !== baseSha) {
        throw new Error(`No se pudo verificar remotamente la rama ${options.integrationBranch} desde ${base.ref}`);
      }
    } finally {
      await this.git(["update-ref", "-d", localBaseRef], options.identity.workingDirectory);
    }
    return true;
  }

  private async createTicketBranchInRepository(options: {
    hu: number;
    ticket: number;
    identity: AzureWorkspaceRepositoryIdentity;
    integrationBranch: string;
    ticketBranch: string;
  }): Promise<boolean> {
    const integrationSha = await remoteBranchSha(this.git, options.integrationBranch, options.identity.workingDirectory);
    if (!integrationSha) throw new Error(`La rama de integración ${options.integrationBranch} no existe remotamente en ${options.identity.workingDirectory}`);
    const status = await this.git(["status", "--porcelain", "--untracked-files=all", "--ignored"], options.identity.workingDirectory);
    if (status.trim()) throw new Error(`El repositorio ${options.identity.workingDirectory} tiene cambios sin guardar; no se creará la rama del ticket`);
    const temporaryRef = `refs/lazy-workflow/${crypto.randomUUID()}`;
    try {
      const existingRef = (await this.git(["for-each-ref", "--format=%(refname)", temporaryRef], options.identity.workingDirectory)).trim();
      if (existingRef) throw new Error(`El ref temporal local ${temporaryRef} ya existe`);
      await this.git(["fetch", "--no-tags", "origin", `+${options.integrationBranch}:${temporaryRef}`], options.identity.workingDirectory);
      const fetchedSha = (await this.git(["rev-parse", `${temporaryRef}^{commit}`], options.identity.workingDirectory)).trim();
      if (fetchedSha !== integrationSha) throw new Error(`La rama de integración ${options.integrationBranch} cambió durante la preparación`);
      await this.git(["push", "origin", `${temporaryRef}:${options.ticketBranch}`], options.identity.workingDirectory);
      const publishedSha = await remoteBranchSha(this.git, options.ticketBranch, options.identity.workingDirectory);
      if (publishedSha !== integrationSha) throw new Error(`No se pudo verificar remotamente la rama ${options.ticketBranch}`);
    } finally {
      await this.git(["update-ref", "-d", temporaryRef], options.identity.workingDirectory);
    }
    return true;
  }

  private async linkIntegrationBranchArtifact(options: {
    hu: number;
    identity: AzureWorkspaceRepositoryIdentity;
    integrationBranch: string;
  }): Promise<void> {
    const normalized = normalizeBranch(options.integrationBranch);
    const artifactUrl = `vstfs:///Git/Ref/${encodeURIComponent(`${options.identity.projectId}/${options.identity.repositoryId}/GB${normalized.name}`)}`;
    const patchBody = JSON.stringify([{
      op: "add",
      path: "/relations/-",
      value: { rel: "ArtifactLink", url: artifactUrl, attributes: { name: "Branch" } },
    }]);
    await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE,
      "--method", "patch",
      "--uri", `${ORGANIZATION}/${options.identity.projectId}/_apis/wit/workitems/${options.hu}?api-version=${WORK_ITEM_API_VERSION}`,
      "--headers", "Content-Type=application/json-patch+json",
      "--body", patchBody,
      "--output", "json",
    ]);
    const verified = await this.getIntegrationBranchInfo(options.hu);
    if (verified.branch !== normalized.ref) {
      throw new Error(`No se pudo verificar en Azure la rama ${normalized.ref}`);
    }
  }

  private async linkTicketBranchArtifact(options: {
    hu: number;
    ticket: number;
    identity: AzureWorkspaceRepositoryIdentity;
    ticketBranch: string;
  }): Promise<void> {
    const normalized = normalizeBranch(options.ticketBranch);
    const artifactUrl = `vstfs:///Git/Ref/${encodeURIComponent(`${options.identity.projectId}/${options.identity.repositoryId}/GB${normalized.name}`)}`;
    const revision = await this.fetchTicketRevision(options.ticket);
    const patchBody = JSON.stringify([
      { op: "test", path: "/rev", value: revision },
      {
        op: "add",
        path: "/relations/-",
        value: { rel: "ArtifactLink", url: artifactUrl, attributes: { name: "Branch" } },
      },
    ]);
    await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE,
      "--method", "patch",
      "--uri", `${ORGANIZATION}/${options.identity.projectId}/_apis/wit/workitems/${options.ticket}?api-version=${WORK_ITEM_API_VERSION}`,
      "--headers", "Content-Type=application/json-patch+json",
      "--body", patchBody,
      "--output", "json",
    ]);
  }

  private async fetchTicketRevision(ticket: number): Promise<number> {
    const item = await show(ticket, true, this.az);
    const revision = item.rev;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision <= 0) {
      throw new Error(`El ticket ${ticket} no tiene una revisión Azure válida`);
    }
    return revision;
  }

  private async verifyRemoteBranches(units: readonly AzureWorkspaceBranchUnit[]): Promise<void> {
    for (const unit of units) {
      const sha = await remoteBranchSha(this.git, unit.integrationBranch, unit.path);
      if (!sha) throw new Error(`La rama ${unit.integrationBranch} no existe remotamente en ${unit.path}`);
    }
  }

  private async verifyRemoteIdentities(identities: readonly AzureWorkspaceRepositoryIdentity[]): Promise<void> {
    for (const identity of identities) {
      const origin = await this.git(["remote", "get-url", "origin"], identity.workingDirectory);
      const parsed = parseAzureOrigin(origin);
      if (!same(parsed.repository, identity.repository) || !same(parsed.project, identity.project)) {
        throw new Error(`El remote de ${identity.workingDirectory} no coincide con la identidad Azure resuelta`);
      }
    }
  }

  async getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null> {
    return (await this.getAutocodeState(hu, integrationBranch)).context;
  }

  async getAutocodeContextForTicket(
    hu: number,
    ticket: number,
    integrationBranch?: string,
  ): Promise<AutocodeContext | null> {
    const [parent, item] = await Promise.all([
      show(hu, true, this.az),
      show(ticket, false, this.az),
    ]);
    const isDirectChild = (parent.relations ?? []).some((relation) =>
      relation.rel === "System.LinkTypes.Hierarchy-Forward" && relationId(relation.url) === ticket
    );
    const type = field(item, "System.WorkItemType");
    const branch = integrationBranch ?? integrationBranchFrom(parent);
    if (!isDirectChild || (type !== "Task" && type !== "Bug") || !branch) return null;
    return {
      hu: { id: hu, title: field(parent, "System.Title") },
      ticket: {
        id: ticket,
        title: field(item, "System.Title"),
        type,
        state: field(item, "System.State"),
        createdDate: field(item, "System.CreatedDate"),
      },
      integrationBranch: branch,
      project: field(parent, "System.TeamProject"),
    };
  }

  async getAutocodeState(hu: number, integrationBranch?: string): Promise<AutocodeState> {
    const parent = await show(hu, true, this.az);
    const children = (parent.relations ?? [])
      .filter((relation) => relation.rel === "System.LinkTypes.Hierarchy-Forward")
      .map((relation) => relationId(relation.url))
      .filter((id): id is number => id !== undefined);
    const candidates = await Promise.all(children.map((id) => show(id, true, this.az)));
    const eligible: DeliveryTicket[] = [];
    let pending = false;
    for (const item of candidates) {
      const type = field(item, "System.WorkItemType");
      const state = field(item, "System.State");
      if ((type !== "Task" && type !== "Bug") || (state && COMPLETED_STATES.has(state))) continue;
      pending = true;
      const predecessorIds = (item.relations ?? [])
        .filter((relation) => relation.rel === "System.LinkTypes.Dependency-Reverse")
        .map((relation) => relationId(relation.url))
        .filter((id): id is number => id !== undefined);
      const predecessors = await Promise.all(predecessorIds.map((id) => show(id, false, this.az)));
      if (predecessors.some((predecessor) => !COMPLETED_STATES.has(field(predecessor, "System.State") ?? ""))) continue;
      eligible.push({
        id: item.id,
        title: field(item, "System.Title"),
        type,
        state,
        createdDate: field(item, "System.CreatedDate"),
        revision: item.rev,
        effort: {
          real: typeof item.fields?.["Custom.EsfuerzoReal"] === "number" ? item.fields["Custom.EsfuerzoReal"] as number : undefined,
          realHours: typeof item.fields?.["Custom.EsfuerzoRealHH"] === "number" ? item.fields["Custom.EsfuerzoRealHH"] as number : undefined,
        },
      });
    }
    eligible.sort((a, b) => (a.createdDate ?? "").localeCompare(b.createdDate ?? "") || a.id - b.id);
    const branch = integrationBranch ?? integrationBranchFrom(parent);
    if (!branch || eligible.length === 0) return { context: null, pending };
    return {
      context: {
        hu: { id: hu, title: field(parent, "System.Title") },
        ticket: eligible[0]!,
        integrationBranch: branch,
        project: field(parent, "System.TeamProject"),
      },
      pending,
    };
  }

  async verifyTicketCompletion(context: AutocodeContext): Promise<TicketCompletionVerification> {
    const [item, parent] = await Promise.all([
      show(context.ticket.id, true, this.az),
      show(context.hu.id, true, this.az),
    ]);

    const unmetGates: CompletionGate[] = [];
    if (field(item, "System.State") !== "Done") unmetGates.push(COMPLETION_GATE.ticketState);
    const evidence = firstField(item, COMPLETION_EVIDENCE_FIELDS);
    if (!evidence?.trim()) unmetGates.push(COMPLETION_GATE.completionEvidence);
    if (!positiveNumberField(item, "Custom.EsfuerzoReal")) unmetGates.push(COMPLETION_GATE.realEffort);
    if (!positiveNumberField(item, "Custom.EsfuerzoRealHH")) unmetGates.push(COMPLETION_GATE.realEffortHours);
    if (!field(item, "Custom.URLCommit")?.trim()) unmetGates.push(COMPLETION_GATE.commitUrl);
    if (!(item.relations ?? []).some((relation) =>
      relation.rel === "AttachedFile"
      && ["http-json", "screen", "command-output"].includes(relation.attributes?.comment ?? "")
      && /^[0-9a-f]{64}$/i.test(relation.attributes?.digest ?? "")
    )) {
      unmetGates.push(COMPLETION_GATE.attachedCapture);
    }
    if (integrationBranchFrom(parent) !== context.integrationBranch) {
      unmetGates.push(COMPLETION_GATE.huIntegrationBranch);
    }
    const pr = await this.getCompletedPullRequest(context);
    if (!pr) {
      unmetGates.push(COMPLETION_GATE.completedHuPullRequest);
      return { ticketId: context.ticket.id, unmetGates };
    }
    const artifactPrefix = `${pr.projectId}/${pr.repositoryId}`;
    if (!await this.isPullRequestLinkedToTicket(pr.id!, context.ticket.id)) {
      unmetGates.push(COMPLETION_GATE.nativePullRequestAssociation);
    }
    if (!hasArtifactLink(item, `vstfs:///Git/Commit/${artifactPrefix}/${pr.mergeCommit}`)) {
      unmetGates.push(COMPLETION_GATE.mergeCommitArtifact);
    }
    if (unmetGates.length > 0) return { ticketId: context.ticket.id, unmetGates };
    return { ticketBranch: pr.source! };
  }

  async getCompletedTicketBranch(context: AutocodeContext): Promise<string | null> {
    return (await this.getCompletedPullRequest(context))?.source ?? null;
  }

  private async getCompletedPullRequest(context: AutocodeContext): Promise<CompletedPullRequest | null> {
    const output = await this.az([
      "repos", "pr", "list", "--organization", ORGANIZATION,
      ...(context.project ? ["--project", context.project] : []),
      "--status", "completed", "--target-branch", context.integrationBranch,
      "--query", `[?contains(sourceRefName, '${context.ticket.id}')].{status:status,mergeStatus:mergeStatus,target:targetRefName,source:sourceRefName,id:pullRequestId,projectId:repository.project.id,repositoryId:repository.id,mergeCommit:lastMergeCommit.commitId}`,
      "--output", "json",
    ]);
    const prs = (JSON.parse(output) as CompletedPullRequest[])
      .filter((pr) => belongsToTicket(pr.source, context.ticket.id))
      .filter((pr) => pr.status === "completed"
      && pr.mergeStatus === "succeeded"
      && pr.target === context.integrationBranch
      && pr.source?.startsWith("refs/heads/")
      && Number.isInteger(pr.id)
      && typeof pr.projectId === "string"
      && typeof pr.repositoryId === "string"
      && typeof pr.mergeCommit === "string");
    if (prs.length === 1) return prs[0]!;
    if (prs.length === 0) return null;

    const associated = (await Promise.all(prs.map(async (pr) => ({
      pr,
      linked: await this.isPullRequestLinkedToTicket(pr.id!, context.ticket.id),
    })))).filter(({ linked }) => linked);
    return associated.length === 1 ? associated[0]!.pr : null;
  }

  private async isPullRequestLinkedToTicket(
    pullRequest: number,
    ticket: number,
  ): Promise<boolean> {
    const output = await this.az([
      "repos", "pr", "work-item", "list",
      "--id", `${pullRequest}`,
      "--organization", ORGANIZATION,
      "--query", "[].id",
      "--output", "json",
    ]);
    const workItems = JSON.parse(output) as Array<number | string>;
    return workItems.some((id) => Number(id) === ticket);
  }

  async waitForAccess(hu: number): Promise<void> {
    reportOperator("OpenCode requiere autenticacion Azure. Ejecuta: az login --use-device-code");
    let attempts = 0;
    while (true) {
      try { await this.getHuInfo(hu); return; } catch (error) {
        attempts += 1;
        if (attempts % 5 === 0) {
          reportOperator(`Esperando acceso Azure para la HU ${hu}... Último error: ${commandError(error)}`);
        }
        await Bun.sleep(2_000);
      }
    }
  }
}

function commandError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (stderr instanceof Uint8Array) {
      const decoded = new TextDecoder().decode(stderr).trim();
      if (decoded) return decoded;
    }
    if (stderr !== undefined && String(stderr).trim()) return String(stderr).trim();
  }
  return error instanceof Error ? error.message : String(error);
}

interface AzureOrigin {
  organization: string;
  project: string;
  repository: string;
}

function same(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function parseAzureOrigin(value: string): AzureOrigin {
  const raw = value.trim();
  const ssh = raw.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (ssh) return { organization: ssh[1]!, project: decodeSegment(ssh[2]!), repository: decodeSegment(ssh[3]!) };
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("origin no es un repositorio Azure válido"); }
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  const gitIndex = segments.indexOf("_git");
  if (gitIndex < 1 || !["dev.azure.com", "visualstudio.com"].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new Error("origin no es un repositorio Azure válido");
  }
  const organization = hostname === "dev.azure.com" ? segments[0] : hostname.split(".")[0];
  const project = segments[gitIndex - 1];
  const repository = segments[gitIndex + 1]?.replace(/\.git$/, "");
  if (!organization || !project || !repository || gitIndex + 1 !== segments.length - 1) {
    throw new Error("origin Azure no contiene proyecto y repositorio válidos");
  }
  return { organization, project, repository };
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new Error("origin Azure contiene una ruta malformada"); }
}

async function remoteBranchSha(
  git: GitRunner,
  ref: string,
  workingDirectory: string,
): Promise<string | null> {
  const output = await git(["ls-remote", "--heads", "origin", ref], workingDirectory);
  const matches = output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.split(/\s+/)[1] === ref);
  if (matches.length > 1) throw new Error(`La referencia remota ${ref} es ambigua`);
  if (matches.length === 0) return null;
  const sha = matches[0]!.split(/\s+/)[0]!;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)) {
    throw new Error(`La referencia remota ${ref} no devolvió un commit válido`);
  }
  return sha;
}

function normalizeBranch(value: string): { ref: string; name: string } {
  const input = value.trim();
  const prefix = "refs/heads/";
  if (input.startsWith("refs/") && !input.startsWith(prefix)) throw new Error(`Rama no válida: ${value}`);
  const name = input.startsWith(prefix) ? input.slice(prefix.length) : input;
  const parts = name.split("/");
  if (
    name === "HEAD"
    || !name
    || !/^[A-Za-z0-9._/-]+$/.test(name)
    || name.includes("..")
    || name.includes("//")
    || name.startsWith("/")
    || name.endsWith("/")
    || name.includes("@{")
    || parts.some((part) => part === "." || part === ".." || part.startsWith(".") || part.endsWith(".") || part.toLowerCase().endsWith(".lock"))
  ) throw new Error(`Rama no válida: ${value}`);
  return { ref: `${prefix}${name}`, name };
}
