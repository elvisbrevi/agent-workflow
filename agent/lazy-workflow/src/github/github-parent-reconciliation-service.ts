import { runGh, type GhRunner } from "./managed-queue-service.ts";

export interface GitHubNativeIssueRelation {
  number: number;
  title: string;
  state: string;
  parent: { number: number } | null;
  subIssues: GitHubNativeIssueRelation[];
  blockedBy: Array<{ number: number; state: string }>;
}

export interface GitHubParentReconciliationAdapter {
  reconcileParents(issue: number, workingDirectory: string): Promise<void>;
  reconcileOpenParents(workingDirectory: string): Promise<void>;
}

interface GraphQlPage {
  data?: {
    repository?: {
      issue?: GitHubNativeIssueRelation & {
        subIssues?: { nodes?: GitHubNativeIssueRelation[]; pageInfo?: PageInfo };
        blockedBy?: { nodes?: Array<{ number: number; state: string }>; pageInfo?: PageInfo };
        comments?: { nodes?: Array<{ body?: string }>; pageInfo?: PageInfo };
      };
      issues?: { nodes?: Array<{ number?: number }>; pageInfo?: PageInfo };
    };
  };
  errors?: Array<{ message?: string }>;
}

interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

const ISSUE_QUERY = [
  "query($owner:String!,$name:String!,$number:Int!,$endCursor:String)",
  "{repository(owner:$owner,name:$name){issue(number:$number){number title state parent{number} subIssues(first:100,after:$endCursor){nodes{number title state parent{number}} pageInfo{hasNextPage endCursor}}}}}",
].join("");

const BLOCKER_QUERY = [
  "query($owner:String!,$name:String!,$number:Int!,$endCursor:String)",
  "{repository(owner:$owner,name:$name){issue(number:$number){blockedBy(first:100,after:$endCursor){nodes{number state} pageInfo{hasNextPage endCursor}}}}}",
].join("");

const COMMENT_QUERY = [
  "query($owner:String!,$name:String!,$number:Int!,$endCursor:String)",
  "{repository(owner:$owner,name:$name){issue(number:$number){comments(first:100,after:$endCursor){nodes{body} pageInfo{hasNextPage endCursor}}}}}",
].join("");

const OPEN_ISSUES_QUERY = [
  "query($owner:String!,$name:String!,$endCursor:String)",
  "{repository(owner:$owner,name:$name){issues(states:OPEN,first:100,after:$endCursor){nodes{number} pageInfo{hasNextPage endCursor}}}}",
].join("");

function parsePages(output: string): GraphQlPage[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error("gh api graphql devolvio JSON inválido", { cause: error });
  }
  const pages = Array.isArray(value) ? value : [value];
  if (pages.length === 0 || pages.some((page) => typeof page !== "object" || page === null)) {
    throw new Error("gh api graphql devolvio una respuesta vacía");
  }
  for (const page of pages as GraphQlPage[]) {
    if (page.errors?.length) {
      throw new Error(page.errors.map(({ message }) => message ?? "error GraphQL").join(", "));
    }
  }
  return pages as GraphQlPage[];
}

function repositoryParts(output: string): { owner: string; name: string } {
  let value: { nameWithOwner?: unknown };
  try {
    value = JSON.parse(output) as { nameWithOwner?: unknown };
  } catch (error) {
    throw new Error("gh repo view devolvio JSON inválido", { cause: error });
  }
  if (typeof value.nameWithOwner !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value.nameWithOwner)) {
    throw new Error("gh repo view no devolvio un repositorio verificable");
  }
  const [owner, name] = value.nameWithOwner.split("/");
  return { owner: owner!, name: name! };
}

