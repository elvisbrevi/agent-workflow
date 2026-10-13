/**
 * A work item's discussion. Neither a plan nor a delivery session may call
 * `az`, so whatever a person asked for in a comment reaches the session only
 * when the coordinator reads it and hands it over (ADR-0050).
 */

import { azureOrganization } from "./azure-organization.ts";

const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
/** Work item comments are still a preview resource in 7.1. */
const COMMENTS_API_VERSION = "7.1-preview.4";

/** One comment of the discussion, as a person wrote it. */
export interface WorkItemComment {
  author?: string;
  date?: string;
  /** Azure stores it as HTML or Markdown, like the description. */
  text: string;
}

/** The discussion, oldest first, read to its last page. Deleted comments stay out. */
export async function readWorkItemComments(
  az: (args: string[]) => Promise<string>,
  project: string,
  id: number,
): Promise<WorkItemComment[]> {
  const comments: WorkItemComment[] = [];
  let token: string | undefined;
  do {
    const page = `order=asc&$top=200${token ? `&continuationToken=${encodeURIComponent(token)}` : ""}`;
    const payload = JSON.parse(await az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "get",
      "--uri", `${azureOrganization()}/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments?${page}&api-version=${COMMENTS_API_VERSION}`,
      "--output", "json",
    ])) as {
      comments?: Array<{ text?: unknown; createdDate?: string; createdBy?: { displayName?: string } }>;
      continuationToken?: string | null;
    };
    for (const comment of payload.comments ?? []) {
      if (typeof comment.text !== "string" || !comment.text.trim()) continue;
      comments.push({ author: comment.createdBy?.displayName, date: comment.createdDate, text: comment.text });
    }
    // A token Azure answers twice would page forever.
    token = payload.continuationToken && payload.continuationToken !== token ? payload.continuationToken : undefined;
  } while (token);
  return comments;
}
