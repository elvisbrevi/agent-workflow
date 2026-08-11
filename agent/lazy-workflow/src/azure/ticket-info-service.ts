import { $ } from "bun";

const ORGANIZATION = "https://dev.azure.com/SubdepartamentoSolucionesTI";
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EVIDENCE_KINDS = ["http-json", "screen", "command-output"] as const;

const COMPLETION_FIELDS = [
  "Custom.CompletionEvidence",
  "Custom.b505c83e-3745-4d8b-b76b-b3086a0c4c71",
] as const;

const GATE = {
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

export type CompletionGate = typeof GATE[keyof typeof GATE];

export interface TicketSummary {
  id: number;
  type: "Task" | "Bug";
  title?: string;
  description?: string;
  state?: string;
  revision?: number;
  createdDate?: string;
  assignedTo?: string;
}

export interface TicketPullRequest {
  id: number;
  status?: string;
  mergeStatus?: string;
  source?: string;
  target?: string;
  mergeCommit?: string;
  repositoryId?: string;
  projectId?: string;
  associated: boolean;
}

export interface TicketAttachment {
  name?: string;
  url?: string;
  kind: "AttachedFile";
  evidenceKind?: EvidenceKind;
  digest?: string;
}

export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export interface TicketInfo {
  hu: { id: number; title?: string };
  ticket: TicketSummary;
  branch: string | null;
  integrationBranch: string | null;
  effort: { estimated?: number; real?: number; realHours?: number };
  pullRequests: TicketPullRequest[];
  canonicalPullRequest: number | null;
  mergeCommit: string | null;
  attachments: TicketAttachment[];
  completionEvidence: string | null;
  gates: { satisfied: CompletionGate[]; unmet: CompletionGate[] };
}

interface Relation {
  rel?: string;
  url?: string;
  attributes?: { name?: string; comment?: string; digest?: string };
}

interface WorkItem {
  id: number;
  rev?: number;
  fields?: Record<string, unknown>;
  relations?: Relation[];
}

interface PullRequestPayload {
  pullRequestId?: number;
  id?: number;
  status?: string;
  mergeStatus?: string;
  sourceRefName?: string;
  source?: string;
  targetRefName?: string;
  target?: string;
  lastMergeCommit?: { commitId?: string };
  mergeCommit?: string;
  repository?: { id?: string; project?: { id?: string } };
  repositoryId?: string;
  projectId?: string;
}

interface FixedCommitLink {
  project: string;
  repository: string;
  commit: string;
}

export type AzRunner = (args: string[]) => Promise<string>;

function positiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} debe ser un entero positivo: ${value}`);
}

function text(item: WorkItem, name: string): string | undefined {
  const value = item.fields?.[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function evidenceKind(value: string | undefined): EvidenceKind | undefined {
  return EVIDENCE_KINDS.includes(value as EvidenceKind) ? value as EvidenceKind : undefined;
}

function hasEvidenceCapture(item: WorkItem): boolean {
  return (item.relations ?? []).some(({ rel, attributes }) =>
    rel === "AttachedFile"
      && evidenceKind(attributes?.comment) !== undefined
      && /^[0-9a-f]{64}$/i.test(attributes?.digest ?? "")
  );
}

function number(item: WorkItem, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = item.fields?.[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function assignedTo(item: WorkItem): string | undefined {
  const value = item.fields?.["System.AssignedTo"];
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "displayName" in value) {
    const displayName = (value as { displayName?: unknown }).displayName;
    return typeof displayName === "string" ? displayName : undefined;
  }
  return undefined;
}

function relationId(url: string | undefined): number | undefined {
  const match = url?.match(/workItems\/(\d+)$/i);
  return match ? Number(match[1]) : undefined;
}

function branchParts(url: string): { project: string; repository: string; branch: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    throw new Error("Branch ArtifactLink con URI malformada");
  }
  const match = decoded.match(/^vstfs:\/\/\/Git\/Ref\/([^/]+)\/([^/]+)\/GB(.+)$/);
  const branch = match?.[3];
  const parts = branch?.split("/") ?? [];
  if (
    !match || !branch || branch === "HEAD" || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")
    || branch.includes("..") || branch.includes("@{")
    || parts.some((part) => part === "." || part === ".." || part.startsWith(".") || part.endsWith(".") || part.toLowerCase().endsWith(".lock"))
  ) {
    throw new Error("Branch ArtifactLink con URI de rama Azure Git malformada");
  }
  return { project: match[1]!, repository: match[2]!, branch };
}

function branchLinks(item: WorkItem): Array<{ ref: string; project: string; repository: string }> {
  return (item.relations ?? [])
    .filter(({ rel, attributes }) => rel === "ArtifactLink" && attributes?.name === "Branch")
    .map(({ url }) => {
      if (!url) throw new Error("Branch ArtifactLink sin URI");
      const parts = branchParts(url);
      return { ...parts, ref: `refs/heads/${parts.branch}` };
    });
}

function uniqueBranch(item: WorkItem): { ref: string | null; project?: string; repository?: string } {
  const links = branchLinks(item);
  const unique = [...new Map(links.map((link) => [`${link.project}/${link.repository}/${link.ref}`, link])).values()];
  if (unique.length > 1) throw new Error("existen multiples Branch ArtifactLink distintos");
  return unique[0] ?? { ref: null };
}

function hasTicketNumber(ref: string | undefined, ticket: number): boolean {
  if (!ref?.startsWith("refs/heads/")) return false;
  return new RegExp(`(?:^|[/_.-])${ticket}(?:$|[/_.-])`).test(ref.slice("refs/heads/".length));
}

function fixedCommit(item: WorkItem): FixedCommitLink | null {
  const links = (item.relations ?? [])
    .filter(({ rel, attributes, url }) => rel === "ArtifactLink" && (
      attributes?.name === "Fixed in Commit" || url?.includes("vstfs:///Git/Commit/")
    ));
  const commits = links.map(({ url }) => {
    if (!url) throw new Error("Fixed in Commit ArtifactLink sin URI");
    let decoded: string;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      throw new Error("Fixed in Commit ArtifactLink con URI malformada");
    }
    const match = decoded.match(/^vstfs:\/\/\/Git\/Commit\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) throw new Error("Fixed in Commit ArtifactLink con URI malformada");
    return { project: match[1]!, repository: match[2]!, commit: match[3]! };
  });
  const unique = [...new Map(commits.map((commit) => [`${commit.project}/${commit.repository}/${commit.commit}`, commit])).values()];
  if (unique.length > 1) throw new Error("existen multiples Fixed in Commit ArtifactLink distintos");
  return unique[0] ?? null;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/("?(?:accessToken|authorization|token|password|cookie)"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

function commandError(error: unknown): Error {
  return new Error(`Azure command failed: ${sanitizeError(error)}`, { cause: error });
}

function validateEvidenceKind(kind: string): asserts kind is EvidenceKind {
  if (!EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
    throw new Error(`Tipo de evidencia no soportado: ${kind}`);
  }
}

function validateEvidenceContent(content: string, kind: EvidenceKind): void {
  if (/(?:["']?(?:authorization|access[_-]?token|token|api[_-]?key|secret|password|cookie|set-cookie)["']?\s*[:=]|--(?:token|api-key|password)\s+\S+|(?:AZURE_DEVOPS_EXT_PAT|(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD))\s*=|bearer\s+[a-z0-9._~-]+)/i.test(content)) {
    throw new Error("La evidencia contiene credenciales o secretos");
  }
  if (/<script\b|javascript\s*:|\bon[a-z]+\s*=/i.test(content)) {
    throw new Error("La evidencia contiene contenido ejecutable no permitido");
  }
  if (kind === "http-json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("La evidencia JSON no es válida");
    }
    if (content.trim() !== JSON.stringify(parsed, null, 2)) {
      throw new Error("La evidencia JSON debe estar pretty-printed con indentación estable");
    }
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function runAzureCommand(args: string[]): Promise<string> {
  try {
    return await $`az ${args}`.text();
  } catch (error) {
    throw commandError(error);
  }
}

export class AzureTicketInfoService {
  constructor(private readonly az: AzRunner = runAzureCommand) {}

  async getTicket(ticket: number): Promise<TicketSummary> {
    positiveId(ticket, "El ticket");
    return this.toSummary(await this.readWorkItem(ticket));
  }

  async getTicketInfo(hu: number, ticket: number): Promise<TicketInfo> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    const [parent, item] = await Promise.all([this.readWorkItem(hu), this.readWorkItem(ticket)]);
    const summary = this.toSummary(item);
    const child = (parent.relations ?? []).some(({ rel, url }) =>
      rel === "System.LinkTypes.Hierarchy-Forward" && relationId(url) === ticket
    );
    if (!child) throw new Error(`El ticket ${ticket} no es hijo directo de la HU ${hu}`);

    const integrationBranch = uniqueBranch(parent);
    const ticketBranch = uniqueBranch(item);
    if (ticketBranch.ref && (
      ticketBranch.project !== integrationBranch.project
      || ticketBranch.repository !== integrationBranch.repository
    )) {
      throw new Error(`La rama del ticket ${ticket} no coincide con la rama de integracion de la HU`);
    }
    const pullRequests = (await this.readPullRequests(
      ticket,
      integrationBranch.project ?? text(parent, "System.TeamProject"),
      integrationBranch.ref,
      integrationBranch.project,
      integrationBranch.repository,
      ticketBranch.ref,
    )).filter((pullRequest) =>
      pullRequest.status === "completed"
      && pullRequest.mergeStatus === "succeeded"
      && pullRequest.target === integrationBranch.ref
    );
    const validPullRequests = pullRequests;
    const associated = validPullRequests.filter((pullRequest) => pullRequest.associated);
    const canonical = associated.length === 1 ? associated[0]!.id : null;
    const completionEvidence = COMPLETION_FIELDS.map((fieldName) => text(item, fieldName)).find(Boolean) ?? null;
    const linkedCommit = fixedCommit(item);
    const mergeCommit = pullRequests.find(({ id }) => id === canonical)?.mergeCommit ?? linkedCommit?.commit ?? null;
    const unmet = this.unmetGates(
      summary,
      item,
      integrationBranch.ref,
      pullRequests,
      canonical,
      completionEvidence,
      mergeCommit,
      linkedCommit,
    );

    return {
      hu: { id: hu, title: text(parent, "System.Title") },
      ticket: summary,
      branch: ticketBranch.ref,
      integrationBranch: integrationBranch.ref,
      effort: {
        estimated: number(item, ["Microsoft.VSTS.Scheduling.OriginalEstimate", "Custom.Estimacion"]),
        real: number(item, ["Custom.EsfuerzoReal"]),
        realHours: number(item, ["Custom.EsfuerzoRealHH"]),
      },
      pullRequests,
      canonicalPullRequest: canonical,
      mergeCommit,
      attachments: (item.relations ?? [])
        .filter(({ rel }) => rel === "AttachedFile")
        .map(({ url, attributes }) => ({
          kind: "AttachedFile" as const,
          name: attributes?.name,
          url,
          evidenceKind: evidenceKind(attributes?.comment),
          digest: attributes?.digest,
        })),
      completionEvidence,
      gates: {
        satisfied: Object.values(GATE).filter((gate) => !unmet.includes(gate)),
        unmet,
      },
    };
  }

  async getBranch(hu: number, ticket: number): Promise<{ hu: number; ticket: number; branch: string | null; integrationBranch: string | null }> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    const [parent, item] = await Promise.all([this.readWorkItem(hu), this.readWorkItem(ticket)]);
    this.toSummary(item);
    if (!(parent.relations ?? []).some(({ rel, url }) =>
      rel === "System.LinkTypes.Hierarchy-Forward" && relationId(url) === ticket
    )) throw new Error(`El ticket ${ticket} no es hijo directo de la HU ${hu}`);
    const integrationBranch = uniqueBranch(parent);
    const ticketBranch = uniqueBranch(item);
    if (ticketBranch.ref && (
      ticketBranch.project !== integrationBranch.project
      || ticketBranch.repository !== integrationBranch.repository
    )) throw new Error(`La rama del ticket ${ticket} no coincide con la rama de integracion de la HU`);
    return { hu, ticket, branch: ticketBranch.ref, integrationBranch: integrationBranch.ref };
  }

  async getDescription(ticket: number): Promise<{ ticket: number; description: string | null }> {
    const item = await this.readWorkItemValidated(ticket);
    return { ticket, description: text(item, "System.Description") ?? null };
  }

  async getState(ticket: number): Promise<{ ticket: number; state: string | null; revision: number | null }> {
    const item = await this.readWorkItemValidated(ticket);
    return { ticket, state: text(item, "System.State") ?? null, revision: item.rev ?? null };
  }

  async getEffort(ticket: number): Promise<{ ticket: number; effort: { estimated?: number; real?: number; realHours?: number } }> {
    const item = await this.readWorkItemValidated(ticket);
    return {
      ticket,
      effort: {
        estimated: number(item, ["Microsoft.VSTS.Scheduling.OriginalEstimate", "Custom.Estimacion"]),
        real: number(item, ["Custom.EsfuerzoReal"]),
        realHours: number(item, ["Custom.EsfuerzoRealHH"]),
      },
    };
  }

  async getAttachments(ticket: number): Promise<{ ticket: number; attachments: TicketAttachment[] }> {
    const item = await this.readWorkItemValidated(ticket);
    return {
      ticket,
      attachments: (item.relations ?? [])
        .filter(({ rel }) => rel === "AttachedFile")
        .map(({ url, attributes }) => ({
          kind: "AttachedFile" as const,
          name: attributes?.name,
          url,
          evidenceKind: evidenceKind(attributes?.comment),
          digest: attributes?.digest,
        })),
    };
  }

  async getEvidence(ticket: number): Promise<{ ticket: number; completionEvidence: string | null }> {
    const item = await this.readWorkItemValidated(ticket);
    return { ticket, completionEvidence: COMPLETION_FIELDS.map((name) => text(item, name)).find(Boolean) ?? null };
  }

  async linkPullRequest(
    hu: number,
    ticket: number,
    pullRequestId: number,
  ): Promise<{ hu: number; ticket: number; pullRequest: number; mergeCommit: string }> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    positiveId(pullRequestId, "El pull request");

    const [parent, item] = await Promise.all([this.readWorkItem(hu), this.readWorkItem(ticket)]);
    const summary = this.toSummary(item);
    if (!(parent.relations ?? []).some(({ rel, url }) =>
      rel === "System.LinkTypes.Hierarchy-Forward" && relationId(url) === ticket
    )) throw new Error(`El ticket ${ticket} no es hijo directo de la HU ${hu}`);

    const integration = uniqueBranch(parent);
    const ticketBranch = uniqueBranch(item);
    if (!integration.ref) throw new Error(`La HU ${hu} no tiene una rama de integración vinculada`);
    if (!ticketBranch.ref) throw new Error(`El ticket ${ticket} no tiene una rama vinculada`);
    if (ticketBranch.project !== integration.project || ticketBranch.repository !== integration.repository) {
      throw new Error(`La rama del ticket ${ticket} no coincide con la rama de integración de la HU`);
    }

    const pullRequest = await this.readPullRequest(pullRequestId, integration.project, integration.repository);
    this.validatePullRequest(pullRequest, ticket, integration, ticketBranch);
    const candidates = await this.readPullRequests(ticket, integration.project, integration.ref, integration.project, integration.repository, ticketBranch.ref);
    const validCandidates = candidates.filter((candidate) =>
      candidate.status === "completed" && candidate.mergeStatus === "succeeded" && candidate.target === integration.ref
    );
    const associatedCandidates = validCandidates.filter((candidate) => candidate.associated);
    if (associatedCandidates.length > 1 || (associatedCandidates[0] && associatedCandidates[0].id !== pullRequestId)) {
      throw new Error(`El PR ${pullRequestId} entra en conflicto con el PR canónico ya asociado al ticket ${ticket}`);
    }
    if (!associatedCandidates[0]) {
      await this.addPullRequestWorkItem(pullRequestId, ticket, integration.project, integration.repository, item);
    }
    if (!await this.isPullRequestLinked(pullRequest, ticket)) {
      throw new Error(`No se pudo verificar la asociación nativa del PR ${pullRequestId} con el ticket ${ticket}`);
    }
    return { hu, ticket: summary.id, pullRequest: pullRequestId, mergeCommit: pullRequest.mergeCommit! };
  }

  async linkCommit(
    ticket: number,
    pullRequestId: number,
  ): Promise<{ ticket: number; pullRequest: number; mergeCommit: string; artifactLink: string }> {
    positiveId(ticket, "El ticket");
    positiveId(pullRequestId, "El pull request");

    const item = await this.readWorkItemValidated(ticket);
    const parent = await this.readDirectParent(ticket, item);
    const integration = uniqueBranch(parent);
    const ticketBranch = uniqueBranch(item);
    if (!integration.ref || !ticketBranch.ref) throw new Error(`El ticket ${ticket} no tiene ramas de integración y entrega verificables`);
    if (ticketBranch.project !== integration.project || ticketBranch.repository !== integration.repository) {
      throw new Error(`La rama del ticket ${ticket} no coincide con la rama de integración de su HU`);
    }
    const pullRequest = await this.readPullRequest(pullRequestId);
    this.validatePullRequest(pullRequest, ticket, integration, ticketBranch);
    const candidates = await this.readPullRequests(ticket, integration.project, integration.ref, integration.project, integration.repository, ticketBranch.ref);
    const validCandidates = candidates.filter((candidate) =>
      candidate.status === "completed" && candidate.mergeStatus === "succeeded" && candidate.target === integration.ref
    );
    const associatedCandidates = validCandidates.filter((candidate) => candidate.associated);
    if (associatedCandidates.length !== 1 || associatedCandidates[0]!.id !== pullRequestId) {
      throw new Error(`El PR ${pullRequestId} no es el único PR canónico asociado al ticket ${ticket}`);
    }
    const project = pullRequest.projectId;
    const repository = pullRequest.repositoryId;
    const artifactLink = `vstfs:///Git/Commit/${encodeURIComponent(`${project}/${repository}/${pullRequest.mergeCommit}`)}`;
    const existing = fixedCommit(item);
    if (existing && (
      existing.project !== project || existing.repository !== repository || existing.commit !== pullRequest.mergeCommit
    )) throw new Error(`El ticket ${ticket} ya tiene un Fixed in Commit distinto; conflicto`);

    if (!existing) {
      await this.patchWorkItem(item, [
        { op: "test", path: "/rev", value: item.rev },
        {
          op: "add",
          path: "/relations/-",
          value: { rel: "ArtifactLink", url: artifactLink, attributes: { name: "Fixed in Commit" } },
        },
      ]);
    }

    const verified = fixedCommit(await this.readWorkItem(ticket));
    if (!verified || verified.project !== project || verified.repository !== repository || verified.commit !== pullRequest.mergeCommit) {
      throw new Error(`No se pudo verificar el Fixed in Commit del PR ${pullRequestId}`);
    }
    return { ticket, pullRequest: pullRequestId, mergeCommit: pullRequest.mergeCommit, artifactLink };
  }

  async addAttachment(
    ticket: number,
    filePath: string,
    kind: EvidenceKind,
  ): Promise<{ ticket: number; name: string; kind: EvidenceKind; digest: string; url: string }> {
    positiveId(ticket, "El ticket");
    validateEvidenceKind(kind);
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const file = Bun.file(filePath);
    const name = filePath.split(/[\\/]/).pop() ?? "";
    if (!name || name === "." || name === "..") throw new Error(`El archivo de evidencia no tiene un nombre válido: ${filePath}`);
    if (!await file.exists()) throw new Error(`El archivo de evidencia no existe: ${filePath}`);
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`El archivo de evidencia debe tener entre 1 y ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (kind !== "screen") {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      validateEvidenceContent(content, kind);
    }
    const digest = await sha256(bytes);
    const existing = (item.relations ?? [])
      .filter(({ rel }) => rel === "AttachedFile")
      .find(({ attributes }) => attributes?.digest === digest);
    if (existing?.url) return { ticket, name: existing.attributes?.name ?? name, kind, digest, url: existing.url };

    const upload = await this.uploadAttachment(name, filePath);
    const current = await this.readWorkItem(ticket);
    try {
      await this.patchWorkItem(current, [{
        op: "test", path: "/rev", value: current.rev,
      }, {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: upload,
          attributes: { name, comment: kind, digest },
        },
      }]);
    } catch (error) {
      const recovered = await this.readWorkItem(ticket).catch(() => null);
      const relation = recovered?.relations?.find(({ rel, attributes }) =>
        rel === "AttachedFile" && attributes?.digest === digest
      );
      if (!relation?.url) throw error;
      return { ticket, name: relation.attributes?.name ?? name, kind, digest, url: relation.url };
    }
    const verified = (await this.readWorkItem(ticket)).relations?.find(({ rel, attributes }) =>
      rel === "AttachedFile" && attributes?.digest === digest
    );
    if (!verified?.url) throw new Error(`No se pudo verificar el adjunto ${name}`);
    return { ticket, name, kind, digest, url: verified.url };
  }

  async setEvidence(ticket: number, filePath: string): Promise<{ ticket: number; completionEvidence: string }> {
    positiveId(ticket, "El ticket");
    const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!content.trim()) throw new Error("El archivo de completion-evidence está vacío");
    validateEvidenceContent(content, "command-output");
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const fieldName = COMPLETION_FIELDS.find((name) => text(item, name)) ?? COMPLETION_FIELDS[0];
    const existing = text(item, fieldName);
    if (existing === content) return { ticket, completionEvidence: existing };
    if (existing) throw new Error(`El ticket ${ticket} ya tiene completion-evidence distinta; conflicto`);
    await this.patchWorkItem(item, [{
      op: "test", path: "/rev", value: item.rev,
    }, { op: "add", path: `/fields/${fieldName}`, value: content }]);
    const completionEvidence = (await this.getEvidence(ticket)).completionEvidence;
    if (!completionEvidence) throw new Error(`No se pudo verificar completion-evidence del ticket ${ticket}`);
    return { ticket, completionEvidence };
  }

  private async readWorkItemValidated(ticket: number): Promise<WorkItem> {
    positiveId(ticket, "El ticket");
    const item = await this.readWorkItem(ticket);
    this.toSummary(item);
    return item;
  }

  private async readDirectParent(ticket: number, item: WorkItem): Promise<WorkItem> {
    const parentId = relationId((item.relations ?? []).find(({ rel }) => rel === "System.LinkTypes.Hierarchy-Reverse")?.url);
    if (!parentId) throw new Error(`El ticket ${ticket} no tiene una HU padre directa`);
    const parent = await this.readWorkItem(parentId);
    if (!(parent.relations ?? []).some(({ rel, url }) =>
      rel === "System.LinkTypes.Hierarchy-Forward" && relationId(url) === ticket
    )) throw new Error(`El ticket ${ticket} no es hijo directo de su HU`);
    return parent;
  }

  private async readPullRequest(id: number, project?: string, repository?: string): Promise<TicketPullRequest> {
    const args = [
      "repos", "pr", "show", "--id", `${id}`, "--organization", ORGANIZATION,
      ...(project ? ["--project", project] : []),
      ...(repository ? ["--repository", repository] : []),
      "--output", "json",
    ];
    try {
      return this.toPullRequest(JSON.parse(await this.az(args)));
    } catch (error) {
      const uri = repository
        ? `${ORGANIZATION}/_apis/git/repositories/${encodeURIComponent(repository)}/pullRequests/${id}?api-version=${API_VERSION}`
        : `${ORGANIZATION}/_apis/git/pullrequests/${id}?api-version=${API_VERSION}`;
      try {
        return this.toPullRequest(JSON.parse(await this.az([
          "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get", "--uri", uri, "--output", "json",
        ])));
      } catch (fallbackError) {
        throw new Error(`No se pudo leer el PR ${id}: ${sanitizeError(fallbackError)}`, { cause: error });
      }
    }
  }

  private validatePullRequest(
    pullRequest: TicketPullRequest,
    ticket: number,
    integration: { ref: string | null; project?: string; repository?: string },
    ticketBranch: { ref: string | null; project?: string; repository?: string },
  ): void {
    if (
      pullRequest.status !== "completed"
      || pullRequest.mergeStatus !== "succeeded"
      || pullRequest.target !== integration.ref
      || !pullRequest.mergeCommit
    ) throw new Error(`El PR ${pullRequest.id} no cumple el target o estado de merge requerido`);
    if (pullRequest.source !== ticketBranch.ref) {
      throw new Error(`El PR ${pullRequest.id} no pertenece a la rama del ticket ${ticket}`);
    }
    if (
      pullRequest.projectId !== integration.project
      || pullRequest.repositoryId !== integration.repository
    ) throw new Error(`El PR ${pullRequest.id} pertenece a otro proyecto o repositorio Azure`);
  }

  private async addPullRequestWorkItem(
    id: number,
    ticket: number,
    project: string | undefined,
    repository: string | undefined,
    item: WorkItem,
  ): Promise<void> {
    try {
      await this.az([
        "repos", "pr", "work-item", "add", "--id", `${id}`, "--work-items", `${ticket}`,
        "--organization", ORGANIZATION,
        ...(project ? ["--project", project] : []),
        ...(repository ? ["--repository", repository] : []),
        "--output", "json",
      ]);
    } catch (error) {
      if (!repository) throw commandError(error);
      if (!project) throw commandError(error);
      const artifactUrl = `vstfs:///Git/PullRequestId/${encodeURIComponent(`${project}/${repository}/${id}`)}`;
      try {
        await this.patchWorkItem(item, [
          { op: "test", path: "/rev", value: item.rev },
          {
            op: "add",
            path: "/relations/-",
            value: { rel: "ArtifactLink", url: artifactUrl, attributes: { name: "Pull Request" } },
          },
        ]);
      } catch (fallbackError) {
        throw new Error(`No se pudo asociar el PR ${id} al ticket ${ticket}: ${sanitizeError(fallbackError)}`, { cause: fallbackError });
      }
    }
  }

  private async uploadAttachment(name: string, filePath: string): Promise<string> {
    const uri = `${ORGANIZATION}/_apis/wit/attachments?fileName=${encodeURIComponent(name)}&api-version=${API_VERSION}`;
    try {
      const payload = JSON.parse(await this.az([
        "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "post", "--uri", uri,
        "--headers", "Content-Type=application/octet-stream", "--body", `@${filePath}`, "--output", "json",
      ])) as { url?: unknown };
      if (typeof payload.url !== "string" || !payload.url) throw new Error("respuesta de adjunto sin URL");
      return payload.url;
    } catch (error) {
      throw new Error(`No se pudo subir el adjunto ${name}: ${sanitizeError(error)}`, { cause: error });
    }
  }

  private async patchWorkItem(item: WorkItem, patch: unknown[]): Promise<void> {
    await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "patch",
      "--uri", `${ORGANIZATION}/_apis/wit/workitems/${item.id}?api-version=${API_VERSION}`,
      "--headers", "Content-Type=application/json-patch+json", "--body", JSON.stringify(patch), "--output", "json",
    ]);
  }

  private async readWorkItem(id: number): Promise<WorkItem> {
    const args = ["boards", "work-item", "show", "--id", `${id}`, "--organization", ORGANIZATION, "--expand", "relations", "--output", "json"];
    try {
      return this.validWorkItem(JSON.parse(await this.az(args)), id);
    } catch (error) {
      const uri = `${ORGANIZATION}/_apis/wit/workitems/${id}?$expand=relations&api-version=${API_VERSION}`;
      try {
        return this.validWorkItem(JSON.parse(await this.az([
          "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get", "--uri", uri, "--output", "json",
        ])), id);
      } catch (fallbackError) {
        throw new Error(`No se pudo leer el work item ${id}: ${sanitizeError(fallbackError)}`, { cause: error });
      }
    }
  }

  private toSummary(item: WorkItem): TicketSummary {
    const type = text(item, "System.WorkItemType");
    if (type !== "Task" && type !== "Bug") throw new Error(`El work item ${item.id} no es un Task o Bug de entrega`);
    return {
      id: item.id,
      type,
      title: text(item, "System.Title"),
      description: text(item, "System.Description"),
      state: text(item, "System.State"),
      revision: item.rev,
      createdDate: text(item, "System.CreatedDate"),
      assignedTo: assignedTo(item),
    };
  }

  private async readPullRequests(
    ticket: number,
    project: string | undefined,
    integrationBranch: string | null,
    expectedProject?: string,
    repository?: string,
    expectedSource?: string | null,
  ): Promise<TicketPullRequest[]> {
    if (!project) return [];
    const args = [
      "repos", "pr", "list", "--organization", ORGANIZATION, "--project", project,
      ...(repository ? ["--repository", repository] : []),
      "--status", "completed", "--output", "json",
    ];
    let payload: PullRequestPayload[];
    try {
      payload = this.pullRequestList(JSON.parse(await this.az(args)));
    } catch (error) {
      const uri = repository
        ? `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/pullrequests?searchCriteria.status=completed&api-version=${API_VERSION}`
        : `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/git/pullrequests?searchCriteria.status=completed&api-version=${API_VERSION}`;
      try {
        payload = this.pullRequestList(JSON.parse(await this.az([
          "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get", "--uri", uri, "--output", "json",
        ])));
      } catch (fallbackError) {
        throw new Error(`No se pudieron leer los pull requests del ticket ${ticket}: ${sanitizeError(fallbackError)}`, { cause: error });
      }
    }
    const matching = payload
      .map((pr) => this.toPullRequest(pr))
      .filter((pr) => pr.source === expectedSource || hasTicketNumber(pr.source, ticket));
    if (repository && matching.some((pr) => pr.repositoryId !== repository)) {
      throw new Error(`El pull request del ticket ${ticket} pertenece a otro repositorio Azure`);
    }
    if (expectedProject && matching.some((pr) => pr.projectId !== expectedProject)) {
      throw new Error(`El pull request del ticket ${ticket} pertenece a otro proyecto Azure`);
    }
    return Promise.all(matching.map(async (pr) => ({
      ...pr,
      associated: await this.isPullRequestLinked(pr, ticket),
    })));
  }

  private validWorkItem(payload: unknown, id: number): WorkItem {
    if (typeof payload !== "object" || payload === null || !("id" in payload) || payload.id !== id) {
      throw new Error(`Respuesta de work item malformada: no coincide con el ID solicitado ${id}`);
    }
    return payload as WorkItem;
  }

  private toPullRequest(payload: PullRequestPayload): TicketPullRequest {
    const id = payload.pullRequestId ?? payload.id;
    const source = payload.sourceRefName ?? payload.source;
    const target = payload.targetRefName ?? payload.target;
    const repositoryId = payload.repository?.id ?? payload.repositoryId;
    const projectId = payload.repository?.project?.id ?? payload.projectId;
    if (
      typeof id !== "number" || !Number.isInteger(id)
      || typeof payload.status !== "string"
      || typeof payload.mergeStatus !== "string"
      || typeof source !== "string"
      || typeof target !== "string"
      || typeof repositoryId !== "string"
      || typeof projectId !== "string"
    ) throw new Error("Respuesta de pull request malformada: faltan campos de identidad");
    return {
      id,
      status: payload.status,
      mergeStatus: payload.mergeStatus,
      source,
      target,
      mergeCommit: payload.lastMergeCommit?.commitId ?? payload.mergeCommit,
      repositoryId,
      projectId,
      associated: false,
    };
  }

  private pullRequestList(payload: unknown): PullRequestPayload[] {
    if (Array.isArray(payload)) return payload as PullRequestPayload[];
    if (typeof payload === "object" && payload !== null && "value" in payload && Array.isArray(payload.value)) {
      return payload.value as PullRequestPayload[];
    }
    throw new Error("Respuesta de pull requests malformada: se esperaba una lista");
  }

  private async isPullRequestLinked(pullRequest: TicketPullRequest, ticket: number): Promise<boolean> {
    try {
      const output = await this.az([
        "repos", "pr", "work-item", "list", "--id", `${pullRequest.id}`, "--organization", ORGANIZATION, "--query", "[].id", "--output", "json",
        ...(pullRequest.projectId ? ["--project", pullRequest.projectId] : []),
        ...(pullRequest.repositoryId ? ["--repository", pullRequest.repositoryId] : []),
      ]);
      return this.workItemIds(JSON.parse(output)).includes(ticket);
    } catch (error) {
      if (!pullRequest.repositoryId) throw commandError(error);
      try {
        const uri = `${ORGANIZATION}/_apis/git/repositories/${encodeURIComponent(pullRequest.repositoryId)}/pullRequests/${pullRequest.id}/workitems?api-version=${API_VERSION}`;
        const payload = JSON.parse(await this.az([
          "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get", "--uri", uri, "--output", "json",
        ]));
        return this.workItemIds(payload).includes(ticket);
      } catch (fallbackError) {
        throw new Error(`No se pudo leer la asociacion nativa del PR ${pullRequest.id}: ${sanitizeError(fallbackError)}`, { cause: error });
      }
    }
  }

  private workItemIds(payload: unknown): number[] {
    const values = Array.isArray(payload)
      ? payload
      : typeof payload === "object" && payload !== null && "value" in payload && Array.isArray(payload.value)
        ? payload.value
        : null;
    const ids = values?.map((item) => {
      const id = typeof item === "object" && item !== null && "id" in item ? item.id : item;
      if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
      if (typeof id === "string" && /^\d+$/.test(id) && Number(id) > 0) return Number(id);
      return null;
    });
    if (!ids || ids.some((id) => id === null)) {
      throw new Error("Respuesta de asociacion de work items malformada");
    }
    return ids as number[];
  }

  private unmetGates(
    summary: TicketSummary,
    item: WorkItem,
    integrationBranch: string | null,
    pullRequests: TicketPullRequest[],
    canonical: number | null,
    evidence: string | null,
    mergeCommit: string | null,
    artifactCommit: FixedCommitLink | null,
  ): CompletionGate[] {
    const unmet: CompletionGate[] = [];
    if (summary.state !== "Done") unmet.push(GATE.ticketState);
    if (!evidence) unmet.push(GATE.completionEvidence);
    if (!number(item, ["Custom.EsfuerzoReal"])) unmet.push(GATE.realEffort);
    if (!number(item, ["Custom.EsfuerzoRealHH"])) unmet.push(GATE.realEffortHours);
    if (!text(item, "Custom.URLCommit")) unmet.push(GATE.commitUrl);
    if (!hasEvidenceCapture(item)) unmet.push(GATE.attachedCapture);
    if (!integrationBranch) unmet.push(GATE.huIntegrationBranch);
    const validPrs = pullRequests.filter((pr) =>
      pr.status === "completed" && pr.mergeStatus === "succeeded" && pr.target === integrationBranch
    );
    const validPr = validPrs.find((pr) => pr.id === canonical);
    if (validPrs.length === 0) unmet.push(GATE.completedHuPullRequest);
    else if (!validPr) unmet.push(GATE.nativePullRequestAssociation);
    const exactArtifact = validPr?.mergeCommit && artifactCommit
      && artifactCommit.project === validPr.projectId
      && artifactCommit.repository === validPr.repositoryId
      && artifactCommit.commit === validPr.mergeCommit;
    if (!exactArtifact) unmet.push(GATE.mergeCommitArtifact);
    return unmet;
  }
}