function graphQlArgs(query: string, repository: { owner: string; name: string }, number?: number): string[] {
  const args = [
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${repository.owner}`,
    "-F",
    `name=${repository.name}`,
  ];
  if (number !== undefined) args.push("-F", `number=${number}`);
  return args;
}

function pageInfo(page: GraphQlPage, connection: PageInfo | undefined): PageInfo {
  if (!connection || typeof connection.hasNextPage !== "boolean") {
    throw new Error("la respuesta GitHub no incluye paginación verificable");
  }
  return connection;
}

function requireCompletePagination(last: PageInfo | undefined): void {
  if (last?.hasNextPage !== false) throw new Error("GitHub devolvio una relación sin paginación completa");
}

function issueFromPages(pages: GraphQlPage[], issue: number): GitHubNativeIssueRelation {
  const first = pages[0]?.data?.repository?.issue;
  if (!first || first.number !== issue || typeof first.title !== "string" || typeof first.state !== "string") {
    throw new Error(`GitHub no devolvio el Issue #${issue}`);
  }
  const subIssues: GitHubNativeIssueRelation[] = [];
  let lastPage: PageInfo | undefined;
  for (const page of pages) {
    const current = page.data?.repository?.issue;
    if (!current || current.number !== issue || !current.subIssues) throw new Error(`GitHub devolvio una relación incompleta para el Issue #${issue}`);
    lastPage = pageInfo(page, current.subIssues.pageInfo);
    if (!Array.isArray(current.subIssues.nodes)) throw new Error(`GitHub devolvio sub-issues incompletos para el Issue #${issue}`);
    subIssues.push(...current.subIssues.nodes);
  }
  requireCompletePagination(lastPage);
  return {
    number: issue,
    title: first.title,
    state: first.state,
    parent: first.parent ?? null,
    subIssues,
    blockedBy: [],
  };
}

function blockersFromPages(pages: GraphQlPage[], issue: number): Array<{ number: number; state: string }> {
  const blockers: Array<{ number: number; state: string }> = [];
  let lastPage: PageInfo | undefined;
  for (const page of pages) {
    const connection = page.data?.repository?.issue?.blockedBy;
    if (!connection) throw new Error(`GitHub devolvio dependencias incompletas para el Issue #${issue}`);
    lastPage = pageInfo(page, connection.pageInfo);
    if (!Array.isArray(connection.nodes)) throw new Error(`GitHub devolvio dependencias incompletas para el Issue #${issue}`);
    blockers.push(...connection.nodes);
  }
  requireCompletePagination(lastPage);
  return blockers;
}

function issueNumbersFromPages(pages: GraphQlPage[]): number[] {
  const numbers: number[] = [];
  let lastPage: PageInfo | undefined;
  for (const page of pages) {
    const connection = page.data?.repository?.issues;
    if (!connection) throw new Error("GitHub devolvio una cola de issues incompleta");
    lastPage = pageInfo(page, connection.pageInfo);
    if (!Array.isArray(connection.nodes)) throw new Error("GitHub devolvio una cola de issues incompleta");
    for (const node of connection.nodes) {
      if (!Number.isInteger(node.number) || (node.number ?? 0) <= 0) throw new Error("GitHub devolvio un issue inválido");
      numbers.push(node.number!);
    }
  }
  requireCompletePagination(lastPage);
  return numbers;
}

export class GitHubParentReconciliationService implements GitHubParentReconciliationAdapter {
  constructor(private readonly gh: GhRunner = runGh) {}

  private async repository(workingDirectory: string): Promise<{ owner: string; name: string }> {
    return repositoryParts(await this.gh(["repo", "view", "--json", "nameWithOwner"], workingDirectory));
  }

  private async readIssue(
    issue: number,
    repository: { owner: string; name: string },
    workingDirectory: string,
  ): Promise<GitHubNativeIssueRelation> {
    const issuePages = parsePages(await this.gh(graphQlArgs(ISSUE_QUERY, repository, issue), workingDirectory));
    const result = issueFromPages(issuePages, issue);
    const blockerPages = parsePages(await this.gh(graphQlArgs(BLOCKER_QUERY, repository, issue), workingDirectory));
    return { ...result, blockedBy: blockersFromPages(blockerPages, issue) };
  }

