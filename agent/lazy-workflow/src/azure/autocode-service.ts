import { $ } from "bun";
import { HuInfo, type HuInfoData } from "./hu-info.ts";

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

export interface AutocodeAzureService {
  getHuInfo(hu: number): Promise<HuInfo>;
  getAutocodeContext(hu: number): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<boolean>;
  waitForAccess(hu: number): Promise<void>;
}

interface WorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string }>;
}

const field = (item: WorkItem, name: string): string | undefined => {
  const value = item.fields?.[name];
  return typeof value === "string" ? value : undefined;
};

async function show(id: number, expandRelations = false): Promise<WorkItem> {
  const output = expandRelations
    ? await $`az boards work-item show --id ${id} --organization ${ORGANIZATION} --expand relations --output json`.text()
    : await $`az boards work-item show --id ${id} --organization ${ORGANIZATION} --output json`.text();
  return JSON.parse(output) as WorkItem;
}

function relationId(url: string | undefined): number | undefined {
  const id = url?.match(/workItems\/(\d+)$/)?.[1];
  return id ? Number(id) : undefined;
}

export class AzureAutocodeService implements AutocodeAzureService {
  async getHuInfo(hu: number): Promise<HuInfo> {
    const item = await show(hu);
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

  async getAutocodeContext(hu: number): Promise<AutocodeContext | null> {
    const parent = await show(hu, true);
    const children = (parent.relations ?? [])
      .filter((relation) => relation.rel === "System.LinkTypes.Hierarchy-Forward")
      .map((relation) => relationId(relation.url))
      .filter((id): id is number => id !== undefined);
    const candidates = await Promise.all(children.map((id) => show(id, true)));
    const eligible: DeliveryTicket[] = [];
    for (const item of candidates) {
      const type = field(item, "System.WorkItemType");
      const state = field(item, "System.State");
      if ((type !== "Task" && type !== "Bug") || (state && COMPLETED_STATES.has(state))) continue;
      const predecessorIds = (item.relations ?? [])
        .filter((relation) => relation.rel === "System.LinkTypes.Dependency-Reverse")
        .map((relation) => relationId(relation.url))
        .filter((id): id is number => id !== undefined);
      const predecessors = await Promise.all(predecessorIds.map((id) => show(id)));
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
    if (eligible.length === 0) return null;
    const integrationBranch = field(parent, "Custom.IntegrationBranch") ?? `refs/heads/hu/${hu}`;
    return {
      hu: { id: hu, title: field(parent, "System.Title") },
      ticket: eligible[0]!,
      integrationBranch,
      project: field(parent, "System.TeamProject"),
    };
  }

  async verifyTicketCompletion(context: AutocodeContext): Promise<boolean> {
    const item = await show(context.ticket.id);
    if (field(item, "System.State") !== "Done") return false;
    const evidence = field(item, "Custom.CompletionEvidence");
    if (!evidence?.trim()) return false;
    const parent = await show(context.hu.id);
    if (field(parent, "Custom.IntegrationBranch") !== context.integrationBranch) return false;
    const output = context.project
      ? await $`az repos pr list --organization ${ORGANIZATION} --project ${context.project} --status completed --target-branch ${context.integrationBranch} --query ${`[?contains(sourceRefName, '${context.ticket.id}')].{status:status,mergeStatus:mergeStatus,target:targetRefName}`} --output json`.text()
      : await $`az repos pr list --organization ${ORGANIZATION} --status completed --target-branch ${context.integrationBranch} --query ${`[?contains(sourceRefName, '${context.ticket.id}')].{status:status,mergeStatus:mergeStatus,target:targetRefName}`} --output json`.text();
    const prs = JSON.parse(output) as Array<{ status?: string; mergeStatus?: string; target?: string }>;
    return prs.length === 1 && prs[0]?.status === "completed" && prs[0].mergeStatus === "succeeded" && prs[0].target === context.integrationBranch;
  }

  async waitForAccess(hu: number): Promise<void> {
    console.error("OpenCode requiere autenticacion Azure. Ejecuta: az login --use-device-code");
    while (true) {
      try { await this.getHuInfo(hu); return; } catch { await Bun.sleep(2_000); }
    }
  }
}
