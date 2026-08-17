import { $ } from "bun";
import { relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

const ORGANIZATION = "https://dev.azure.com/SubdepartamentoSolucionesTI";
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EVIDENCE_KINDS = ["http-json", "screen", "command-output"] as const;
const TICKET_FIELDS = {
  description: "System.Description",
  state: "System.State",
  realEffort: "Custom.EsfuerzoReal",
  realEffortHours: "Custom.EsfuerzoRealHH",
} as const;
const HU_WORK_ITEM_TYPES = new Set(["User Story", "Product Backlog Item"]);
const SUPPORTED_STATES = new Set([
  "New",
  "Active",
  "En progreso",
  "In Progress",
  "Resolved",
  "Done",
  "Closed",
  "Removed",
  "En Desarrollo",
  "Desarrollo Terminado",
]);
const STATE_TRANSITIONS: Record<string, readonly string[]> = {
  New: ["Active", "En progreso", "In Progress", "Removed"],
  Active: ["En progreso", "In Progress", "Resolved", "Done", "Removed"],
  "En progreso": ["Active", "Resolved", "Done", "Removed"],
  "In Progress": ["Active", "Resolved", "Done", "Removed"],
  Resolved: ["Active", "En progreso", "In Progress", "Done", "Closed"],
  Done: ["Done"],
  Closed: ["Closed"],
  Removed: ["Removed"],
  "En Desarrollo": ["Desarrollo Terminado"],
  "Desarrollo Terminado": ["Desarrollo Terminado"],
};

const HU_OPEN_DELIVERY_STATES = new Set([
  "New",
  "Active",
  "En progreso",
  "In Progress",
  "Resolved",
]);

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
  /** The source commit Azure computed the merge from; completing a PR must echo it back. */
  lastMergeSourceCommit?: string;
  repositoryId?: string;
  projectId?: string;
  associated: boolean;
}

export interface IntegratedPullRequest {
  pullRequest: number;
  mergeCommit: string;
}

/**
 * Participant repository a delivery effect must act on. Without it the repository is derived from
 * the ticket's own Branch ArtifactLink, which only ever names one repository.
 */
