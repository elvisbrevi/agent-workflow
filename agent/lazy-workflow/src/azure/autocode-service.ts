import { $ } from "bun";
import { HuInfo, type HuInfoData } from "./hu-info.ts";
import { reportOperator } from "../output/operator-output.ts";

const ORGANIZATION = "https://dev.azure.com/SubdepartamentoSolucionesTI";
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
  ensureIntegrationBranch(hu: number): Promise<string | null>;
  getAutocodeState(hu: number, integrationBranch?: string): Promise<AutocodeState>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  getAutocodeContextForTicket(hu: number, ticket: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<TicketCompletionVerification>;
  getCompletedTicketBranch(context: AutocodeContext): Promise<string | null>;
  waitForAccess(hu: number): Promise<void>;
}

interface WorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: Array<{
    rel?: string;
    url?: string;
    attributes?: { name?: string };
  }>;
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
  const output = await az(args);
  return JSON.parse(output) as WorkItem;
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

export class AzureAutocodeService implements AutocodeAzureService {
  constructor(private readonly az: AzRunner = runAz) {}

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

  async ensureIntegrationBranch(hu: number): Promise<string | null> {
    const parent = await show(hu, true, this.az);
    return integrationBranchFrom(parent) ?? `refs/heads/hu/${hu}`;
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
    if (!(item.relations ?? []).some((relation) => relation.rel === "AttachedFile")) {
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
      .filter((pr) => belongsToTicket(pr.source, context.ticket.id));
    const pr = prs.length === 1 ? prs[0] : undefined;
    return pr?.status === "completed"
      && pr.mergeStatus === "succeeded"
      && pr.target === context.integrationBranch
      && pr.source?.startsWith("refs/heads/")
      && Number.isInteger(pr.id)
      && typeof pr.projectId === "string"
      && typeof pr.repositoryId === "string"
      && typeof pr.mergeCommit === "string"
      ? pr
      : null;
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

async function runAz(args: string[]): Promise<string> {
  try {
    return await $`az ${args}`.text();
  } catch (error) {
    throw new Error("Azure command failed", { cause: error });
  }
}
