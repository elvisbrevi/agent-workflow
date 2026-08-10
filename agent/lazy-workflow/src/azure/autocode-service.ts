import { $ } from "bun";
import { HuInfo, type HuInfoData } from "./hu-info.ts";
import { reportOperator } from "../output/operator-output.ts";

const ORGANIZATION = "https://dev.azure.com/SubdepartamentoSolucionesTI";
const COMPLETED_STATES = new Set(["Done", "Closed", "Removed", "Resolved"]);

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

export interface AutocodeAzureService {
  getHuInfo(hu: number): Promise<HuInfo>;
  ensureIntegrationBranch(hu: number): Promise<string | null>;
  getAutocodeState(hu: number, integrationBranch?: string): Promise<AutocodeState>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<boolean>;
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

type AzRunner = (args: string[]) => Promise<string>;

const field = (item: WorkItem, name: string): string | undefined => {
  const value = item.fields?.[name];
  return typeof value === "string" ? value : undefined;
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

  async verifyTicketCompletion(context: AutocodeContext): Promise<boolean> {
    const item = await show(context.ticket.id, false, this.az);
    if (field(item, "System.State") !== "Done") return false;
    const evidence = field(item, "Custom.CompletionEvidence");
    if (!evidence?.trim()) return false;
    const parent = await show(context.hu.id, true, this.az);
    if (integrationBranchFrom(parent) !== context.integrationBranch) return false;
    const output = await this.az([
      "repos", "pr", "list", "--organization", ORGANIZATION,
      ...(context.project ? ["--project", context.project] : []),
      "--status", "completed", "--target-branch", context.integrationBranch,
      "--query", `[?contains(sourceRefName, '${context.ticket.id}')].{status:status,mergeStatus:mergeStatus,target:targetRefName}`,
      "--output", "json",
    ]);
    const prs = JSON.parse(output) as Array<{ status?: string; mergeStatus?: string; target?: string }>;
    return prs.length === 1 && prs[0]?.status === "completed" && prs[0].mergeStatus === "succeeded" && prs[0].target === context.integrationBranch;
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
    throw new Error(`az ${args.join(" ")} fallo: ${commandError(error)}`, { cause: error });
  }
}