export interface AzurePullRequestTarget {
  readonly project: string;
  readonly repository: string;
  readonly source: string;
  readonly target: string;
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

export interface CompletionManifestEvidence {
  path: string;
  kind: EvidenceKind;
  sha256: string;
}

export interface CompletionManifest {
  ticket: number;
  ticketBranch: string;
  commit: string;
  validation: Array<{ command: string; result: string }>;
  evidence: CompletionManifestEvidence[];
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
  lastMergeSourceCommit?: { commitId?: string };
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

interface ValidatedEvidenceFile {
  name: string;
  bytes: Uint8Array;
  digest: string;
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

/**
 * Azure persists only its own relation attributes and silently drops unknown ones, so a `digest`
 * attribute never survives the round trip: evidence written that way reads back undigested, which
 * left the attachment unverifiable and the evidence gate unsatisfiable. The digest travels inside
 * `comment`, which Azure does keep, alongside the evidence kind it already carried.
 */
const ATTACHMENT_DIGEST_PREFIX = "sha256:";

function attachmentComment(kind: EvidenceKind, digest: string): string {
  return `${kind} ${ATTACHMENT_DIGEST_PREFIX}${digest.toLowerCase()}`;
}

function attachmentKind(comment: string | undefined): EvidenceKind | undefined {
  return evidenceKind(comment?.trim().split(/\s+/)[0]);
}

function attachmentDigest(comment: string | undefined): string | undefined {
  const token = comment?.trim().split(/\s+/).find((part) => part.startsWith(ATTACHMENT_DIGEST_PREFIX));
  const digest = token?.slice(ATTACHMENT_DIGEST_PREFIX.length).toLowerCase();
  return digest && /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

function hasEvidenceCapture(item: WorkItem): boolean {
  return (item.relations ?? []).some(({ rel, url, attributes }) =>
    rel === "AttachedFile"
      && typeof url === "string"
      && url.trim().length > 0
      && attachmentKind(attributes?.comment) !== undefined
      && attachmentDigest(attributes?.comment) !== undefined
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

function commitArtifactLinks(item: WorkItem): string[] {
  return (item.relations ?? [])
    .filter(({ rel, attributes, url }) => rel === "ArtifactLink" && (
      attributes?.name === "Fixed in Commit" || url?.includes("vstfs:///Git/Commit/")
    ))
    .map(({ url }) => url ?? "");
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
  if (unique.length > 1) {
    // Multi-repository delivery links one commit per repository; Custom.URLCommit names the primary.
    const primary = text(item, "Custom.URLCommit");
    const designated = unique.find((commit) =>
      `vstfs:///Git/Commit/${encodeURIComponent(`${commit.project}/${commit.repository}/${commit.commit}`)}` === primary
    );
    if (!designated) throw new Error("existen multiples Fixed in Commit ArtifactLink distintos");
    return designated;
  }
  return unique[0] ?? null;
}

function participantBranch(
  participant: AzurePullRequestTarget,
  side: "source" | "target",
): { ref: string; project: string; repository: string } {
  return { ref: participant[side], project: participant.project, repository: participant.repository };
}

function sanitizeText(message: string): string {
  return message
    .replace(/("?(?:accessToken|authorization|token|password|cookie)"?\s*[:=]\s*"?)[^",\s}]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

function sanitizeError(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error));
}

/**
 * Bun's shell puts the reason a command failed in `stderr` and leaves the thrown message as a bare
 * exit code. For `az` the reason is the whole value of the error — an expired MFA token naming the
 * tenant to re-authenticate against, a rejected patch, a missing permission — so it is read here and
 * carried into the message the operator sees. It is sanitized like any other Azure output.
 */
const STDERR_LIMIT = 2000;

function commandStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (stderr === undefined || stderr === null) return "";
  const text = typeof stderr === "string"
    ? stderr
    : stderr instanceof Uint8Array
      ? new TextDecoder().decode(stderr)
      : String(stderr);
  return text.trim().slice(0, STDERR_LIMIT);
}

export function commandError(error: unknown): Error {
  const stderr = commandStderr(error);
  const detail = stderr ? `${sanitizeError(error)}: ${sanitizeText(stderr)}` : sanitizeError(error);
  return new Error(`Azure command failed: ${detail}`, { cause: error });
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

async function readUtf8File(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!await file.exists()) throw new Error(`El archivo no existe: ${filePath}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    throw new Error(`El archivo no contiene UTF-8 válido: ${filePath}`, { cause: error });
  }
}

function workItemRevision(item: WorkItem): number {
  const revision = item.rev;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision <= 0) {
    throw new Error(`El work item ${item.id} no tiene una revision Azure válida`);
  }
  return revision;
}

function validateState(state: string, name: string): void {
  if (!SUPPORTED_STATES.has(state)) throw new Error(`${name} no soportado: ${state}`);
}

function validateQuarterHour(value: number, name: string): void {
  if (!Number.isInteger(value * 4)) throw new Error(`${name} debe estar redondeado a incrementos de 0.25 horas: ${value}`);
}

function isRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b409\b|revision|precondition|conflict|condition.*(?:failed|not met)/i.test(message);
}

function validateScreenEvidence(name: string, bytes: Uint8Array): void {
  const lowerName = name.toLowerCase();
  const png = lowerName.endsWith(".png") && bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]);
  const jpeg = (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg"))
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = lowerName.endsWith(".webp")
    && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("La evidencia screen debe ser una captura PNG, JPEG o WebP válida");
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
  constructor(
    private readonly az: AzRunner = runAzureCommand,
    private readonly git: GitRunner = runGit,
  ) {}

  async getTicket(ticket: number): Promise<TicketSummary> {
    positiveId(ticket, "El ticket");
    return this.toSummary(await this.readWorkItem(ticket));
  }

  async getCompletionManifestPath(workingDirectory: string): Promise<string> {
    const commonDirectory = await realpath(resolve(workingDirectory, (await this.git(["rev-parse", "--git-common-dir"], workingDirectory)).trim()));
    return resolve(commonDirectory, "lazy-workflow/completion-manifest.json");
  }

  async createOrReusePullRequest(hu: number, ticket: number, participant?: AzurePullRequestTarget): Promise<IntegratedPullRequest> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    if (participant) return this.integratePullRequestIn(hu, ticket, participant);
    const info = await this.getTicketInfo(hu, ticket);
    const valid = info.pullRequests.filter((pr) =>
      pr.status === "completed" && pr.mergeStatus === "succeeded" && pr.target === info.integrationBranch
      && pr.source === info.branch,
    );
    if (info.canonicalPullRequest !== null) {
      const pr = valid.find(({ id }) => id === info.canonicalPullRequest);
      if (!pr?.mergeCommit) throw new Error(`El PR canónico ${info.canonicalPullRequest} no tiene commit de merge verificable`);
      return { pullRequest: pr.id, mergeCommit: pr.mergeCommit };
    }
    if (valid.length > 1) throw new Error(`El ticket ${ticket} tiene múltiples PR completados sin asociación canónica`);
    if (valid.length === 1) {
      const pr = valid[0]!;
      if (!pr.mergeCommit) throw new Error(`El PR ${pr.id} no tiene commit de merge verificable`);
      return { pullRequest: pr.id, mergeCommit: pr.mergeCommit };
    }
    if (!info.branch || !info.integrationBranch) throw new Error(`El ticket ${ticket} no tiene ramas verificables para crear el PR`);
    const parent = await this.readDirectParent(ticket, await this.readWorkItemValidated(ticket));
    const integration = uniqueBranch(parent);
    const ticketBranch = uniqueBranch(await this.readWorkItem(ticket));
    if (!integration.project || !integration.repository || !integration.ref || !ticketBranch.ref) {
      throw new Error(`El ticket ${ticket} no tiene identidad Azure Git completa`);
    }
    const active = await this.readPullRequests(
      ticket,
      integration.project,
      integration.ref,
      integration.project,
      integration.repository,
      ticketBranch.ref,
      "active",
    );
    const exactActive = active.filter((pr) => pr.source === ticketBranch.ref && pr.target === integration.ref);
    if (active.length !== exactActive.length) {
      throw new Error(`El ticket ${ticket} tiene un PR activo que no apunta exactamente a la rama de integración`);
    }
    if (exactActive.length > 1) throw new Error(`El ticket ${ticket} tiene múltiples PR activos para su rama`);
    if (exactActive.length === 1) {
      await this.completePullRequest(exactActive[0]!.id, integration.project, integration.repository);
      const verified = await this.readPullRequest(exactActive[0]!.id, integration.project, integration.repository);
      this.validatePullRequest(verified, ticket, integration, ticketBranch);
      return { pullRequest: verified.id, mergeCommit: verified.mergeCommit! };
    }
    const created = await this.createPullRequest(
      integration.project,
      integration.repository,
      ticketBranch.ref,
      integration.ref,
      ticket,
      hu,
    );
    await this.completePullRequest(created.id, integration.project, integration.repository);
    const verified = await this.readPullRequest(created.id, integration.project, integration.repository);
    this.validatePullRequest(verified, ticket, integration, ticketBranch);
    return { pullRequest: verified.id, mergeCommit: verified.mergeCommit! };
  }

  private async integratePullRequestIn(hu: number, ticket: number, participant: AzurePullRequestTarget): Promise<IntegratedPullRequest> {
    const { project, repository, source, target } = participant;
    const exact = (candidates: TicketPullRequest[]): TicketPullRequest[] =>
      candidates.filter((pr) => pr.source === source && pr.target === target);
    const completed = exact(await this.readPullRequests(ticket, project, target, project, repository, source))
      .filter((pr) => pr.status === "completed" && pr.mergeStatus === "succeeded");
    if (completed.length > 1) throw new Error(`El ticket ${ticket} tiene múltiples PR completados en ${repository}`);
    if (completed.length === 1) {
      const pr = completed[0]!;
      if (!pr.mergeCommit) throw new Error(`El PR ${pr.id} no tiene commit de merge verificable`);
      return { pullRequest: pr.id, mergeCommit: pr.mergeCommit };
    }
    const active = exact(await this.readPullRequests(ticket, project, target, project, repository, source, "active"));
    if (active.length > 1) throw new Error(`El ticket ${ticket} tiene múltiples PR activos en ${repository}`);
    const pullRequest = active[0] ?? await this.createPullRequest(project, repository, source, target, ticket, hu);
    await this.completePullRequest(pullRequest.id, project, repository);
    const verified = await this.readPullRequest(pullRequest.id, project, repository);
    this.validatePullRequest(verified, ticket, { ref: target, project, repository }, { ref: source, project, repository });
    return { pullRequest: verified.id, mergeCommit: verified.mergeCommit! };
  }

  async validateDirectTicketContext(hu: number, ticket: number): Promise<void> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    const [parent, item] = await Promise.all([this.readWorkItem(hu), this.readWorkItem(ticket)]);
    if (!HU_WORK_ITEM_TYPES.has(text(parent, "System.WorkItemType") ?? "")) throw new Error(`La HU ${hu} no es una User Story ni un Product Backlog Item`);
    this.toSummary(item);
    const forward = (parent.relations ?? []).some(({ rel, url }) =>
      rel === "System.LinkTypes.Hierarchy-Forward" && relationId(url) === ticket
    );
    const reverseRelations = (item.relations ?? []).filter(({ rel }) => rel === "System.LinkTypes.Hierarchy-Reverse");
    const reverse = reverseRelations.map(({ url }) => relationId(url));
    if (reverse.some((id) => id === undefined) || !forward || reverse.length !== 1 || reverse[0] !== hu) {
      throw new Error(`El ticket ${ticket} no tiene una relación directa única con la HU ${hu}`);
    }
  }

  async getTicketInfo(hu: number, ticket: number): Promise<TicketInfo> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    const [parent, item] = await Promise.all([this.readWorkItem(hu), this.readWorkItem(ticket)]);
    const summary = this.toSummary(item);
    const parentType = text(parent, "System.WorkItemType");
    if (!HU_WORK_ITEM_TYPES.has(parentType ?? "")) throw new Error(`La HU ${hu} no es una User Story ni un Product Backlog Item`);
    const child = (parent.relations ?? []).some(({ rel, url }) =>
      rel === "System.LinkTypes.Hierarchy-Forward" && relationId(url) === ticket
    );
    if (!child) throw new Error(`El ticket ${ticket} no es hijo directo de la HU ${hu}`);

    const integrationBranch = uniqueBranch(parent);
    const ticketBranch = uniqueBranch(item);
    if (ticketBranch.ref && ticketBranch.project !== integrationBranch.project) {
      throw new Error(`La rama del ticket ${ticket} no coincide con el proyecto de la rama de integracion de la HU`);
    }
    // The ticket's own branch names its primary implementation repository. In a multi-repository
    // delivery that is the first repository that changed, which need not be the HU's anchor; the
    // integration branch carries the same name in every participant, so only the repository moves.
    const deliveryProject = ticketBranch.project ?? integrationBranch.project;
    const deliveryRepository = ticketBranch.repository ?? integrationBranch.repository;
    const pullRequests = await this.readPullRequests(
      ticket,
      deliveryProject ?? text(parent, "System.TeamProject"),
      integrationBranch.ref,
      deliveryProject,
      deliveryRepository,
      ticketBranch.ref,
    );
    const validPullRequests = pullRequests.filter((pullRequest) =>
      pullRequest.status === "completed"
      && pullRequest.mergeStatus === "succeeded"
      && pullRequest.target === integrationBranch.ref
      && pullRequest.source === ticketBranch.ref
    );
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
      ticketBranch.ref,
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
          evidenceKind: attachmentKind(attributes?.comment),
          digest: attachmentDigest(attributes?.comment),
        })),
      completionEvidence,
      gates: {
        satisfied: Object.values(GATE).filter((gate) => !unmet.includes(gate)),
        unmet,
      },
    };
  }

  async getCompletionInfo(hu: number, ticket: number): Promise<{ hu: number; ticket: number; gates: TicketInfo["gates"] }> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    try {
      await this.validateDirectTicketContext(hu, ticket);
      const info = await this.getTicketInfo(hu, ticket);
      return { hu, ticket, gates: info.gates };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no es hijo directo|relación directa única|no es un Task o Bug de entrega|no es una User Story|Branch ArtifactLink|rama .* (malformada|conflicto|no coincide|ambigua)/i.test(message)) throw error;
      return { hu, ticket, gates: { satisfied: [], unmet: Object.values(GATE) } };
    }
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
    // A ticket delivered across repositories anchors its branch in its primary repository, which
    // need not be the HU's; both still belong to the same Azure project.
    if (ticketBranch.ref && ticketBranch.project !== integrationBranch.project) {
      throw new Error(`La rama del ticket ${ticket} no coincide con el proyecto de la rama de integracion de la HU`);
    }
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
          evidenceKind: attachmentKind(attributes?.comment),
          digest: attachmentDigest(attributes?.comment),
        })),
    };
  }

  async getEvidence(ticket: number): Promise<{ ticket: number; completionEvidence: string | null }> {
    const item = await this.readWorkItemValidated(ticket);
    return { ticket, completionEvidence: COMPLETION_FIELDS.map((name) => text(item, name)).find(Boolean) ?? null };
  }

  async setDescription(ticket: number, filePath: string): Promise<{ ticket: number; description: string; revision: number }> {
    positiveId(ticket, "El ticket");
    const content = await readUtf8File(filePath);
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const existing = item.fields?.[TICKET_FIELDS.description];
    const revision = workItemRevision(item);
    if (existing === content) return { ticket, description: content, revision };

    const verified = await this.patchAndRead(item, [
      { op: "test", path: "/rev", value: revision },
      { op: "add", path: `/fields/${TICKET_FIELDS.description}`, value: content },
    ], (candidate) => candidate.fields?.[TICKET_FIELDS.description] === content);
    const description = verified.fields?.[TICKET_FIELDS.description];
    if (description !== content) throw new Error(`No se pudo verificar la descripción del ticket ${ticket}`);
    return { ticket, description: content, revision: workItemRevision(verified) };
  }

  async setState(
    ticket: number,
    desiredState: string,
    expectedState: string,
    allowCompletion = false,
    expectedRevision?: number,
  ): Promise<{ ticket: number; state: string; revision: number }> {
    positiveId(ticket, "El ticket");
    validateState(desiredState, "El estado deseado");
    validateState(expectedState, "El estado esperado");
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const currentState = text(item, TICKET_FIELDS.state);
    if (currentState !== expectedState) {
      throw new Error(`El estado actual del ticket ${ticket} (${currentState ?? "null"}) no coincide con el estado esperado ${expectedState}`);
    }
    const revision = workItemRevision(item);
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new Error(`La revision esperada ${expectedRevision} no coincide con la revision actual ${revision}`);
    }
    if (currentState === desiredState) return { ticket, state: desiredState, revision };
    if (desiredState === "Done" && !allowCompletion) {
      throw new Error("El estado Done solo puede aplicarse después de verificar los gates de cierre");
    }
    if (!STATE_TRANSITIONS[currentState]?.includes(desiredState)) {
      throw new Error(`Transición de estado no soportada: ${currentState} -> ${desiredState}`);
    }

    const verified = await this.patchAndRead(item, [
      { op: "test", path: "/rev", value: revision },
      { op: "replace", path: `/fields/${TICKET_FIELDS.state}`, value: desiredState },
    ], (candidate) => text(candidate, TICKET_FIELDS.state) === desiredState);
    const state = text(verified, TICKET_FIELDS.state);
    if (state !== desiredState) throw new Error(`No se pudo verificar el estado del ticket ${ticket}`);
    return { ticket, state: desiredState, revision: workItemRevision(verified) };
  }

  async setHuState(
    hu: number,
    desiredState: string,
    expectedState: string,
    expectedRevision: number,
  ): Promise<{ hu: number; state: string; revision: number }> {
    positiveId(hu, "La HU");
    validateState(desiredState, "El estado deseado");
    validateState(expectedState, "El estado esperado");
    const item = await this.readWorkItem(hu);
    if (!HU_WORK_ITEM_TYPES.has(text(item, "System.WorkItemType") ?? "")) {
      throw new Error(`El work item ${hu} no es una User Story ni un Product Backlog Item`);
    }
    const currentState = text(item, TICKET_FIELDS.state);
    if (currentState !== expectedState) {
      throw new Error(`El estado actual de la HU ${hu} (${currentState ?? "null"}) no coincide con el estado esperado ${expectedState}`);
    }
    const revision = workItemRevision(item);
    if (revision !== expectedRevision) {
      throw new Error(`La revision esperada de la HU ${hu} (${expectedRevision}) no coincide con la actual ${revision}`);
    }
    if (currentState === desiredState) return { hu, state: desiredState, revision };
    if (!STATE_TRANSITIONS[currentState]?.includes(desiredState)) {
      throw new Error(`Transición de HU no soportada: ${currentState} -> ${desiredState}`);
    }

    const verified = await this.patchAndRead(item, [
      { op: "test", path: "/rev", value: revision },
      { op: "replace", path: `/fields/${TICKET_FIELDS.state}`, value: desiredState },
    ], (candidate) => text(candidate, TICKET_FIELDS.state) === desiredState);
    const state = text(verified, TICKET_FIELDS.state);
    if (state !== desiredState) throw new Error(`No se pudo verificar el estado de la HU ${hu}`);
    return { hu, state: desiredState, revision: workItemRevision(verified) };
  }

  async getHuChildren(hu: number): Promise<Array<{ id: number; type: string; state: string; title?: string }>> {
    positiveId(hu, "La HU");
    const parent = await this.readWorkItem(hu);
    if (!HU_WORK_ITEM_TYPES.has(text(parent, "System.WorkItemType") ?? "")) {
      throw new Error(`El work item ${hu} no es una User Story ni un Product Backlog Item`);
    }
    const childIds = (parent.relations ?? [])
      .filter(({ rel, url }) => rel === "System.LinkTypes.Hierarchy-Forward" && typeof url === "string")
      .map((relation) => relationId(relation.url))
      .filter((id): id is number => id !== undefined);
    const children = await Promise.all(childIds.map((id) => this.readWorkItem(id)));
    return children.map((item) => {
      const type = text(item, "System.WorkItemType") ?? "Unknown";
      const state = text(item, TICKET_FIELDS.state) ?? "Unknown";
      const title = text(item, "System.Title");
      return { id: item.id, type, state, title };
    });
  }

  /**
   * Create one delivery ticket under its HU, or return the one that already exists.
   *
   * Idempotent by (HU, type, exact title): a matching direct child is reused rather
   * than duplicated, and two children sharing that identity are a conflict. Field
   * reference names are never inferred from display labels — anything beyond the
   * system fields must be named explicitly through `fields` (ADR-0006).
   */
  async createTicket(input: {
    hu: number;
    type: string;
    title: string;
    descriptionFile: string;
    estimate?: number;
    assignee?: string;
    fields?: Array<{ referenceName: string; value: string }>;
  }): Promise<{ hu: number; ticket: number; type: string; title: string; created: boolean }> {
    positiveId(input.hu, "La HU");
    const type = input.type;
    if (type !== "Task" && type !== "Bug") {
      throw new Error(`El tipo de ticket ${type} no es un tipo de entrega (Task o Bug)`);
    }
    const title = input.title.trim();
    if (!title) throw new Error("El ticket requiere un título no vacío");
    const description = await readUtf8File(input.descriptionFile);
    for (const { referenceName } of input.fields ?? []) {
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/.test(referenceName)) {
        throw new Error(`El campo ${referenceName} no es un reference name de Azure válido`);
      }
    }

    const existing = (await this.getHuChildren(input.hu)).filter(
      (child) => child.type === type && child.title?.trim() === title,
    );
    if (existing.length > 1) {
      throw new Error(`La HU ${input.hu} ya tiene ${existing.length} hijos ${type} titulados "${title}"`);
    }
    if (existing.length === 1) {
      return { hu: input.hu, ticket: existing[0]!.id, type, title, created: false };
    }

    const patch = [
      { op: "add", path: "/fields/System.Title", value: title },
      { op: "add", path: `/fields/${TICKET_FIELDS.description}`, value: description },
      ...(input.estimate !== undefined
        ? [{ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", value: input.estimate }]
        : []),
      ...(input.assignee ? [{ op: "add", path: "/fields/System.AssignedTo", value: input.assignee }] : []),
      ...(input.fields ?? []).map(({ referenceName, value }) => ({
        op: "add",
        path: `/fields/${referenceName}`,
        value,
      })),
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${ORGANIZATION}/_apis/wit/workItems/${input.hu}`,
        },
      },
    ];
    const project = await this.ticketProject(input.hu);
    const created = await this.createWorkItem(project, type, patch);

