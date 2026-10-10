import { azureOrganization } from "./azure-organization.ts";
import { azureOrganizationName, azureRepositoryFromRemote } from "./azure-pull-requests.ts";
import type { AzRunner } from "./ticket-info-service.ts";
import type { AssignedWork } from "../workspace/assigned-work.ts";

interface Item {
  id: number;
  fields: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string }>;
}

export async function azureAssignedWork(az: AzRunner, origin: string): Promise<AssignedWork> {
  const repo = azureRepositoryFromRemote(origin);
  const organization = azureOrganization();
  // Reuse the adapter's organization binding before issuing any tracker read.
  if (azureOrganizationName(organization).toLowerCase() !== repo.organization.toLowerCase()) throw new Error("El repositorio no pertenece a LAZY_WORKFLOW_AZURE_ORGANIZATION.");
  const base = `${organization}/${encodeURIComponent(repo.project)}/_apis/wit`;
  const post = async <T>(path: string, body: unknown): Promise<T> => JSON.parse(await az([
    "rest", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--method", "post",
    "--uri", `${base}/${path}`, "--headers", "Content-Type=application/json", "--body", JSON.stringify(body), "--output", "json",
  ]));
  const query = await post<{ workItems: Array<{ id: number }> }>("wiql?$top=201&api-version=7.1", {
    query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed') ORDER BY [System.ChangedDate] DESC",
  });
  const ids = query.workItems.map((item) => item.id).slice(0, 200);
  if (!ids.length) return { tracker: "azure", scope: repo.project, items: [], truncated: false };
  const { value } = await post<{ value: Item[] }>("workitemsbatch?api-version=7.1", { ids, $expand: "Relations" });
  const parentId = (item: Item): number | null => {
    const url = item.relations?.find((relation) => relation.rel === "System.LinkTypes.Hierarchy-Reverse")?.url;
    const match = url?.match(/\/workItems\/(\d+)$/i);
    return match ? Number(match[1]) : null;
  };
  const parentIds = [...new Set(value.map(parentId).filter((id): id is number => id !== null))];
  const parents = parentIds.length ? (await post<{ value: Item[] }>("workitemsbatch?api-version=7.1", { ids: parentIds, fields: ["System.WorkItemType"], errorPolicy: "Omit" })).value : [];
  const stories = new Set(parents.filter((item) => ["User Story", "Product Backlog Item", "Requirement"].includes(String(item.fields["System.WorkItemType"]))).map((item) => item.id));
  return {
    tracker: "azure", scope: repo.project, truncated: query.workItems.length > 200,
    items: value.map((item) => ({
      id: item.id, title: String(item.fields["System.Title"] ?? ""), type: String(item.fields["System.WorkItemType"] ?? ""), state: String(item.fields["System.State"] ?? ""),
      url: `${organization}/${encodeURIComponent(repo.project)}/_workitems/edit/${item.id}`,
      hu: stories.has(parentId(item) ?? 0) ? parentId(item) : null,
    })),
  };
}
