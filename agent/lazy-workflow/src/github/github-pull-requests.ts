import type { GhRunner } from "./managed-queue-service.ts";
import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestDraft,
  PullRequestReviewer,
  PullRequestSummary,
  PullRequestThread,
  PullRequestTools,
  ReviewState,
} from "../pull-request/pull-request-tools.ts";

/**
 * GitHub keeps a pull request's general discussion apart from its review
 * threads, where Azure makes both threads. It is offered as one thread under
 * this id so a reply reaches it the way it reaches any other.
 */
export const CONVERSATION_THREAD = "conversation";

const SUMMARY_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,createdAt,url";

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
};

const PULL_REQUEST_STATUS: Record<string, PullRequestDetail["status"]> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};

const COMMENT_FIELDS = "totalCount nodes{id author{login} body createdAt}";
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100){${COMMENT_FIELDS}} reviewThreads(first:100){totalCount nodes{id isResolved path line comments(first:100){${COMMENT_FIELDS}}}}}}}`;
const THREAD_OWNER_QUERY = "query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{number}}}}";
const REPLY_MUTATION = "mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}";

interface GhPullRequest {
  number: number;
  title: string;
  author: { login?: string } | null;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  createdAt: string;
  url: string;
}

interface GhComments {
  totalCount: number;
  nodes: Array<{ id: string; author: { login?: string } | null; body: string; createdAt: string }>;
}

const login = (author: { login?: string } | null): string => author?.login ?? "ghost";

function summary(pr: GhPullRequest): PullRequestSummary {
  return {
    id: pr.number,
    title: pr.title,
    author: login(pr.author),
    source: pr.headRefName,
    target: pr.baseRefName,
    draft: pr.isDraft,
    createdAt: pr.createdAt,
    url: pr.url,
  };
}

/** A page GitHub cut short would read as a thread with nothing more to answer, so it fails instead. */
function comments(page: GhComments, owner: string): PullRequestComment[] {
  if (page.totalCount > page.nodes.length) throw new Error(`${owner} tiene más de ${page.nodes.length} comentarios`);
  return page.nodes.map((node) => ({ id: node.id, author: login(node.author), body: node.body, createdAt: node.createdAt }));
}

export class GitHubPullRequests implements PullRequestTools {
  readonly tracker = "github";

  constructor(private readonly gh: GhRunner, private readonly workingDirectory: string) {}

  private async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.gh(args, this.workingDirectory)) as T;
  }

  async list(): Promise<PullRequestSummary[]> {
    const prs = await this.json<GhPullRequest[]>(["pr", "list", "--state", "open", "--limit", "100", "--json", SUMMARY_FIELDS]);
    return prs.map(summary);
  }

  async read(id: number): Promise<PullRequestDetail> {
    const pr = await this.json<GhPullRequest & {
      state: string;
      body: string;
      latestReviews: Array<{ author: { login?: string } | null; state: string }>;
      reviewRequests: Array<{ login?: string; name?: string; slug?: string }>;
    }>(["pr", "view", `${id}`, "--json", `${SUMMARY_FIELDS},state,body,latestReviews,reviewRequests`]);

    const reviewers: PullRequestReviewer[] = pr.latestReviews.map((review) => ({
      name: login(review.author),
      state: REVIEW_STATES[review.state] ?? "pending",
      required: false,
    }));
    // Pedir de nuevo una revisión ya hecha la deja pendiente: el pedido manda.
    for (const request of pr.reviewRequests) {
      const name = request.login ?? request.slug ?? request.name ?? "";
      const existing = reviewers.find((reviewer) => reviewer.name === name);
      if (existing) existing.state = "pending";
      else reviewers.push({ name, state: "pending", required: false });
    }
    return {
      ...summary(pr),
      status: PULL_REQUEST_STATUS[pr.state] ?? "open",
      description: pr.body,
      reviewers,
    };
  }

  async threads(id: number): Promise<PullRequestThread[]> {
    const response = await this.json<{
      data?: { repository?: { pullRequest?: {
        comments: GhComments;
        reviewThreads: {
          totalCount: number;
          nodes: Array<{ id: string; isResolved: boolean; path: string | null; line: number | null; comments: GhComments }>;
        };
      } | null } };
    }>(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${id}`, "-f", `query=${THREADS_QUERY}`]);

    const pullRequest = response.data?.repository?.pullRequest;
    if (!pullRequest) throw new Error(`El PR #${id} no existe en el repositorio`);
    const { reviewThreads } = pullRequest;
    if (reviewThreads.totalCount > reviewThreads.nodes.length) {
      throw new Error(`El PR #${id} tiene más de ${reviewThreads.nodes.length} hilos de revisión`);
    }

    const conversation = comments(pullRequest.comments, `La conversación del PR #${id}`);
    return [
      ...(conversation.length > 0
        ? [{ id: CONVERSATION_THREAD, status: "active" as const, path: null, line: null, comments: conversation }]
        : []),
      ...reviewThreads.nodes.map((thread) => ({
        id: thread.id,
        status: thread.isResolved ? "resolved" as const : "active" as const,
        path: thread.path,
        line: thread.line,
        comments: comments(thread.comments, `El hilo ${thread.id}`),
      })),
    ];
  }

  async reply(id: number, thread: string, body: string): Promise<{ comment: string }> {
    if (thread === CONVERSATION_THREAD) {
      const url = (await this.gh(["pr", "comment", `${id}`, "--body", body], this.workingDirectory)).trim();
      const comment = url.match(/#issuecomment-(\d+)$/)?.[1];
      if (!comment) throw new Error("gh pr comment no devolvió un comentario verificable");
      return { comment };
    }

    // La mutación solo nombra el hilo: sin esta lectura, un id de otro PR recibiría la respuesta.
    const owner = await this.json<{ data?: { node?: { pullRequest?: { number?: number } } | null } }>(
      ["api", "graphql", "-f", `query=${THREAD_OWNER_QUERY}`, "-f", `id=${thread}`],
    );
    const number = owner.data?.node?.pullRequest?.number;
    if (number !== id) throw new Error(`El hilo ${thread} no pertenece al PR #${id}`);

    const reply = await this.json<{ data?: { addPullRequestReviewThreadReply?: { comment?: { id?: string } } } }>(
      ["api", "graphql", "-f", `query=${REPLY_MUTATION}`, "-f", `thread=${thread}`, "-f", `body=${body}`],
    );
    const comment = reply.data?.addPullRequestReviewThreadReply?.comment?.id;
    if (!comment) throw new Error(`GitHub no devolvió la respuesta publicada en el hilo ${thread}`);
    return { comment };
  }

  async create(draft: PullRequestDraft): Promise<{ id: number; url: string }> {
    const output = await this.gh([
      "pr", "create",
      "--head", draft.source,
      "--base", draft.target,
      "--title", draft.title,
      "--body", draft.description,
    ], this.workingDirectory);
    const url = output.trim().split(/\s+/).find((word) => /\/pull\/\d+$/.test(word));
    if (!url) throw new Error("gh pr create no devolvió un PR verificable");
    return { id: Number(url.slice(url.lastIndexOf("/") + 1)), url };
  }
}
