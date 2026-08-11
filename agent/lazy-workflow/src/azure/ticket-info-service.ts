import { $ } from "bun";

const ORGANIZATION = "https://dev.azure.com/SubdepartamentoSolucionesTI";
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";

const COMPLETION_FIELDS = [
  "Custom.CompletionEvidence",
  "Custom.b505c83e-3745-4d8b-b76b-b3086a0c4c71",
] as const;

const GATE = {
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
}

export interface TicketInfo {
  hu: { id: number; title?: string };
  ticket: TicketSummary;
  branch: string | null;
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
  attributes?: { name?: string };
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

export type AzRunner = (args: string[]) => Promise<string>;

function positiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} debe ser un entero positivo: ${value}`);
}

function text(item: WorkItem, name: string): string | undefined {
  const value = item.fields?.[name];
  return typeof value === "string" && value.trim() ? value : undefined;
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
  if (!match || !branch || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
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
  const unique = [...new Map(links.map((link) => [link.ref, link])).values()];
  if (unique.length > 1) throw new Error("existen multiples Branch ArtifactLink distintos");
  return unique[0] ?? { ref: null };
}

function hasTicketNumber(ref: string | undefined, ticket: number): boolean {
  if (!ref?.startsWith("refs/heads/")) return false;
  return new RegExp(`(?:^|[/_.-])${ticket}(?:$|[/_.-])`).test(ref.slice("refs/heads/".length));
}

function fixedCommit(item: WorkItem): string | null {
  const relation = (item.relations ?? []).find(({ rel, attributes, url }) =>
    rel === "ArtifactLink" && attributes?.name === "Fixed in Commit" && typeof url === "string"
  );
  if (!relation?.url) return null;
  const decoded = decodeURIComponent(relation.url);
  const match = decoded.match(/\/([^/]+)$/);
  return match?.[1] ?? null;
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

async function runAz(args: string[]): Promise<string> {
  try {
    return await $`az ${args}`.text();
  } catch (error) {
    throw commandError(error);
  }
}

export class AzureTicketInfoService {
  constructor(private readonly az: AzRunner = runAz) {}

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

    const branch = uniqueBranch(parent);
    const pullRequests = await this.readPullRequests(ticket, text(parent, "System.TeamProject"), branch.ref);
    const associated = pullRequests.filter((pullRequest) => pullRequest.associated);
    const canonical = pullRequests.length === 1
      ? pullRequests[0]!.id
      : associated.length === 1 ? associated[0]!.id : null;
    const completionEvidence = COMPLETION_FIELDS.map((fieldName) => text(item, fieldName)).find(Boolean) ?? null;
    const mergeCommit = pullRequests.find(({ id }) => id === canonical)?.mergeCommit ?? fixedCommit(item);
    const unmet = this.unmetGates(summary, item, branch.ref, pullRequests, canonical, completionEvidence, mergeCommit);

    return {
      hu: { id: hu, title: text(parent, "System.Title") },
      ticket: summary,
      branch: branch.ref,
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
        .map(({ url, attributes }) => ({ kind: "AttachedFile" as const, name: attributes?.name, url })),
      completionEvidence,
      gates: {
        satisfied: Object.values(GATE).filter((gate) => !unmet.includes(gate)),
        unmet,
      },
    };
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
        .map(({ url, attributes }) => ({ kind: "AttachedFile" as const, name: attributes?.name, url })),
    };
  }

  async getEvidence(ticket: number): Promise<{ ticket: number; completionEvidence: string | null }> {
    const item = await this.readWorkItemValidated(ticket);
    return { ticket, completionEvidence: COMPLETION_FIELDS.map((name) => text(item, name)).find(Boolean) ?? null };
  }

  private async readWorkItemValidated(ticket: number): Promise<WorkItem> {
    positiveId(ticket, "El ticket");
    const item = await this.readWorkItem(ticket);
    this.toSummary(item);
    return item;
  }

  private async readWorkItem(id: number): Promise<WorkItem> {
    const args = ["boards", "work-item", "show", "--id", `${id}`, "--organization", ORGANIZATION, "--expand", "relations", "--output", "json"];
    try {
      return JSON.parse(await this.az(args)) as WorkItem;
    } catch (error) {
      const uri = `${ORGANIZATION}/_apis/wit/workitems/${id}?$expand=relations&api-version=${API_VERSION}`;
      try {
        return JSON.parse(await this.az([
          "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get", "--uri", uri, "--output", "json",
        ])) as WorkItem;
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

  private async readPullRequests(ticket: number, project: string | undefined, branch: string | null): Promise<TicketPullRequest[]> {
    if (!project) return [];
    const args = ["repos", "pr", "list", "--organization", ORGANIZATION, "--project", project, "--status", "completed", "--output", "json"];
    let payload: PullRequestPayload[];
    try {
      payload = JSON.parse(await this.az(args)) as PullRequestPayload[];
    } catch (error) {
      const branchLink = branch ? branchLinks({ relations: [] }) : [];
      if (branchLink.length > 0) throw commandError(error);
      return [];
    }
    const candidates = payload
      .map((pr) => this.toPullRequest(pr))
      .filter((pr): pr is TicketPullRequest => pr !== null)
      .filter((pr) => hasTicketNumber(pr.source, ticket))
      .filter((pr) => !branch || pr.target === branch);
    return Promise.all(candidates.map(async (pr) => ({
      ...pr,
      associated: await this.isPullRequestLinked(pr.id, ticket),
    })));
  }

  private toPullRequest(payload: PullRequestPayload): TicketPullRequest | null {
    const id = payload.pullRequestId ?? payload.id;
    if (!Number.isInteger(id)) return null;
    return {
      id,
      status: payload.status,
      mergeStatus: payload.mergeStatus,
      source: payload.sourceRefName ?? payload.source,
      target: payload.targetRefName ?? payload.target,
      mergeCommit: payload.lastMergeCommit?.commitId ?? payload.mergeCommit,
      repositoryId: payload.repository?.id ?? payload.repositoryId,
      projectId: payload.repository?.project?.id ?? payload.projectId,
      associated: false,
    };
  }

  private async isPullRequestLinked(pullRequest: number, ticket: number): Promise<boolean> {
    try {
      const output = await this.az([
        "repos", "pr", "work-item", "list", "--id", `${pullRequest}`, "--organization", ORGANIZATION, "--query", "[].id", "--output", "json",
      ]);
      const workItems = JSON.parse(output) as Array<number | string | { id?: number | string }>;
      return workItems.some((item) => Number(typeof item === "object" ? item.id : item) === ticket);
    } catch {
      return false;
    }
  }

  private unmetGates(
    summary: TicketSummary,
    item: WorkItem,
    branch: string | null,
    pullRequests: TicketPullRequest[],
    canonical: number | null,
    evidence: string | null,
    mergeCommit: string | null,
  ): CompletionGate[] {
    const unmet: CompletionGate[] = [];
    if (summary.state !== "Done") unmet.push(GATE.ticketState);
    if (!evidence) unmet.push(GATE.completionEvidence);
    if (!number(item, ["Custom.EsfuerzoReal"])) unmet.push(GATE.realEffort);
    if (!number(item, ["Custom.EsfuerzoRealHH"])) unmet.push(GATE.realEffortHours);
    if (!text(item, "Custom.URLCommit")) unmet.push(GATE.commitUrl);
    if (!(item.relations ?? []).some(({ rel }) => rel === "AttachedFile")) unmet.push(GATE.attachedCapture);
    if (!branch) unmet.push(GATE.huIntegrationBranch);
    const validPr = pullRequests.find((pr) => pr.id === canonical && pr.status === "completed" && pr.mergeStatus === "succeeded");
    if (!validPr) unmet.push(GATE.completedHuTargetedPr);
    if (validPr && !validPr.associated) unmet.push(GATE.nativePullRequestAssociation);
    if (!mergeCommit) unmet.push(GATE.mergeCommitArtifact);
    return unmet;
  }
}
