/**
 * The pull requests of a repository, read and written the same way whichever
 * tracker hosts them: what `yp pr` does for Azure DevOps, over GitHub too.
 *
 * Each tracker answers in its own vocabulary — Azure votes 10 or -5, GitHub
 * reviews APPROVED or CHANGES_REQUESTED; Azure PRs are `completed`, GitHub ones
 * `MERGED` — so the adapters translate into the one below, and an agent reading
 * the JSON never has to know which tracker it came from to act on it.
 *
 * Nothing here writes a description: `pr-create` takes it from whoever calls,
 * an operator or an agent, because a deterministic tool calls no model
 * (ADR-0026).
 */

export type PullRequestTracker = "github" | "azure";

export type ReviewState =
  | "approved"
  | "approved-with-suggestions"
  | "changes-requested"
  | "rejected"
  | "commented"
  | "pending";

export interface PullRequestSummary {
  id: number;
  title: string;
  author: string;
  /** Short branch names, never `refs/heads/…`. */
  source: string;
  target: string;
  draft: boolean;
  createdAt: string;
  url: string;
}

export interface PullRequestReviewer {
  name: string;
  state: ReviewState;
  required: boolean;
}

export interface PullRequestDetail extends PullRequestSummary {
  status: "open" | "merged" | "closed";
  description: string;
  reviewers: PullRequestReviewer[];
}

export interface PullRequestComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface PullRequestThread {
  /** What `pr-thread-reply --thread` takes. */
  id: string;
  status: "active" | "resolved";
  /** The file and line a code comment is anchored to; null for the general discussion. */
  path: string | null;
  line: number | null;
  comments: PullRequestComment[];
}

export interface PullRequestDraft {
  source: string;
  target: string;
  title: string;
  description: string;
}

/** One repository's pull requests, bound to the tracker its `origin` names. */
export interface PullRequestTools {
  readonly tracker: PullRequestTracker;
  /** The open pull requests. */
  list(): Promise<PullRequestSummary[]>;
  read(id: number): Promise<PullRequestDetail>;
  threads(id: number): Promise<PullRequestThread[]>;
  /** Answers with the id of the comment it posted. */
  reply(id: number, thread: string, body: string): Promise<{ comment: string }>;
  create(draft: PullRequestDraft): Promise<{ id: number; url: string }>;
}

export function isAzureRemote(origin: string): boolean {
  const trimmed = origin.trim();
  return /^https:\/\/(?:[^@\/]+@)?dev\.azure\.com\/|^git@ssh\.dev\.azure\.com:|^https?:\/\/[^\/]*\.visualstudio\.com\//.test(trimmed);
}

export function isGitHubRemote(origin: string): boolean {
  return /^https:\/\/(?:[^@\/]+@)?github\.com\/|^git@github\.com:|^ssh:\/\/git@github\.com\//.test(origin.trim());
}
