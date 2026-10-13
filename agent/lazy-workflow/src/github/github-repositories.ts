/**
 * GitHub reads and effects that happen before a repository exists on this
 * machine: the epics open across the operator's repositories, the accounts
 * they can create a repository in, and cloning or creating one (ADR-0049).
 */
import { isEpicIssue, type GhRunner } from "./managed-queue-service.ts";
import type { PlannableWork, ProvisionedRepository } from "../workspace/plannable-work.ts";

const LIMIT = 200;

/** The operator's own account first, then every organization they belong to. */
export async function githubOwners(gh: GhRunner, directory: string): Promise<string[]> {
  const login = (await gh(["api", "user", "--jq", ".login"], directory)).trim();
  if (!login) throw new Error("gh api user no devolvio la identidad autenticada");
  const organizations = (await gh(["api", "user/orgs", "--paginate", "--jq", ".[].login"], directory))
    .split("\n").map((line) => line.trim()).filter(Boolean);
  return [login, ...organizations.filter((organization) => organization !== login)];
}

interface FoundIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels?: Array<{ name?: string }>;
  repository?: { nameWithOwner?: string };
}

/**
 * Every open epic in the repositories of the operator's account and
 * organizations, by the managed queue's own predicate: the `epic` label, or an
 * `[Epic]`/`[Spec]` title prefix. Search cannot match a prefix, so the title
 * searches are narrowed here.
 */
export async function githubPlannableWork(gh: GhRunner, directory: string): Promise<PlannableWork> {
  const owners = (await githubOwners(gh, directory)).flatMap((owner) => ["--owner", owner]);
  const searches = [["--label", "epic"], ["Epic", "--match", "title"], ["Spec", "--match", "title"]];
  const found = new Map<string, FoundIssue>();
  let truncated = false;
  for (const search of searches) {
    const issues = JSON.parse(await gh([
      "search", "issues", ...search, ...owners, "--state", "open", "--limit", `${LIMIT}`,
      "--json", "number,title,state,url,labels,repository",
    ], directory)) as FoundIssue[];
    truncated ||= issues.length >= LIMIT;
    for (const issue of issues) {
      if (isEpicIssue({ title: issue.title, labels: issue.labels ?? [] })) found.set(issue.url, issue);
    }
  }
  return {
    tracker: "github",
    truncated,
    items: [...found.values()].map((issue) => ({
      id: issue.number,
      title: issue.title,
      type: "Epic",
      state: issue.state.toUpperCase(),
      url: issue.url,
      scope: issue.repository?.nameWithOwner ?? issue.url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/.*$/, "$1"),
    })),
  };
}

const ownerOf = (repository: string): string => repository.split("/")[0]!;

export async function cloneGitHubRepository(
  gh: GhRunner,
  input: { repository: string; destination: string; parent: string },
): Promise<ProvisionedRepository> {
  await gh(["repo", "clone", input.repository, input.destination], input.parent);
  return { tracker: "github", scope: ownerOf(input.repository), repository: input.repository, destination: input.destination, remote: `https://github.com/${input.repository}.git`, created: false };
}

/** Private, with a README so `main` exists for the first delivery to branch from. */
export async function createGitHubRepository(
  gh: GhRunner,
  input: { repository: string; destination: string; parent: string },
): Promise<ProvisionedRepository> {
  await gh(["repo", "create", input.repository, "--private", "--add-readme"], input.parent);
  await gh(["repo", "clone", input.repository, input.destination], input.parent);
  return { tracker: "github", scope: ownerOf(input.repository), repository: input.repository, destination: input.destination, remote: `https://github.com/${input.repository}.git`, created: true };
}
