import { $ } from "bun";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

const ORGANIZATION = "https://dev.azure.com/example-org";
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";

/** Cuánto se espera a que Azure materialice el merge que acaba de encolar. */
const PULL_REQUEST_MERGE_ATTEMPTS = 15;
const PULL_REQUEST_MERGE_INTERVAL_MS = 2_000;
/** Estados de merge que Azure ya no va a mover por su cuenta. */
const PULL_REQUEST_MERGE_FAILURES = ["conflicts", "failure", "rejectedByPolicy"];
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
  "En espera",
  "En progreso",
  "In Progress",
  "En revisión",
  "Resolved",
  "Done",
  "Closed",
  "Removed",
  "Removido",
  "En Desarrollo",
  "Desarrollo Terminado",
]);
const STATE_TRANSITIONS: Record<string, readonly string[]> = {
  New: ["Active", "En progreso", "In Progress", "Removed"],
  Active: ["En progreso", "In Progress", "Resolved", "Done", "Removed"],
  // "En espera" is Scrum SAG's Proposed-category state for Task/Bug: the process starts work
  // items there instead of "New" (ADR: process/workItemTypes/ScrumSAG.Task/states), so it needs
  // the same direct-to-Done reach the stock "New"/"Active" states already have for automation.
  "En espera": ["En progreso", "En revisión", "Done", "Removido"],
  "En progreso": ["Active", "Resolved", "Done", "Removed", "En revisión", "Removido"],
  "In Progress": ["Active", "En progreso", "Resolved", "Done", "Removed"],
  // "En revisión" is Scrum SAG's Resolved-category state for Task/Bug, the counterpart of the
  // stock "Resolved" above.
  "En revisión": ["En progreso", "Done", "Removido"],
  Resolved: ["Active", "En progreso", "In Progress", "Done", "Closed"],
  Done: ["Done"],
  Closed: ["Closed"],
  Removed: ["Removed"],
  Removido: ["Removido"],
  "En Desarrollo": ["Desarrollo Terminado"],
  "Desarrollo Terminado": ["Desarrollo Terminado"],
};

const HU_OPEN_DELIVERY_STATES = new Set([
  "New",
  "Active",
  "En espera",
  "En progreso",
  "In Progress",
  "En revisión",
  "Resolved",
]);

const COMPLETION_FIELDS = [
  "Custom.CompletionEvidence",
  "Custom.b505c83e-3745-4d8b-b76b-b3086a0c4c71",
] as const;

/**
 * Repository-owned creation defaults (ADR-0006): fields a project may demand on
 * a delivery ticket that a plan never names, with where each value comes from.
 *
 * A project rule can require a field the catalog does not mark `alwaysRequired`,
 * so the trigger is that the work-item type *defines* the field, not that Azure
 * calls it required — writing a value the ticket would carry anyway is harmless,
 * while a missing one stops the whole publication with TF401320. A project that
 * does not define the field is left untouched, and an explicit `--field` always
 * wins, so the defaults are never a way to guess a field the operator named.
 */
const CREATION_DEFAULTS = {
  "Microsoft.VSTS.Scheduling.RemainingWork": "estimate",
  "Custom.EsfuerzoEstimadoHH": "estimate",
  "Custom.Mes": "month",
} as const;

/** The months as Azure's Spanish pick lists spell them; the index is `getMonth()`. */
const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

const GATE = {
  pinnedTicketContext: "pinned-ticket-context",
  ticketState: "ticket-state",
  completionEvidence: "completion-evidence",
  realEffort: "real-effort",
  realEffortHours: "real-effort-hours",
  commitUrl: "commit-url",
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
}

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
  attributes?: { name?: string; comment?: string };
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

export type AzRunner = (args: string[]) => Promise<string>;

function positiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} debe ser un entero positivo: ${value}`);
}

function text(item: WorkItem, name: string): string | undefined {
  const value = item.fields?.[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Some projects define the completion-evidence field as html, so Azure stores its own normalization
 * of whatever was written and reads it back with markup the writer never sent. Judging "already
 * written" by exact equality then turns a second run of the same delivery into a false conflict, so
 * equality is judged on the text the field carries rather than on its markup.
 */
function evidenceTextContent(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    // A cell boundary is a boundary: without it a table -- which is most of the document now --
    // compares as its cells run together, so two different documents can read as the same one and
    // any spacing Azure adds between cells on read-back reads as a conflict that never clears.
    .replace(/<\/(?:div|p|li|tr|td|th|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#3(?:9|4);/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the evidence a ticket already carries is this delivery's own.
 *
 * The field carries the rendered document now, but a ticket completed before it did carries the
 * bytes of the text file instead. Judging only against the document turns every rerun over such a
 * ticket into a conflict nobody can clear — at a gate reached with the pull requests already
 * merged, which is exactly where a delivery must not become unrecoverable.
 */
function publishedAlready(existing: string, ...candidates: string[]): boolean {
  const stored = evidenceTextContent(existing);
  return candidates.some((candidate) => evidenceTextContent(candidate) === stored);
}

/** El resumen tal cual lo dijo la sesión, con lo mínimo para que el campo conserve sus líneas. */
function summaryHtml(summary: string): string {
  return summary.trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
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

/**
 * Who a child ticket goes to: the HU's `Desarrollador 1`, never its `Assigned
 * To`. The HU is assigned to whoever answers for it, which is routinely not the
 * person who writes the code, and a ticket lands on the developer.
 *
 * `uniqueName` is the unambiguous identity — a display name can repeat across a
 * directory — and a plain string is already whatever the project stored.
 */
function developer(item: WorkItem): string | undefined {
  const value = item.fields?.["Custom.Desarrollador1"];
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "object" && value !== null) {
    for (const key of ["uniqueName", "displayName"] as const) {
      const name = (value as Record<string, unknown>)[key];
      if (typeof name === "string" && name.trim()) return name;
    }
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

/** Un PR que Azure ya integró en la rama de la HU: el único que puede responder por la entrega. */
function integratedPullRequest(pullRequest: TicketPullRequest, integrationBranch: string | null): boolean {
  return pullRequest.status === "completed"
    && pullRequest.mergeStatus === "succeeded"
    && pullRequest.target === integrationBranch;
}

/**
 * La rama que el ticket entregó, leída del PR que la integró.
 *
 * Completar el PR con `deleteSourceBranch` borra la rama del ticket (ADR-0010) y Azure
 * retira con ella el Branch ArtifactLink del work item. Después del merge la rama solo
 * vive en el PR asociado que la integró en la rama de la HU, así que se lee de ahí: darla
 * por ausente dejaba el manifest inverificable y los gates incumplidos con la entrega ya
 * mergeada. Solo una rama única responde; varias no son una respuesta.
 */
function mergedTicketBranch(
  pullRequests: readonly TicketPullRequest[],
  integrationBranch: string | null,
  ticket: number,
): string | null {
  const sources = [...new Set(pullRequests
    .filter((pullRequest) =>
      pullRequest.associated
      && integratedPullRequest(pullRequest, integrationBranch)
      && hasTicketNumber(pullRequest.source, ticket)
    )
    .map(({ source }) => source!))];
  return sources.length === 1 ? sources[0]! : null;
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

/** Una rama Azure nombrada con su repositorio: lo que un Branch ArtifactLink o un PR resuelven. */
interface BranchLink {
  ref: string | null;
  project?: string;
  repository?: string;
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

export async function runAzureCommand(args: string[]): Promise<string> {
  try {
    return await $`az ${args}`.text();
  } catch (error) {
    throw commandError(error);
  }
}

function settledPullRequest(pullRequest: TicketPullRequest): boolean {
  return (pullRequest.status === "completed" && pullRequest.mergeStatus === "succeeded" && !!pullRequest.mergeCommit)
    || pullRequest.status === "abandoned"
    || PULL_REQUEST_MERGE_FAILURES.includes(pullRequest.mergeStatus ?? "");
}

export class AzureTicketInfoService {
  constructor(
    private readonly az: AzRunner = runAzureCommand,
    private readonly git: GitRunner = runGit,
    private readonly sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
  ) {}

  async getTicket(ticket: number): Promise<TicketSummary> {
    positiveId(ticket, "El ticket");
    return this.toSummary(await this.readWorkItem(ticket));
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
      const verified = await this.readSettledPullRequest(exactActive[0]!.id, integration.project, integration.repository);
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
    const verified = await this.readSettledPullRequest(created.id, integration.project, integration.repository);
    this.validatePullRequest(verified, ticket, integration, ticketBranch);
    return { pullRequest: verified.id, mergeCommit: verified.mergeCommit! };
  }

  private async integratePullRequestIn(hu: number, ticket: number, participant: AzurePullRequestTarget): Promise<IntegratedPullRequest> {
    const { project, repository, source, target } = participant;
    const exact = (candidates: TicketPullRequest[]): TicketPullRequest[] =>
      candidates.filter((pr) => pr.source === source && pr.target === target);
    const completed = exact(await this.readPullRequests(ticket, project, project, repository, source))
      .filter((pr) => pr.status === "completed" && pr.mergeStatus === "succeeded");
    if (completed.length > 1) throw new Error(`El ticket ${ticket} tiene múltiples PR completados en ${repository}`);
    if (completed.length === 1) {
      const pr = completed[0]!;
      if (!pr.mergeCommit) throw new Error(`El PR ${pr.id} no tiene commit de merge verificable`);
      return { pullRequest: pr.id, mergeCommit: pr.mergeCommit };
    }
    const active = exact(await this.readPullRequests(ticket, project, project, repository, source, "active"));
    if (active.length > 1) throw new Error(`El ticket ${ticket} tiene múltiples PR activos en ${repository}`);
    const pullRequest = active[0] ?? await this.createPullRequest(project, repository, source, target, ticket, hu);
    await this.completePullRequest(pullRequest.id, project, repository);
    const verified = await this.readSettledPullRequest(pullRequest.id, project, repository);
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
    // Cuando el merge ya borró la rama, el repositorio primario lo sigue nombrando el commit
    // designado (Custom.URLCommit); solo sin ninguno de los dos se cae al de la HU.
    const linkedCommit = fixedCommit(item);
    const deliveryProject = ticketBranch.project ?? linkedCommit?.project ?? integrationBranch.project;
    const deliveryRepository = ticketBranch.repository ?? linkedCommit?.repository ?? integrationBranch.repository;
    const pullRequests = await this.readPullRequests(
      ticket,
      deliveryProject ?? text(parent, "System.TeamProject"),
      deliveryProject,
      deliveryRepository,
      ticketBranch.ref,
    );
    const branchRef = ticketBranch.ref ?? mergedTicketBranch(pullRequests, integrationBranch.ref, ticket);
    const validPullRequests = pullRequests.filter((pullRequest) =>
      integratedPullRequest(pullRequest, integrationBranch.ref) && pullRequest.source === branchRef
    );
    const associated = validPullRequests.filter((pullRequest) => pullRequest.associated);
    const canonical = associated.length === 1 ? associated[0]!.id : null;
    const completionEvidence = COMPLETION_FIELDS.map((fieldName) => text(item, fieldName)).find(Boolean) ?? null;
    const mergeCommit = pullRequests.find(({ id }) => id === canonical)?.mergeCommit ?? linkedCommit?.commit ?? null;
    const unmet = this.unmetGates(
      summary,
      item,
      integrationBranch.ref,
      pullRequests,
      canonical,
      completionEvidence,
      linkedCommit,
      branchRef,
    );

    return {
      hu: { id: hu, title: text(parent, "System.Title") },
      ticket: summary,
      branch: branchRef,
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

  /**
   * The HU-typed counterpart of `getState`: the multi-repository workspace coordinator has to
   * read and verify the HU's own state (to decide, and later confirm, its transition to
   * "Desarrollo Terminado"), and `getState`/`readWorkItemValidated` reject anything that isn't a
   * Task or Bug — so reading the HU through it always threw "no es un Task o Bug de entrega".
   * This validates the HU type the same way `setHuState` already does instead.
   */
  async getHuState(hu: number): Promise<{ hu: number; state: string | null; revision: number | null }> {
    positiveId(hu, "La HU");
    const item = await this.readWorkItem(hu);
    if (!HU_WORK_ITEM_TYPES.has(text(item, "System.WorkItemType") ?? "")) {
      throw new Error(`El work item ${hu} no es una User Story ni un Product Backlog Item`);
    }
    return { hu, state: text(item, TICKET_FIELDS.state) ?? null, revision: item.rev ?? null };
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

    // One read of the HU serves both its project and what the child inherits.
    const parent = await this.readWorkItem(input.hu);
    const project = text(parent, "System.TeamProject");
    if (!project) throw new Error(`La HU ${input.hu} no expone su proyecto Azure`);

    // Last write wins, in ascending order of authority: what the HU passes down,
    // then what the invocation declared, and finally the creation defaults, which
    // only fill what nothing else named.
    const fields = new Map<string, unknown>([
      ["System.Title", title],
      [TICKET_FIELDS.description, description],
    ]);
    // A ticket runs in the same sprint as the HU it delivers and goes to its
    // developer: the plan slices the work, it never reschedules or reroutes it.
    const iteration = text(parent, "System.IterationPath");
    if (iteration) fields.set("System.IterationPath", iteration);
    const owner = developer(parent);
    if (owner) fields.set("System.AssignedTo", owner);
    if (input.estimate !== undefined) fields.set("Microsoft.VSTS.Scheduling.OriginalEstimate", input.estimate);
    if (input.assignee) fields.set("System.AssignedTo", input.assignee);
    for (const { referenceName, value } of input.fields ?? []) fields.set(referenceName, value);
    for (const [referenceName, value] of await this.creationDefaults(project, type, input.estimate)) {
      if (!fields.has(referenceName)) fields.set(referenceName, value);
    }

    const patch = [
      ...[...fields].map(([referenceName, value]) => ({ op: "add", path: `/fields/${referenceName}`, value })),
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${ORGANIZATION}/_apis/wit/workItems/${input.hu}`,
        },
      },
    ];
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

  /** Un ref ausente no es un fallo que deba propagarse: es la respuesta "no lo tengo". */
  private async readCommit(ref: string, workingDirectory: string): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", ref], workingDirectory)).trim();
    } catch {
      return null;
    }
  }

  /** `merge-base --is-ancestor` responde por exit code, que GitRunner convierte en throw. */
  private async contains(descendant: string, candidate: string, workingDirectory: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", candidate, descendant], workingDirectory);
      return true;
    } catch {
      return false;
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

    const { integration, ticketBranch } = await this.deliveryBranches(ticket, parent, item, pullRequestId, participant);
    if (!integration.ref) throw new Error(`La HU ${hu} no tiene una rama de integración vinculada`);
    if (!ticketBranch.ref) throw new Error(`El ticket ${ticket} no tiene una rama vinculada`);
    if (ticketBranch.project !== integration.project || ticketBranch.repository !== integration.repository) {
      throw new Error(`La rama del ticket ${ticket} no coincide con la rama de integración de la HU`);
    }

    const pullRequest = await this.readPullRequest(pullRequestId, integration.project, integration.repository);
    this.validatePullRequest(pullRequest, ticket, integration, ticketBranch);
    const candidates = await this.readPullRequests(ticket, integration.project, integration.project, integration.repository, ticketBranch.ref);
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
    const { integration, ticketBranch } = await this.deliveryBranches(ticket, parent, item, pullRequestId, participant);
    if (!integration.ref || !ticketBranch.ref) throw new Error(`El ticket ${ticket} no tiene ramas de integración y entrega verificables`);
    if (ticketBranch.project !== integration.project || ticketBranch.repository !== integration.repository) {
      throw new Error(`La rama del ticket ${ticket} no coincide con la rama de integración de su HU`);
    }
    const pullRequest = await this.readPullRequest(pullRequestId, integration.project, integration.repository);
    this.validatePullRequest(pullRequest, ticket, integration, ticketBranch);
    const candidates = await this.readPullRequests(ticket, integration.project, integration.project, integration.repository, ticketBranch.ref);
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

  /**
   * La completion-evidence de una entrega: lo último que dijo la sesión (ADR-0037).
   *
   * No hay archivo que leer, digest que fijar ni documento que armar — el texto va al campo tal
   * cual salió de la sesión. Solo se le pone el marcado mínimo que el campo necesita para
   * conservar sus saltos de línea, y la comparación de idempotencia lo deshace, así que el mismo
   * resumen vuelto a publicar se reconoce como publicado en vez de leerse como conflicto.
   */
  async validateSummary(ticket: number, summary: string): Promise<void> {
    positiveId(ticket, "El ticket");
    if (!summary.trim()) throw new Error("El resumen de la sesión está vacío");
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const existing = COMPLETION_FIELDS.map((name) => text(item, name)).find(Boolean);
    if (existing && !publishedAlready(existing, summary)) {
      throw new Error(`El ticket ${ticket} ya tiene completion-evidence distinta; conflicto`);
    }
  }

  async setSummary(ticket: number, summary: string): Promise<{ ticket: number; completionEvidence: string }> {
    positiveId(ticket, "El ticket");
    if (!summary.trim()) throw new Error("El resumen de la sesión está vacío");
    const item = await this.readWorkItemValidated(ticket);
    await this.readDirectParent(ticket, item);
    const fieldName = await this.resolveCompletionField(item);
    const existing = text(item, fieldName);
    if (existing && publishedAlready(existing, summary)) return { ticket, completionEvidence: existing };
    if (existing) throw new Error(`El ticket ${ticket} ya tiene completion-evidence distinta; conflicto`);
    await this.patchWorkItem(item, [{
      op: "test", path: "/rev", value: item.rev,
    }, { op: "add", path: `/fields/${fieldName}`, value: summaryHtml(summary) }]);
    const completionEvidence = text(await this.readWorkItem(ticket), fieldName);
    if (!completionEvidence) throw new Error(`No se pudo verificar completion-evidence del ticket ${ticket}`);
    return { ticket, completionEvidence };
  }

  /**
   * The same logical field lives under different reference names across projects — a readable one in
   * some, a GUID in others — which is why there is a candidate list. A first write has no value to
   * follow, so defaulting to the head of the list writes to a name the project may not define at
   * all: Azure answers TF51535 and the whole delivery stops. Resolve against what the project
   * actually defines, preferring a candidate that already carries this ticket's evidence.
   */
  private async resolveCompletionField(item: WorkItem): Promise<string> {
    const carrying = COMPLETION_FIELDS.find((name) => text(item, name));
    if (carrying) return carrying;
    for (const name of COMPLETION_FIELDS) {
      if (await this.fieldExists(name)) return name;
    }
    throw new Error(`El proyecto Azure no define ningún campo de completion-evidence: ${COMPLETION_FIELDS.join(", ")}`);
  }

  /**
   * The creation defaults this project's work-item type actually accepts, read
   * from its field catalog. A value that cannot be resolved stops the creation
   * rather than letting Azure reject the whole patch with a rule error.
   */
  private async creationDefaults(project: string, type: string, estimate?: number): Promise<Array<[string, unknown]>> {
    const uri = `${ORGANIZATION}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields?$expand=all&api-version=${API_VERSION}`;
    const payload = JSON.parse(await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get", "--uri", uri, "--output", "json",
    ])) as { value?: Array<{ referenceName?: string; allowedValues?: unknown }> };

    const defaults: Array<[string, unknown]> = [];
    for (const [referenceName, source] of Object.entries(CREATION_DEFAULTS)) {
      const defined = (payload.value ?? []).find((field) => field.referenceName === referenceName);
      if (!defined) continue;
      if (source === "estimate") {
        if (estimate !== undefined) defaults.push([referenceName, estimate]);
        continue;
      }
      const allowed = Array.isArray(defined.allowedValues) ? defined.allowedValues.filter((value): value is string => typeof value === "string") : [];
      const month = MONTHS[new Date().getMonth()]!;
      const value = allowed.find((candidate) => candidate.trim().toLowerCase() === month.toLowerCase());
      if (!value) {
        throw new Error(`El campo ${referenceName} del tipo ${type} no acepta el mes ${month}; sus valores son: ${allowed.join(", ")}`);
      }
      defaults.push([referenceName, value]);
    }
    return defaults;
  }

  private async fieldExists(name: string): Promise<boolean> {
    try {
      const payload = JSON.parse(await this.az([
        "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get",
        "--uri", `${ORGANIZATION}/_apis/wit/fields/${encodeURIComponent(name)}?api-version=${API_VERSION}`,
        "--output", "json",
      ])) as { referenceName?: string };
      return payload.referenceName === name;
    } catch {
      return false;
    }
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
      const existing = (await this.readPullRequests(ticket, project, project, repository, source, "active"))
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
        "--body", JSON.stringify({
          status: "completed",
          lastMergeSourceCommit: { commitId: lastMergeSourceCommit },
          completionOptions: { deleteSourceBranch: true },
        }),
        "--output", "json",
      ]);
    } catch (error) {
      try {
        await this.az([
          "repos", "pr", "update", "--id", `${id}`, "--organization", ORGANIZATION,
          "--project", project, "--repository", repository, "--status", "completed",
          "--delete-source-branch", "true", "--output", "json",
        ]);
      } catch (fallbackError) {
        throw new Error(`No se pudo completar el PR ${id}: ${sanitizeError(fallbackError)}`, { cause: error });
      }
    }
  }

  /**
   * Azure encola la completación en vez de resolverla dentro del PATCH: la
   * llamada vuelve con el PR todavía sin merge, y releerlo en ese instante
   * devuelve un `mergeStatus` que aún no llegó a `succeeded` ni tiene commit de
   * merge. Juzgar esa lectura rechazaba un merge que aterrizaba un segundo
   * después y detenía la entrega con el trabajo ya integrado, así que la
   * lectura espera a que el PR quede en un estado que Azure ya no va a mover.
   * El veredicto no cambia: quien decide sigue siendo validatePullRequest, y un
   * PR que no se asiente dentro de la ventana llega ahí igual y falla cerrado.
   */
  private async readSettledPullRequest(id: number, project?: string, repository?: string): Promise<TicketPullRequest> {
    let pullRequest = await this.readPullRequest(id, project, repository);
    for (let attempt = 0; attempt < PULL_REQUEST_MERGE_ATTEMPTS && !settledPullRequest(pullRequest); attempt += 1) {
      await this.sleep(PULL_REQUEST_MERGE_INTERVAL_MS);
      pullRequest = await this.readPullRequest(id, project, repository);
    }
    return pullRequest;
  }

  /**
   * Las ramas contra las que se juzga un PR del ticket.
   *
   * Sin `participant` la rama del ticket es su Branch ArtifactLink, salvo que el merge ya la
   * haya borrado: completar el PR con `deleteSourceBranch` (ADR-0010) retira el link con la
   * rama, y las asociaciones nativas ocurren después de ese merge. Entonces la nombra el PR que
   * se está asociando, y solo si es un PR ya integrado en la rama de la HU cuya rama lleva el
   * número del ticket; cualquier otro deja al ticket sin rama y falla cerrado como antes.
   */
  private async deliveryBranches(
    ticket: number,
    parent: WorkItem,
    item: WorkItem,
    pullRequestId: number,
    participant?: AzurePullRequestTarget,
  ): Promise<{ integration: BranchLink; ticketBranch: BranchLink }> {
    const integration = participant ? participantBranch(participant, "target") : uniqueBranch(parent);
    const declared = participant ? participantBranch(participant, "source") : uniqueBranch(item);
    if (declared.ref || !integration.ref) return { integration, ticketBranch: declared };
    const merged = await this.readPullRequest(pullRequestId, integration.project, integration.repository);
    if (!integratedPullRequest(merged, integration.ref) || !hasTicketNumber(merged.source, ticket)) {
      return { integration, ticketBranch: declared };
    }
    return {
      integration,
      ticketBranch: { ref: merged.source!, project: integration.project, repository: integration.repository },
    };
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
    if (!integrationBranch) unmet.push(GATE.huIntegrationBranch);
    const validPrs = pullRequests.filter((pr) => integratedPullRequest(pr, integrationBranch) && pr.source === ticketBranch);
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
