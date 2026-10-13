import { runGh, type GhRunner } from "./managed-queue-service.ts";

/**
 * An issue and its native relations. `repository` (`owner/name`) is absent when
 * GitHub answers for the repository being read: a sub-issue may live in another
 * repository than its parent (ADR-0049), so an issue is its number *and* where.
 */
export interface GitHubNativeIssueRelation {
  number: number;
  title: string;
  state: string;
  repository?: string;
  parent: { number: number; repository?: string } | null;
  subIssues: GitHubNativeIssueRelation[];
  blockedBy: Array<{ number: number; state: string }>;
}

interface RepositoryParts {
  owner: string;
  name: string;
}

const nameOf = (repository: RepositoryParts): string => `${repository.owner}/${repository.name}`;

function partsOf(nameWithOwner: string): RepositoryParts {
  if (!/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)) throw new Error(`GitHub devolvio un repositorio no verificable: ${nameWithOwner}`);
  const [owner, name] = nameWithOwner.split("/");
  return { owner: owner!, name: name! };
}

/** Where a relation points: its own repository, or the one being read when GitHub did not say. */
const repositoryOf = (relation: { repository?: string } | null | undefined, reading: RepositoryParts): string =>
  relation?.repository ?? nameOf(reading);

/** `#12` within the repository of the parent, `owner/name#12` anywhere else. */
const reference = (number: number, repository: string, home: string): string =>
  repository === home ? `#${number}` : `${repository}#${number}`;

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
  "{repository(owner:$owner,name:$name){issue(number:$number){number title state parent{number repository{nameWithOwner}} subIssues(first:100,after:$endCursor){nodes{number title state repository{nameWithOwner} parent{number repository{nameWithOwner}}} pageInfo{hasNextPage endCursor}}}}}",
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

