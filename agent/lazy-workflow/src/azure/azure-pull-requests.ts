import { azureOrganization } from "./azure-organization.ts";
import type { AzRunner } from "./ticket-info-service.ts";
import type {
  PullRequestDetail,
  PullRequestDraft,
  PullRequestSummary,
  PullRequestThread,
  PullRequestTools,
  ReviewState,
} from "../pull-request/pull-request-tools.ts";

const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const API_VERSION = "7.1";

/** Azure rejects a longer description; failing here names the limit instead of an opaque 400. */
export const AZURE_DESCRIPTION_LIMIT = 4000;

export interface AzureRepository {
  organization: string;
  project: string;
  repository: string;
}

/**
 * The organization, project and repository an Azure DevOps `origin` names, in
 * its three forms: `https://dev.azure.com/<org>/<project>/_git/<repo>`,
 * `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` and
 * `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`.
 */
export function azureRepositoryFromRemote(origin: string): AzureRepository {
  const remote = origin.trim();
  const decode = (parts: string[]) => parts.map((part) => decodeURIComponent(part));
  const ssh = remote.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/);
  if (ssh) {
    const [organization, project, repository] = decode(ssh.slice(1));
    return { organization: organization!, project: project!, repository: repository! };
  }
  const devAzure = remote.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/);
  if (devAzure) {
    const [organization, project, repository] = decode(devAzure.slice(1));
    return { organization: organization!, project: project!, repository: repository! };
  }
  const visualStudio = remote.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/);
  if (visualStudio) {
    const [organization, project, repository] = decode(visualStudio.slice(1));
    return { organization: organization!, project: project!, repository: repository! };
  }
  throw new Error(`El remote origin ${remote} no nombra un repositorio Azure DevOps`);
}

/** The organization name a `LAZY_WORKFLOW_AZURE_ORGANIZATION` URL points at. */
function organizationName(organizationUrl: string): string {
  const url = new URL(organizationUrl);
  return url.hostname.endsWith(".visualstudio.com")
    ? url.hostname.slice(0, -".visualstudio.com".length)
    : decodeURIComponent(url.pathname.split("/").find(Boolean) ?? "");
}

const VOTES: Record<number, ReviewState> = {
  10: "approved",
  5: "approved-with-suggestions",
  0: "pending",
  [-5]: "changes-requested",
  [-10]: "rejected",
};

const PULL_REQUEST_STATUS: Record<string, PullRequestDetail["status"]> = {
  active: "open",
  completed: "merged",
  abandoned: "closed",
};

/** Every other thread status — active, pending, unknown — still waits on someone. */
const RESOLVED_THREAD_STATUS = new Set(["fixed", "wontFix", "closed", "byDesign"]);

interface AzurePullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  creationDate: string;
  sourceRefName: string;
  targetRefName: string;
  createdBy?: { displayName?: string; uniqueName?: string };
  reviewers?: Array<{ displayName?: string; uniqueName?: string; vote?: number; isRequired?: boolean }>;
}

interface AzureThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  threadContext?: { filePath?: string; rightFileStart?: { line?: number }; leftFileStart?: { line?: number } } | null;
  comments?: Array<{
    id: number;
    content?: string;
    publishedDate: string;
    commentType?: string;
    isDeleted?: boolean;
    author?: { displayName?: string; uniqueName?: string };
  }>;
}

const identity = (person?: { displayName?: string; uniqueName?: string }): string =>
  person?.displayName ?? person?.uniqueName ?? "";

const shortRef = (ref: string): string => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);

export class AzurePullRequests implements PullRequestTools {
  readonly tracker = "azure";
  private readonly repository: AzureRepository;

  constructor(private readonly az: AzRunner, origin: string, private readonly organization = azureOrganization()) {
    this.repository = azureRepositoryFromRemote(origin);
    const declared = organizationName(organization);
    if (declared.toLowerCase() !== this.repository.organization.toLowerCase()) {
      throw new Error(
        `El remote origin pertenece a la organización ${this.repository.organization}, ` +
        `no a la de LAZY_WORKFLOW_AZURE_ORGANIZATION (${declared})`,
      );
    }
  }

  private get base(): string {
    const { project, repository } = this.repository;
    return `${this.organization}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`;
  }