    // Reread through the same validation the delivery commands use, so a ticket is
    // only reported as created once Azure agrees it is a direct child of its HU.
    const item = await this.readWorkItemValidated(created);
    await this.readDirectParent(created, item);
    if (text(item, "System.Title")?.trim() !== title) {
      throw new Error(`No se pudo verificar el título del ticket ${created}`);
    }
    return { hu: input.hu, ticket: created, type, title, created: true };
  }

  /** Attach a child to its parent. Idempotent; a different existing parent is a conflict. */
  async linkParent(parent: number, child: number): Promise<{ parent: number; child: number; linked: boolean }> {
    positiveId(parent, "El padre");
    positiveId(child, "El hijo");
    if (parent === child) throw new Error("Un work item no puede ser su propio padre");
    const item = await this.readWorkItem(child);
    const parents = [...new Set((item.relations ?? [])
      .filter(({ rel }) => rel === "System.LinkTypes.Hierarchy-Reverse")
      .map(({ url }) => relationId(url))
      .filter((id): id is number => id !== undefined))];
    if (parents.includes(parent)) return { parent, child, linked: false };
    if (parents.length > 0) {
      throw new Error(`El work item ${child} ya tiene el padre ${parents.join(", ")}`);
    }
    await this.addRelation(item, "System.LinkTypes.Hierarchy-Reverse", parent);
    return { parent, child, linked: true };
  }