  private async comments(
    issue: number,
    repository: { owner: string; name: string },
    workingDirectory: string,
  ): Promise<string[]> {
    const pages = parsePages(await this.gh(graphQlArgs(COMMENT_QUERY, repository, issue), workingDirectory));
    const comments: string[] = [];
    let lastPage: PageInfo | undefined;
    for (const page of pages) {
      const connection = page.data?.repository?.issue?.comments as { nodes?: Array<{ body?: string }>; pageInfo?: PageInfo } | undefined;
      if (!connection) throw new Error(`GitHub devolvio comentarios incompletos para el Issue #${issue}`);
      lastPage = pageInfo(page, connection.pageInfo);
      if (!Array.isArray(connection.nodes)) throw new Error(`GitHub devolvio comentarios incompletos para el Issue #${issue}`);
      comments.push(...connection.nodes.map(({ body }) => body ?? ""));
    }
    requireCompletePagination(lastPage);
    return comments;
  }

  private async openIssues(
    repository: { owner: string; name: string },
    workingDirectory: string,
  ): Promise<number[]> {
    const pages = parsePages(await this.gh(graphQlArgs(OPEN_ISSUES_QUERY, repository), workingDirectory));
    return issueNumbersFromPages(pages);
  }

  private async reconcileParent(
    parent: GitHubNativeIssueRelation,
    repository: { owner: string; name: string },
    workingDirectory: string,
    path: Set<number>,
  ): Promise<void> {
    if (path.has(parent.number)) throw new Error(`La jerarquía GitHub contiene un ciclo en el Issue #${parent.number}`);
    path.add(parent.number);

    if (parent.state === "OPEN") {
      if (parent.subIssues.length === 0) return;
      const childNumbers = new Set<number>();
      for (const child of parent.subIssues) {
        if (childNumbers.has(child.number) || child.parent?.number !== parent.number) {
          throw new Error(`La jerarquía nativa del Issue #${parent.number} es ambigua`);
        }
        childNumbers.add(child.number);
        if (child.state !== "CLOSED") return;
      }
      if (parent.blockedBy.some(({ state }) => state !== "CLOSED")) return;

      const marker = `lazy-workflow: verified direct sub-issues for parent #${parent.number}: ${[...childNumbers].map((number) => `#${number}`).join(", ")}`;
      if (!(await this.comments(parent.number, repository, workingDirectory)).some((comment) => comment.includes(marker))) {
        await this.gh(["issue", "comment", `${parent.number}`, "--body", marker], workingDirectory);
      }
      await this.gh(["issue", "close", `${parent.number}`], workingDirectory);
      const verified = await this.readIssue(parent.number, repository, workingDirectory);
      if (verified.state !== "CLOSED") throw new Error(`El Issue padre #${parent.number} no quedó cerrado`);
      parent = verified;
    } else if (parent.state !== "CLOSED") {
      throw new Error(`El estado del Issue padre #${parent.number} no es verificable`);
    }

    if (parent.parent) {
      await this.reconcileParent(await this.readIssue(parent.parent.number, repository, workingDirectory), repository, workingDirectory, path);
    }
  }

  async reconcileParents(issue: number, workingDirectory: string): Promise<void> {
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("El issue para reconciliar no es válido");
    const repository = await this.repository(workingDirectory);
    const current = await this.readIssue(issue, repository, workingDirectory);
    if (current.parent) {
      await this.reconcileParent(await this.readIssue(current.parent.number, repository, workingDirectory), repository, workingDirectory, new Set());
    }
  }

  async reconcileOpenParents(workingDirectory: string): Promise<void> {
    const repository = await this.repository(workingDirectory);
    for (const issue of await this.openIssues(repository, workingDirectory)) {
      const current = await this.readIssue(issue, repository, workingDirectory);
      if (current.subIssues.length > 0) {
        await this.reconcileParent(current, repository, workingDirectory, new Set());
      } else if (current.parent) {
        await this.reconcileParent(await this.readIssue(current.parent.number, repository, workingDirectory), repository, workingDirectory, new Set());
      }
    }
  }
}