function repositoryParts(output: string): RepositoryParts {
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

function pageInfo(connection: PageInfo | undefined): PageInfo {
  if (!connection || typeof connection.hasNextPage !== "boolean") {
    throw new Error("la respuesta GitHub no incluye paginación verificable");
  }
  return connection;
}

function requireCompletePagination(last: PageInfo | undefined): void {
  if (last?.hasNextPage !== false) throw new Error("GitHub devolvio una relación sin paginación completa");
}

type RawRelation = { number: number; repository?: { nameWithOwner?: string } | string };

/** GraphQL nests `repository { nameWithOwner }`; the relation keeps the name alone. */
function flatRepository<T extends RawRelation>(relation: T | null | undefined): (Omit<T, "repository"> & { repository?: string }) | null {
  if (!relation) return null;
  const { repository, ...rest } = relation;
  const name = typeof repository === "string" ? repository : repository?.nameWithOwner;
  return name ? { ...rest, repository: name } : rest;
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
    lastPage = pageInfo(current.subIssues.pageInfo);
    if (!Array.isArray(current.subIssues.nodes)) throw new Error(`GitHub devolvio sub-issues incompletos para el Issue #${issue}`);
    subIssues.push(...current.subIssues.nodes.map((node) => ({
      ...flatRepository(node as GitHubNativeIssueRelation & RawRelation)!,
      parent: flatRepository(node.parent as RawRelation | null),
    }) as GitHubNativeIssueRelation));
  }
  requireCompletePagination(lastPage);
  return {
    number: issue,
    title: first.title,
    state: first.state,
    parent: flatRepository(first.parent as RawRelation | null),
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
    lastPage = pageInfo(connection.pageInfo);
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
    lastPage = pageInfo(connection.pageInfo);
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

  private async repository(workingDirectory: string): Promise<RepositoryParts> {
    return repositoryParts(await this.gh(["repo", "view", "--json", "nameWithOwner"], workingDirectory));
  }

  private async readIssue(
    issue: number,
    repository: RepositoryParts,
    workingDirectory: string,
  ): Promise<GitHubNativeIssueRelation> {
    const issuePages = parsePages(await this.gh(graphQlArgs(ISSUE_QUERY, repository, issue), workingDirectory));
    const result = issueFromPages(issuePages, issue);
    const blockerPages = parsePages(await this.gh(graphQlArgs(BLOCKER_QUERY, repository, issue), workingDirectory));
    return { ...result, blockedBy: blockersFromPages(blockerPages, issue) };
  }

  private async comments(
    issue: number,
    repository: RepositoryParts,
    workingDirectory: string,
  ): Promise<string[]> {
    const pages = parsePages(await this.gh(graphQlArgs(COMMENT_QUERY, repository, issue), workingDirectory));
    const comments: string[] = [];
    let lastPage: PageInfo | undefined;
    for (const page of pages) {
      const connection = page.data?.repository?.issue?.comments as { nodes?: Array<{ body?: string }>; pageInfo?: PageInfo } | undefined;
      if (!connection) throw new Error(`GitHub devolvio comentarios incompletos para el Issue #${issue}`);
      lastPage = pageInfo(connection.pageInfo);
      if (!Array.isArray(connection.nodes)) throw new Error(`GitHub devolvio comentarios incompletos para el Issue #${issue}`);
      comments.push(...connection.nodes.map(({ body }) => body ?? ""));
    }
    requireCompletePagination(lastPage);
    return comments;
  }

  private async openIssues(
    repository: RepositoryParts,
    workingDirectory: string,
  ): Promise<number[]> {
    const pages = parsePages(await this.gh(graphQlArgs(OPEN_ISSUES_QUERY, repository), workingDirectory));
    return issueNumbersFromPages(pages);
  }

  /**
   * Closes `parent` once every direct sub-issue and dependency is closed, then
   * walks up. A parent in another repository than the one the run works in is
   * written with `-R`; one in the same repository is written exactly as before.
   */
  private async reconcileParent(
    parent: GitHubNativeIssueRelation,
    repository: RepositoryParts,
    home: RepositoryParts,
    workingDirectory: string,
    path: Set<string>,
    expectedChild: { number: number; repository: string } | null,
  ): Promise<void> {
    const where = nameOf(repository);
    const key = `${where}#${parent.number}`;
    if (path.has(key)) throw new Error(`La jerarquía GitHub contiene un ciclo en el Issue ${reference(parent.number, where, nameOf(home))}`);
    path.add(key);

    if (expectedChild !== null && !parent.subIssues.some((child) =>
      child.number === expectedChild.number && repositoryOf(child, repository) === expectedChild.repository
    )) {
      throw new Error(`La jerarquía nativa del Issue #${parent.number} es ambigua`);
    }

    const target = where === nameOf(home) ? [] : ["-R", where];
    if (parent.state === "OPEN") {
      if (parent.subIssues.length === 0) return;
      const children = new Set<string>();
      for (const child of parent.subIssues) {
        const childKey = reference(child.number, repositoryOf(child, repository), where);
        if (children.has(childKey) || child.parent?.number !== parent.number || repositoryOf(child.parent, repository) !== where) {
          throw new Error(`La jerarquía nativa del Issue #${parent.number} es ambigua`);
        }
        children.add(childKey);
        if (child.state !== "CLOSED") return;
      }
      if (parent.blockedBy.some(({ state }) => state !== "CLOSED")) return;

      const marker = `lazy-workflow: verified direct sub-issues for parent #${parent.number}: ${[...children].join(", ")}`;
      if (!(await this.comments(parent.number, repository, workingDirectory)).some((comment) => comment.includes(marker))) {
        await this.gh(["issue", "comment", `${parent.number}`, ...target, "--body", marker], workingDirectory);
      }
      await this.gh(["issue", "close", `${parent.number}`, ...target], workingDirectory);
      const verified = await this.readIssue(parent.number, repository, workingDirectory);
      if (verified.state !== "CLOSED") throw new Error(`El Issue padre #${parent.number} no quedó cerrado`);
      parent = verified;
    } else if (parent.state !== "CLOSED") {
      throw new Error(`El estado del Issue padre #${parent.number} no es verificable`);
    }

    if (parent.parent) {
      const above = partsOf(repositoryOf(parent.parent, repository));
      await this.reconcileParent(await this.readIssue(parent.parent.number, above, workingDirectory), above, home, workingDirectory, path, { number: parent.number, repository: where });
    }
  }

  async reconcileParents(issue: number, workingDirectory: string): Promise<void> {
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("El issue para reconciliar no es válido");
    const home = await this.repository(workingDirectory);
    const current = await this.readIssue(issue, home, workingDirectory);
    if (current.parent) {
      const above = partsOf(repositoryOf(current.parent, home));
      await this.reconcileParent(await this.readIssue(current.parent.number, above, workingDirectory), above, home, workingDirectory, new Set(), { number: current.number, repository: nameOf(home) });
    }
  }

  async reconcileOpenParents(workingDirectory: string): Promise<void> {
    const home = await this.repository(workingDirectory);
    for (const issue of await this.openIssues(home, workingDirectory)) {
      const current = await this.readIssue(issue, home, workingDirectory);
      if (current.subIssues.length > 0) {
        await this.reconcileParent(current, home, home, workingDirectory, new Set(), null);
      } else if (current.parent) {
        const above = partsOf(repositoryOf(current.parent, home));
        await this.reconcileParent(await this.readIssue(current.parent.number, above, workingDirectory), above, home, workingDirectory, new Set(), { number: current.number, repository: nameOf(home) });
      }
    }
  }
}