  private async rest<T>(method: "get" | "post", path: string, body?: unknown): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    return JSON.parse(await this.az([
      "rest", "--resource", AZURE_DEVOPS_RESOURCE, "--method", method,
      "--uri", `${this.base}/${path}${separator}api-version=${API_VERSION}`,
      ...(body === undefined ? [] : ["--headers", "Content-Type=application/json", "--body", JSON.stringify(body)]),
      "--output", "json",
    ])) as T;
  }

  private url(id: number): string {
    const { project, repository } = this.repository;
    return `${this.organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${id}`;
  }

  private summary(pr: AzurePullRequest): PullRequestSummary {
    return {
      id: pr.pullRequestId,
      title: pr.title,
      author: identity(pr.createdBy),
      source: shortRef(pr.sourceRefName),
      target: shortRef(pr.targetRefName),
      draft: pr.isDraft === true,
      createdAt: pr.creationDate,
      url: this.url(pr.pullRequestId),
    };
  }

  async list(): Promise<PullRequestSummary[]> {
    const { value } = await this.rest<{ value: AzurePullRequest[] }>("get", "pullrequests?searchCriteria.status=active&$top=100");
    return value.map((pr) => this.summary(pr));
  }

  async read(id: number): Promise<PullRequestDetail> {
    const pr = await this.rest<AzurePullRequest>("get", `pullrequests/${id}`);
    return {
      ...this.summary(pr),
      status: PULL_REQUEST_STATUS[pr.status] ?? "open",
      description: pr.description ?? "",
      reviewers: (pr.reviewers ?? []).map((reviewer) => ({
        name: identity(reviewer),
        state: VOTES[reviewer.vote ?? 0] ?? "pending",
        required: reviewer.isRequired === true,
      })),
    };
  }

  /**
   * Azure records every vote, push and status change as a system comment in a
   * thread of its own. Those are history, not discussion, so only what a person
   * wrote is listed, and a thread left with nothing is dropped.
   */
  async threads(id: number): Promise<PullRequestThread[]> {
    const { value } = await this.rest<{ value: AzureThread[] }>("get", `pullRequests/${id}/threads`);
    return value
      .filter((thread) => !thread.isDeleted)
      .map((thread) => ({
        id: `${thread.id}`,
        status: RESOLVED_THREAD_STATUS.has(thread.status ?? "") ? "resolved" as const : "active" as const,
        path: thread.threadContext?.filePath ?? null,
        line: thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line ?? null,
        comments: (thread.comments ?? [])
          .filter((comment) => comment.commentType !== "system" && !comment.isDeleted)
          .map((comment) => ({
            id: `${comment.id}`,
            author: identity(comment.author),
            body: comment.content ?? "",
            createdAt: comment.publishedDate,
          })),
      }))
      .filter((thread) => thread.comments.length > 0);
  }

  async reply(id: number, thread: string, body: string): Promise<{ comment: string }> {
    if (!/^\d+$/.test(thread)) throw new Error(`Un hilo de Azure DevOps es un entero: ${thread}`);
    const comment = await this.rest<{ id?: number }>("post", `pullRequests/${id}/threads/${thread}/comments`, {
      content: body,
      commentType: 1,
    });
    if (typeof comment.id !== "number") throw new Error(`Azure no devolvió la respuesta publicada en el hilo ${thread}`);
    return { comment: `${comment.id}` };
  }

  async create(draft: PullRequestDraft): Promise<{ id: number; url: string }> {
    if (draft.description.length > AZURE_DESCRIPTION_LIMIT) {
      throw new Error(`Azure DevOps acepta descripciones de hasta ${AZURE_DESCRIPTION_LIMIT} caracteres; esta tiene ${draft.description.length}`);
    }
    const pr = await this.rest<{ pullRequestId?: number }>("post", "pullrequests", {
      sourceRefName: `refs/heads/${draft.source}`,
      targetRefName: `refs/heads/${draft.target}`,
      title: draft.title,
      description: draft.description,
    });
    if (typeof pr.pullRequestId !== "number") throw new Error("Azure no devolvió el PR creado");
    return { id: pr.pullRequestId, url: this.url(pr.pullRequestId) };
  }
}
