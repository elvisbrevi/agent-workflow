import type { GhRunner } from "./managed-queue-service.ts";
import type { AssignedWork } from "../workspace/assigned-work.ts";

export async function githubAssignedWork(gh: GhRunner, directory: string): Promise<AssignedWork> {
  const repo = JSON.parse(await gh(["repo", "view", "--json", "nameWithOwner"], directory));
  const items = JSON.parse(await gh(["issue", "list", "--assignee", "@me", "--state", "open", "--limit", "200", "--json", "number,title,state,url"], directory)) as Array<{ number: number; title: string; state: string; url: string }>;
  return {
    tracker: "github", scope: repo.nameWithOwner, truncated: items.length >= 200,
    items: items.map((item) => ({ id: item.number, title: item.title, type: "Issue", state: item.state, url: item.url, hu: null })),
  };
}