  /**
   * Record that `blocker` must complete before `blocked`, as the native
   * Successor relation on the blocker. Idempotent.
   */
  async linkPredecessor(blocker: number, blocked: number): Promise<{ blocker: number; blocked: number; linked: boolean }> {
    positiveId(blocker, "El bloqueante");
    positiveId(blocked, "El bloqueado");
    if (blocker === blocked) throw new Error("Un work item no puede bloquearse a sí mismo");
    const item = await this.readWorkItem(blocker);
    const successors = (item.relations ?? [])
      .filter(({ rel }) => rel === "System.LinkTypes.Dependency-Forward")
      .map(({ url }) => relationId(url));
    if (successors.includes(blocked)) return { blocker, blocked, linked: false };
    await this.addRelation(item, "System.LinkTypes.Dependency-Forward", blocked);
    return { blocker, blocked, linked: true };
  }

  async hasOpenDeliveryChildren(hu: number): Promise<boolean> {
    const children = await this.getHuChildren(hu);
    return children.some((child) =>
      (child.type === "Task" || child.type === "Bug") && HU_OPEN_DELIVERY_STATES.has(child.state)
    );
  }

  async readCompletionManifest(path: string, workingDirectory: string): Promise<CompletionManifest> {
    const commonDirectory = await realpath(resolve(workingDirectory, (await this.git(["rev-parse", "--git-common-dir"], workingDirectory)).trim()));
    const manifestPath = await realpath(resolve(path));
    const manifestRelativePath = relative(commonDirectory, manifestPath);
    if (!manifestRelativePath || (manifestRelativePath !== ".." && manifestRelativePath.startsWith(`..${sep}`))) {
      throw new Error("El manifest de completion debe estar bajo el directorio Git común");
    }
    const content = await readUtf8File(manifestPath);
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`El manifest de completion no es JSON válido: ${path}`, { cause: error });
    }
    if (typeof value !== "object" || value === null) throw new Error("El manifest de completion debe ser un objeto");
    const manifest = value as Partial<CompletionManifest>;
    const manifestTicket = manifest.ticket;
    if (
      typeof manifestTicket !== "number" || !Number.isInteger(manifestTicket) || manifestTicket <= 0
      || typeof manifest.ticketBranch !== "string" || !manifest.ticketBranch.trim()
      || typeof manifest.commit !== "string" || !/^[0-9a-f]{40,64}$/i.test(manifest.commit)
      || !Array.isArray(manifest.validation) || manifest.validation.length === 0
      || !Array.isArray(manifest.evidence)
    ) throw new Error("El manifest de completion carece de campos requeridos");
    if (manifest.validation.some((entry) =>
      typeof entry !== "object" || entry === null
      || typeof entry.command !== "string" || !entry.command.trim()
      || typeof entry.result !== "string" || !entry.result.trim()
    )) throw new Error("Las validaciones del manifest de completion son inválidas");
    if (manifest.evidence.some((entry) =>
      typeof entry !== "object" || entry === null
      || typeof entry.path !== "string" || !entry.path.trim()
      || typeof entry.kind !== "string" || !EVIDENCE_KINDS.includes(entry.kind as EvidenceKind)
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256)
    )) throw new Error("La evidencia del manifest de completion es inválida");
    return manifest as CompletionManifest;
  }

  async validateCompletionManifest(
    manifest: CompletionManifest,
    info: TicketInfo,
    ticket: number,
    workingDirectory: string,
  ): Promise<void> {
    const manifestTicket = manifest.ticket as number;
    if (manifestTicket !== ticket) throw new Error(`El manifest pertenece al ticket ${manifestTicket}, no al ticket ${ticket}`);
    if (info.branch !== manifest.ticketBranch) throw new Error("La rama del manifest no coincide con la rama del ticket");
    const head = (await this.git(["rev-parse", "HEAD"], workingDirectory)).trim();
    if (head !== manifest.commit) throw new Error("El commit del manifest no coincide con HEAD");
    const status = await this.git(["status", "--porcelain", "--untracked-files=all"], workingDirectory);
    if (status.trim()) throw new Error("El repositorio tiene cambios sin guardar; no se aplicará el completion manifest");
    const branch = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
    const expectedBranch = manifest.ticketBranch.slice("refs/heads/".length);
    if (!manifest.ticketBranch.startsWith("refs/heads/") || branch !== expectedBranch) {
      throw new Error("La rama activa no coincide con la rama del manifest");
    }

    const root = await realpath(workingDirectory);
    const seen = new Set<string>();
    for (const evidence of manifest.evidence) {
      const path = await realpath(resolve(evidence.path));
      const relativePath = relative(root, path);
      if (!relativePath || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) {
        throw new Error("La evidencia del manifest debe estar fuera del repositorio fuente");
      }
      const expectedDigest = evidence.sha256.toLowerCase();
      if (seen.has(expectedDigest)) throw new Error(`El digest de evidencia está duplicado: ${evidence.sha256}`);
      seen.add(expectedDigest);
      const file = Bun.file(path);
      if (!await file.exists()) throw new Error(`El archivo de evidencia no existe: ${evidence.path}`);
      const digest = await sha256(new Uint8Array(await file.arrayBuffer()));
      if (digest !== expectedDigest) throw new Error(`El digest de evidencia no coincide: ${evidence.path}`);
    }
  }

  async setEffort(
    ticket: number,
    realEffort: number,
    realEffortHours: number,
    expectedRevision: number,
  ): Promise<{ ticket: number; effort: { real: number; realHours: number }; revision: number }> {
    positiveId(ticket, "El ticket");
    if (!Number.isFinite(realEffort) || realEffort < 0) throw new Error(`Real Effort debe ser un número no negativo: ${realEffort}`);
    if (!Number.isFinite(realEffortHours) || realEffortHours < 0) throw new Error(`Real Effort HH debe ser un número no negativo: ${realEffortHours}`);
    validateQuarterHour(realEffort, "Real Effort");
    validateQuarterHour(realEffortHours, "Real Effort HH");
    if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) throw new Error(`La revision esperada debe ser un entero positivo: ${expectedRevision}`);
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const revision = workItemRevision(item);
    const currentReal = number(item, [TICKET_FIELDS.realEffort]);
    const currentRealHours = number(item, [TICKET_FIELDS.realEffortHours]);
    if (currentReal === realEffort && currentRealHours === realEffortHours) {
      if (revision !== expectedRevision && revision !== expectedRevision + 1) {
        throw new Error(`La revision esperada ${expectedRevision} no coincide con la revision actual ${revision}`);
      }
      return { ticket, effort: { real: realEffort, realHours: realEffortHours }, revision };
    }
    if (revision !== expectedRevision) {
      throw new Error(`La revision esperada ${expectedRevision} no coincide con la revision actual ${revision}`);
    }
    if ((currentReal !== undefined && realEffort < currentReal) || (currentRealHours !== undefined && realEffortHours < currentRealHours)) {
      throw new Error(`El esfuerzo acumulado del ticket ${ticket} no puede disminuir`);
    }

    const verified = await this.patchAndRead(item, [
      { op: "test", path: "/rev", value: expectedRevision },
      { op: "add", path: `/fields/${TICKET_FIELDS.realEffort}`, value: realEffort },
      { op: "add", path: `/fields/${TICKET_FIELDS.realEffortHours}`, value: realEffortHours },
    ], (candidate) => number(candidate, [TICKET_FIELDS.realEffort]) === realEffort
      && number(candidate, [TICKET_FIELDS.realEffortHours]) === realEffortHours);
    if (
      number(verified, [TICKET_FIELDS.realEffort]) !== realEffort
      || number(verified, [TICKET_FIELDS.realEffortHours]) !== realEffortHours
    ) throw new Error(`No se pudo verificar el esfuerzo del ticket ${ticket}`);
    return { ticket, effort: { real: realEffort, realHours: realEffortHours }, revision: workItemRevision(verified) };
  }

  async linkPullRequest(
    hu: number,
    ticket: number,
    pullRequestId: number,
    participant?: AzurePullRequestTarget,
  ): Promise<{ hu: number; ticket: number; pullRequest: number; mergeCommit: string }> {
    positiveId(hu, "La HU");
    positiveId(ticket, "El ticket");
    positiveId(pullRequestId, "El pull request");

    const [parent, item] = await Promise.all([this.readWorkItem(hu), this.readWorkItem(ticket)]);
    const summary = this.toSummary(item);
    if (!HU_WORK_ITEM_TYPES.has(text(parent, "System.WorkItemType") ?? "")) throw new Error(`La HU ${hu} no es una User Story ni un Product Backlog Item`);
    if (!(parent.relations ?? []).some(({ rel, url }) =>
      rel === "System.LinkTypes.Hierarchy-Forward" && relationId(url) === ticket
    )) throw new Error(`El ticket ${ticket} no es hijo directo de la HU ${hu}`);
    await this.readDirectParent(ticket, item);

    const integration = participant ? participantBranch(participant, "target") : uniqueBranch(parent);
    const ticketBranch = participant ? participantBranch(participant, "source") : uniqueBranch(item);
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
    if (associatedCandidates.some((candidate) => candidate.source !== ticketBranch.ref)) {
      throw new Error(`El ticket ${ticket} tiene una asociación nativa a un PR de otra rama`);
    }
    if (associatedCandidates.length > 0 && !associatedCandidates.some((candidate) => candidate.id === pullRequestId)) {
      throw new Error(`El PR ${pullRequestId} entra en conflicto con el PR canónico ya asociado al ticket ${ticket}`);
    }
    const alreadyLinked = associatedCandidates.some((candidate) => candidate.id === pullRequestId);
    if (!alreadyLinked) {
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
    participant?: AzurePullRequestTarget,
  ): Promise<{ ticket: number; pullRequest: number; mergeCommit: string; artifactLink: string }> {
    positiveId(ticket, "El ticket");
    positiveId(pullRequestId, "El pull request");

    const item = await this.readWorkItemValidated(ticket);
    const parent = await this.readDirectParent(ticket, item);
    const integration = participant ? participantBranch(participant, "target") : uniqueBranch(parent);
    const ticketBranch = participant ? participantBranch(participant, "source") : uniqueBranch(item);
    if (!integration.ref || !ticketBranch.ref) throw new Error(`El ticket ${ticket} no tiene ramas de integración y entrega verificables`);
    if (ticketBranch.project !== integration.project || ticketBranch.repository !== integration.repository) {
      throw new Error(`La rama del ticket ${ticket} no coincide con la rama de integración de su HU`);
    }
    const pullRequest = await this.readPullRequest(pullRequestId, integration.project, integration.repository);
    this.validatePullRequest(pullRequest, ticket, integration, ticketBranch);
    const candidates = await this.readPullRequests(ticket, integration.project, integration.ref, integration.project, integration.repository, ticketBranch.ref);
    const validCandidates = candidates.filter((candidate) =>
      candidate.status === "completed" && candidate.mergeStatus === "succeeded" && candidate.target === integration.ref
    );
    const associatedCandidates = validCandidates.filter((candidate) => candidate.associated);
    if (associatedCandidates.some((candidate) => candidate.source !== ticketBranch.ref)) {
      throw new Error(`El ticket ${ticket} tiene una asociación nativa a un PR de otra rama`);
    }
    if (associatedCandidates.length !== 1 || associatedCandidates[0]!.id !== pullRequestId) {
      throw new Error(`El PR ${pullRequestId} no es el único PR canónico asociado al ticket ${ticket}`);
    }
    const project = pullRequest.projectId;
    const repository = pullRequest.repositoryId;
    const mergeCommit = pullRequest.mergeCommit;
    if (!mergeCommit) throw new Error(`El PR ${pullRequestId} no tiene commit de merge verificable`);
    const artifactLink = `vstfs:///Git/Commit/${encodeURIComponent(`${project}/${repository}/${mergeCommit}`)}`;
    const existingCommitUrl = text(item, "Custom.URLCommit");
    const alreadyLinked = commitArtifactLinks(item).includes(artifactLink);
    // A ticket delivered across repositories carries one commit link per repository; the first one
    // delivered stays the primary (Custom.URLCommit) and the rest are added alongside it.
    const secondary = !!participant && !!existingCommitUrl && existingCommitUrl !== artifactLink;
    if (!secondary) {
      const existing = fixedCommit(item);
      if (existing && (
        existing.project !== project || existing.repository !== repository || existing.commit !== mergeCommit
      )) throw new Error(`El ticket ${ticket} ya tiene un Fixed in Commit distinto; conflicto`);
      if (existingCommitUrl && existingCommitUrl !== artifactLink) {
        throw new Error(`El ticket ${ticket} ya tiene una URL de commit distinta; conflicto`);
      }
    }

    if (!alreadyLinked) {
      await this.patchWorkItem(item, [
        { op: "test", path: "/rev", value: item.rev },
        {
          op: "add",
          path: "/relations/-",
          value: { rel: "ArtifactLink", url: artifactLink, attributes: { name: "Fixed in Commit" } },
        },
        ...(secondary ? [] : [{ op: "add", path: "/fields/Custom.URLCommit", value: artifactLink }]),
      ]);
    } else if (!secondary && !existingCommitUrl) {
      await this.patchWorkItem(item, [
        { op: "test", path: "/rev", value: item.rev },
        { op: "add", path: "/fields/Custom.URLCommit", value: artifactLink },
      ]);
    }

    const verifiedItem = await this.readWorkItem(ticket);
    if (!commitArtifactLinks(verifiedItem).includes(artifactLink)) {
      throw new Error(`No se pudo verificar el Fixed in Commit del PR ${pullRequestId}`);
    }
    if (!secondary) {
      const verified = fixedCommit(verifiedItem);
      if (!verified || verified.project !== project || verified.repository !== repository || verified.commit !== mergeCommit) {
        throw new Error(`No se pudo verificar el Fixed in Commit del PR ${pullRequestId}`);
      }
    }
    return { ticket, pullRequest: pullRequestId, mergeCommit, artifactLink };
  }

  async addAttachment(
    ticket: number,
    filePath: string,
    kind: EvidenceKind,
  ): Promise<{ ticket: number; name: string; kind: EvidenceKind; digest: string; url: string }> {
    positiveId(ticket, "El ticket");
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const { name, digest } = await this.readEvidenceFile(filePath, kind);
    const existing = (item.relations ?? [])
      .filter(({ rel }) => rel === "AttachedFile")
      .find(({ attributes }) => attachmentDigest(attributes?.comment) === digest);
    if (existing?.url) {
      const existingKind = attachmentKind(existing.attributes?.comment);
      if (existingKind && existingKind !== kind) {
        throw new Error(`El digest ${digest} ya está asociado a otra clase de evidencia`);
      }
      return { ticket, name: existing.attributes?.name ?? name, kind, digest, url: existing.url };
    }

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
          attributes: { name, comment: attachmentComment(kind, digest) },
        },
      }]);
    } catch (error) {
      const recovered = await this.readWorkItem(ticket).catch(() => null);
      const relation = recovered?.relations?.find(({ rel, attributes }) =>
        rel === "AttachedFile" && attachmentDigest(attributes?.comment) === digest
      );
      if (!relation?.url) throw error;
      return { ticket, name: relation.attributes?.name ?? name, kind, digest, url: relation.url };
    }
    const verified = (await this.readWorkItem(ticket)).relations?.find(({ rel, attributes }) =>
      rel === "AttachedFile" && attachmentDigest(attributes?.comment) === digest
    );
    if (!verified?.url) throw new Error(`No se pudo verificar el adjunto ${name}`);
    return { ticket, name, kind, digest, url: verified.url };
  }

  async validateEvidenceFile(filePath: string, kind: EvidenceKind): Promise<void> {
    await this.readEvidenceFile(filePath, kind);
  }

  async validateEvidence(ticket: number, filePath: string): Promise<void> {
    positiveId(ticket, "El ticket");
    const content = await readUtf8File(filePath);
    if (!content.trim()) throw new Error("El archivo de completion-evidence está vacío");
    validateEvidenceContent(content, "command-output");
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const existing = COMPLETION_FIELDS.map((name) => text(item, name)).find(Boolean);
    if (existing && existing !== content) throw new Error(`El ticket ${ticket} ya tiene completion-evidence distinta; conflicto`);
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

  private async readEvidenceFile(filePath: string, kind: EvidenceKind): Promise<ValidatedEvidenceFile> {
    validateEvidenceKind(kind);
    const file = Bun.file(filePath);
    const name = filePath.split(/[\\/]/).pop() ?? "";
    if (!name || name === "." || name === "..") throw new Error(`El archivo de evidencia no tiene un nombre válido: ${filePath}`);
    if (!await file.exists()) throw new Error(`El archivo de evidencia no existe: ${filePath}`);
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`El archivo de evidencia debe tener entre 1 y ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (kind === "screen") {
      validateScreenEvidence(name, bytes);
    } else {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      validateEvidenceContent(content, kind);
    }
    return { name, bytes, digest: await sha256(bytes) };
  }

  private async readWorkItemValidated(ticket: number): Promise<WorkItem> {
    positiveId(ticket, "El ticket");
    const item = await this.readWorkItem(ticket);
    this.toSummary(item);
    return item;
  }

  private async readDirectParent(ticket: number, item: WorkItem): Promise<WorkItem> {
    const parentRelations = (item.relations ?? []).filter(({ rel }) => rel === "System.LinkTypes.Hierarchy-Reverse");
    const parentIds = parentRelations.map(({ url }) => relationId(url));
    const uniqueParentIds = [...new Set(parentIds)];
    if (uniqueParentIds.length !== 1 || uniqueParentIds[0] === undefined) {
      throw new Error(`El ticket ${ticket} no tiene una única HU padre directa`);
    }
    const parentId = uniqueParentIds[0];
    if (!parentId) throw new Error(`El ticket ${ticket} no tiene una HU padre directa`);
    const parent = await this.readWorkItem(parentId);
    if (!HU_WORK_ITEM_TYPES.has(text(parent, "System.WorkItemType") ?? "")) {
      throw new Error(`El padre directo del ticket ${ticket} no es una HU User Story ni un Product Backlog Item`);
    }
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

  private async createPullRequest(
    project: string,
    repository: string,
    source: string,
    target: string,
    ticket: number,
    hu: number,
  ): Promise<TicketPullRequest> {
    try {
      return this.toPullRequest(JSON.parse(await this.az([
        "repos", "pr", "create", "--organization", ORGANIZATION,
        "--project", project, "--repository", repository,
        "--source-branch", source, "--target-branch", target,
        "--title", `Deliver ticket ${ticket}`,
        "--description", `Coordinator-owned delivery for ticket ${ticket} in HU ${hu}`,
        "--output", "json",
      ])));
    } catch (error) {
      const existing = (await this.readPullRequests(ticket, project, target, project, repository, source, "active"))
        .filter((pr) => pr.source === source && pr.target === target);
      if (existing.length > 1) throw new Error(`El ticket ${ticket} tiene múltiples PR activos para su rama`);
      if (existing.length === 1) return existing[0]!;
      try {
        return this.toPullRequest(JSON.parse(await this.az([
          "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "post",
          "--uri", `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/pullrequests?api-version=${API_VERSION}`,
          "--headers", "Content-Type=application/json",
          "--body", JSON.stringify({ sourceRefName: source, targetRefName: target, title: `Deliver ticket ${ticket}`, description: `Coordinator-owned delivery for ticket ${ticket} in HU ${hu}` }),
          "--output", "json",
        ])));
      } catch (fallbackError) {
        throw new Error(`No se pudo crear el PR del ticket ${ticket}: ${sanitizeError(fallbackError)}`, { cause: error });
      }
    }
  }

  /**
   * Azure guards completion with the source commit the merge was computed from and rejects a bare
   * `{"status":"completed"}` with "You must specify a valid LastMergeSourceCommit". Reading it back
   * is not just ceremony: it makes a source branch that moved since the merge was computed fail
   * closed instead of completing a merge nobody evaluated.
   */
  private async completePullRequest(id: number, project: string, repository: string): Promise<void> {
    const pullRequest = await this.readPullRequest(id, project, repository);
    const lastMergeSourceCommit = pullRequest.lastMergeSourceCommit;
    if (!lastMergeSourceCommit) {
      throw new Error(`El PR ${id} no expone el commit fuente del merge; Azure no puede completarlo todavía`);
    }
    try {
      await this.az([
        "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "patch",
        "--uri", `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/pullrequests/${id}?api-version=${API_VERSION}`,
        "--headers", "Content-Type=application/json",
        "--body", JSON.stringify({ status: "completed", lastMergeSourceCommit: { commitId: lastMergeSourceCommit } }),
        "--output", "json",
      ]);
    } catch (error) {
      try {
        await this.az([
          "repos", "pr", "update", "--id", `${id}`, "--organization", ORGANIZATION,
          "--project", project, "--repository", repository, "--status", "completed", "--output", "json",
        ]);
      } catch (fallbackError) {
        throw new Error(`No se pudo completar el PR ${id}: ${sanitizeError(fallbackError)}`, { cause: error });
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
      const alreadyLinked = await this.isPullRequestLinked({
        id,
        projectId: project,
        repositoryId: repository,
        associated: false,
      }, ticket).catch(() => false);
      if (alreadyLinked) return;
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

  /** The Azure project a new child inherits from its HU. */
  private async ticketProject(hu: number): Promise<string> {
    const project = text(await this.readWorkItem(hu), "System.TeamProject");
    if (!project) throw new Error(`La HU ${hu} no expone su proyecto Azure`);
    return project;
  }

  private async createWorkItem(project: string, type: string, patch: unknown[]): Promise<number> {
    const uri = `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/wit/workitems/$${type}?api-version=${API_VERSION}`;
    const created = JSON.parse(await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "post", "--uri", uri,
      "--headers", "Content-Type=application/json-patch+json", "--body", JSON.stringify(patch), "--output", "json",
    ])) as { id?: unknown };
    if (typeof created.id !== "number" || !Number.isInteger(created.id) || created.id <= 0) {
      throw new Error(`Azure no devolvió el id del ${type} creado`);
    }
    return created.id;
  }

  /** Add one relation under a revision guard and confirm it after rereading. */
  private async addRelation(item: WorkItem, rel: string, targetId: number): Promise<WorkItem> {
    return this.patchAndRead(item, [
      { op: "test", path: "/rev", value: workItemRevision(item) },
      {
        op: "add",
        path: "/relations/-",
        value: { rel, url: `${ORGANIZATION}/_apis/wit/workItems/${targetId}` },
      },
    ], (candidate) => (candidate.relations ?? []).some(
      (relation) => relation.rel === rel && relationId(relation.url) === targetId,
    ));
  }

  private async patchWorkItem(item: WorkItem, patch: unknown[]): Promise<void> {
    await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "patch",
      "--uri", `${ORGANIZATION}/_apis/wit/workitems/${item.id}?api-version=${API_VERSION}`,
      "--headers", "Content-Type=application/json-patch+json", "--body", JSON.stringify(patch), "--output", "json",
    ]);
  }

  private async patchAndRead(
    item: WorkItem,
    patch: unknown[],
    matches: (candidate: WorkItem) => boolean,
  ): Promise<WorkItem> {
    try {
      await this.patchWorkItem(item, patch);
    } catch (error) {
      if (isRevisionConflict(error)) throw error;
      const recovered = await this.readWorkItem(item.id).catch(() => null);
      if (!recovered || workItemRevision(recovered) !== workItemRevision(item) + 1 || !matches(recovered)) throw error;
      return recovered;
    }
    const verified = await this.readWorkItem(item.id);
    if (!matches(verified)) throw new Error(`No se pudo verificar la mutación del work item ${item.id}`);
    return verified;
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
    status = "completed",
  ): Promise<TicketPullRequest[]> {
    if (!project) return [];
    const args = [
      "repos", "pr", "list", "--organization", ORGANIZATION, "--project", project,
      ...(repository ? ["--repository", repository] : []),
      "--status", status, "--output", "json",
    ];
    let payload: PullRequestPayload[];
    try {
      payload = this.pullRequestList(JSON.parse(await this.az(args)));
    } catch (error) {
      const uri = repository
        ? `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/pullrequests?searchCriteria.status=${status}&api-version=${API_VERSION}`
        : `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/git/pullrequests?searchCriteria.status=${status}&api-version=${API_VERSION}`;
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
    const lastMergeSourceCommit = payload.lastMergeSourceCommit?.commitId;
    // Azure creates no merge commit when the source is already contained in the target: the pull
    // request completes and closes with nothing to merge, which is the ordinary shape of a
    // participant repository that this ticket did not need to change. The commit that delivered the
    // work is then the source commit itself, and that is what the ticket must be linked to. Only a
    // completed and merged pull request earns the fallback: an active one has delivered nothing.
    const merged = payload.status === "completed" && payload.mergeStatus === "succeeded";
    return {
      id,
      status: payload.status,
      mergeStatus: payload.mergeStatus,
      source,
      target,
      mergeCommit: payload.lastMergeCommit?.commitId ?? payload.mergeCommit
        ?? (merged ? lastMergeSourceCommit : undefined),
      lastMergeSourceCommit,
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
    ticketBranch: string | null,
  ): CompletionGate[] {
    const unmet: CompletionGate[] = [];
    if (summary.state !== "Done") unmet.push(GATE.ticketState);
    if (!evidence) unmet.push(GATE.completionEvidence);
    const realEffort = number(item, ["Custom.EsfuerzoReal"]);
    const realEffortHours = number(item, ["Custom.EsfuerzoRealHH"]);
    if (realEffort === undefined || realEffort <= 0) unmet.push(GATE.realEffort);
    if (realEffortHours === undefined || realEffortHours <= 0) unmet.push(GATE.realEffortHours);
    if (!text(item, "Custom.URLCommit")) unmet.push(GATE.commitUrl);
    if (!hasEvidenceCapture(item)) unmet.push(GATE.attachedCapture);
    if (!integrationBranch) unmet.push(GATE.huIntegrationBranch);
    const validPrs = pullRequests.filter((pr) =>
      pr.status === "completed" && pr.mergeStatus === "succeeded" && pr.target === integrationBranch
      && pr.source === ticketBranch
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
