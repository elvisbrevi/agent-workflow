/**
 * Azure reads and effects that happen before a repository exists on this
 * machine: what is plannable across the organization, its projects and
 * repositories, and cloning or creating one (ADR-0049). Every call names the
 * organization from `LAZY_WORKFLOW_AZURE_ORGANIZATION`.
 */
import { azureOrganization } from "./azure-organization.ts";
import { STORY_WORK_ITEM_TYPES } from "./hu-info.ts";
import type { AzRunner } from "./ticket-info-service.ts";
import type { GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import type { PlannableWork, ProvisionedRepository, RemoteRepository } from "../workspace/plannable-work.ts";

const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

/** The state each HU type is taken in: a story while it is being developed, a Bug while it is in progress. */
export const PLANNABLE_STATES: Readonly<Record<string, string>> = {
  "User Story": "En Desarrollo",
  "Product Backlog Item": "En Desarrollo",
  Bug: "En progreso",
};

const LIMIT = 200;

interface Item {
  id: number;
  fields: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string }>;
}

const wiqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * The HUs and Bugs assigned to the operator in the state they are taken in,
 * across the organization or one project. A Bug under a story is that story's
 * ticket and is left out (ADR-0047).
 */
export async function azurePlannableWork(az: AzRunner, project: string | null): Promise<PlannableWork> {
  const organization = azureOrganization();
  const post = async <T>(path: string, body: unknown): Promise<T> => JSON.parse(await az([
    "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", "post",
    "--uri", `${organization}/_apis/wit/${path}`, "--headers", "Content-Type=application/json", "--body", JSON.stringify(body), "--output", "json",
  ]));
  const states = Object.entries(PLANNABLE_STATES)
    .map(([type, state]) => `([System.WorkItemType] = ${wiqlText(type)} AND [System.State] = ${wiqlText(state)})`)
    .join(" OR ");
  const scope = project ? ` AND [System.TeamProject] = ${wiqlText(project)}` : "";
  const query = await post<{ workItems: Array<{ id: number }> }>(`wiql?$top=${LIMIT + 1}&api-version=7.1`, {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND (${states})${scope} ORDER BY [System.ChangedDate] DESC`,
  });
  const ids = query.workItems.map((item) => item.id).slice(0, LIMIT);
  if (!ids.length) return { tracker: "azure", items: [], truncated: false };
  const { value } = await post<{ value: Item[] }>("workitemsbatch?api-version=7.1", { ids, $expand: "Relations" });
  const parentOf = (item: Item): number | null => {
    const url = item.relations?.find((relation) => relation.rel === "System.LinkTypes.Hierarchy-Reverse")?.url;
    const match = url?.match(/\/workItems\/(\d+)$/i);
    return match ? Number(match[1]) : null;
  };
  const field = (item: Item, name: string): string => String(item.fields[name] ?? "");
  const bugParents = [...new Set(value.filter((item) => field(item, "System.WorkItemType") === "Bug").map(parentOf).filter((id): id is number => id !== null))];
  const parents = bugParents.length
    ? (await post<{ value: Item[] }>("workitemsbatch?api-version=7.1", { ids: bugParents, fields: ["System.WorkItemType"], errorPolicy: "Omit" })).value
    : [];
  const stories = new Set(parents.filter((item) => item && STORY_WORK_ITEM_TYPES.has(field(item, "System.WorkItemType"))).map((item) => item.id));
  return {
    tracker: "azure",
    truncated: query.workItems.length > LIMIT,
    items: value
      .filter((item) => field(item, "System.WorkItemType") !== "Bug" || !stories.has(parentOf(item) ?? 0))
      .map((item) => ({
        id: item.id,
        title: field(item, "System.Title"),
        type: field(item, "System.WorkItemType"),
        state: field(item, "System.State"),
        url: `${organization}/${encodeURIComponent(field(item, "System.TeamProject"))}/_workitems/edit/${item.id}`,
        scope: field(item, "System.TeamProject"),
      })),
  };
}

export async function azureProjects(az: AzRunner): Promise<Array<{ name: string; id: string }>> {
  const answer = JSON.parse(await az(["devops", "project", "list", "--organization", azureOrganization(), "--top", "1000", "--output", "json"])) as
    { value?: Array<{ name?: string; id?: string }> } | Array<{ name?: string; id?: string }>;
  const projects = Array.isArray(answer) ? answer : answer.value ?? [];
  return projects
    .filter((project): project is { name: string; id: string } => typeof project.name === "string" && typeof project.id === "string")
    .map(({ name, id }) => ({ name, id }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

interface AzureRepository {
  name?: string;
  remoteUrl?: string;
  webUrl?: string;
  defaultBranch?: string | null;
  isDisabled?: boolean;
}

export async function azureRepositories(az: AzRunner, project: string): Promise<RemoteRepository[]> {
  const answer = JSON.parse(await az(["repos", "list", "--project", project, "--organization", azureOrganization(), "--output", "json"])) as AzureRepository[];
  return answer
    .filter((repository) => typeof repository.name === "string" && repository.isDisabled !== true)
    .map((repository) => ({
      name: repository.name!,
      scope: project,
      url: repository.webUrl ?? repository.remoteUrl ?? "",
      defaultBranch: repository.defaultBranch?.replace(/^refs\/heads\//, "") ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The credential helper a cloned Azure repository keeps: it answers git with
 * the PAT lz already loads into every run, so a later `code` can push without
 * the secret ever being written to disk or shown in a process list.
 */
export const AZURE_CREDENTIAL_HELPER = '!f() { test "$1" = get || return 0; echo username=lz; echo "password=$AZURE_DEVOPS_EXT_PAT"; }; f';

/** The clone URL without the user name Azure embeds in it, and the origin its helper is keyed by. */
function cloneTarget(remoteUrl: string): { url: string; origin: string } {
  const url = new URL(remoteUrl);
  url.username = "";
  url.password = "";
  return { url: url.toString(), origin: url.origin };
}

async function cloneInto(git: GitRunner, remoteUrl: string, destination: string, parent: string): Promise<string> {
  const { url, origin } = cloneTarget(remoteUrl);
  const helper = `credential.${origin}.helper`;
  await git(["-c", `${helper}=${AZURE_CREDENTIAL_HELPER}`, "clone", url, destination], parent);
  await git(["config", "--local", helper, AZURE_CREDENTIAL_HELPER], destination);
  return url;
}

export async function cloneAzureRepository(
  az: AzRunner,
  git: GitRunner,
  input: { project: string; repository: string; destination: string; parent: string },
): Promise<ProvisionedRepository> {
  const shown = JSON.parse(await az(["repos", "show", "--repository", input.repository, "--project", input.project, "--organization", azureOrganization(), "--output", "json"])) as AzureRepository;
  if (!shown.remoteUrl) throw new Error(`Azure no devolvio la URL de ${input.project}/${input.repository}`);
  const remote = await cloneInto(git, shown.remoteUrl, input.destination, input.parent);
  return { tracker: "azure", scope: input.project, repository: input.repository, destination: input.destination, remote, created: false };
}

/**
 * Creates the repository in the project and leaves it with a first commit on
 * `main`: a delivery provisions `hu/<HU>` from `main` or `master`, which an
 * empty repository does not have.
 */
export async function createAzureRepository(
  az: AzRunner,
  git: GitRunner,
  input: { project: string; repository: string; destination: string; parent: string },
  writeReadme: (path: string, content: string) => Promise<void>,
): Promise<ProvisionedRepository> {
  const created = JSON.parse(await az(["repos", "create", "--name", input.repository, "--project", input.project, "--organization", azureOrganization(), "--output", "json"])) as AzureRepository;
  if (!created.remoteUrl) throw new Error(`Azure no devolvio la URL del repositorio creado ${input.project}/${input.repository}`);
  const remote = await cloneInto(git, created.remoteUrl, input.destination, input.parent);
  await writeReadme(`${input.destination}/README.md`, `# ${input.repository}\n`);
  await git(["add", "README.md"], input.destination);
  await git(["commit", "-m", `Initialize ${input.repository}`], input.destination);
  await git(["branch", "-M", "main"], input.destination);
  await git(["push", "-u", "origin", "main"], input.destination);
  return { tracker: "azure", scope: input.project, repository: input.repository, destination: input.destination, remote, created: true };
}
