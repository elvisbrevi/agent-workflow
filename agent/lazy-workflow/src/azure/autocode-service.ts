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

export interface AutocodeState {
  context: AutocodeContext | null;
  pending: boolean;
}

export interface AutocodeAzureService {
  getHuInfo(hu: number): Promise<HuInfo>;
  ensureIntegrationBranch(hu: number, prompt: string): Promise<string | null>;
  getAutocodeState(hu: number, integrationBranch?: string): Promise<AutocodeState>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<boolean>;
  waitForAccess(hu: number): Promise<void>;
}

interface WorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string }>;
}

interface GitRef {
  name?: string;
  objectId?: string;
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

function branchName(value: string): string {
  return value.replace(/^refs\/heads\//, "");
}

function promptSourceBranch(prompt: string): string | null {
  const match = prompt.match(/(?:source|origen)\s+branch(?:\s+(?:is|es))?\s*[:=]?\s*([\w./-]+)/i);
  return match?.[1] ? branchName(match[1]) : null;
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

  async ensureIntegrationBranch(hu: number, prompt: string): Promise<string | null> {
    const parent = await show(hu, true);
    const registered = field(parent, "Custom.IntegrationBranch");
    const project = field(parent, "System.TeamProject");
    const repository = field(parent, "Custom.Repository");
    const options = [promptSourceBranch(prompt), "main", "master"].filter((value): value is string => Boolean(value));
    const refs = await this.listRefs(project, repository);
    const integrationBranch = registered ?? `refs/heads/hu/${hu}`;
    const existing = refs.find((ref) => ref.name === integrationBranch);
    if (existing?.name) {
      if (!registered) await this.registerIntegrationBranch(hu, existing.name, project);
      return existing.name;
    }

    for (const source of options) {
      const sourceRef = refs.find((ref) => branchName(ref.name ?? "") === source && ref.objectId);
      if (!sourceRef?.objectId) continue;
      await this.az(["repos", "ref", "create", "--name", integrationBranch, "--object-id", sourceRef.objectId, ...this.repositoryArgs(project, repository)]);
      await this.registerIntegrationBranch(hu, integrationBranch, project);
      return integrationBranch;
    }
    return null;
  }

  async getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null> {
    return (await this.getAutocodeState(hu, integrationBranch)).context;
  }

  async getAutocodeState(hu: number, integrationBranch?: string): Promise<AutocodeState> {
    const parent = await show(hu, true);
    const children = (parent.relations ?? [])
      .filter((relation) => relation.rel === "System.LinkTypes.Hierarchy-Forward")
      .map((relation) => relationId(relation.url))
      .filter((id): id is number => id !== undefined);
    const candidates = await Promise.all(children.map((id) => show(id, true)));
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
    const branch = integrationBranch ?? field(parent, "Custom.IntegrationBranch");
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

  private async listRefs(project?: string, repository?: string): Promise<GitRef[]> {
    const output = await this.az(["repos", "ref", "list", "--filter", "heads/", ...this.repositoryArgs(project, repository)]);
    return JSON.parse(output) as GitRef[];
  }

  private repositoryArgs(project?: string, repository?: string): string[] {
    return ["--organization", ORGANIZATION, ...(project ? ["--project", project] : []), ...(repository ? ["--repository", repository] : [])];
  }

  private async registerIntegrationBranch(hu: number, integrationBranch: string, project?: string): Promise<void> {
    await this.az(["boards", "work-item", "update", "--id", `${hu}`, "--organization", ORGANIZATION, ...(project ? ["--project", project] : []), "--fields", `Custom.IntegrationBranch=${integrationBranch}`]);
  }

  private async az(args: string[]): Promise<string> {
    return await $`az ${args}`.text();
  }
}
