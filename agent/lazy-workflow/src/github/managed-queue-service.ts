export type GhRunner = (args: string[], workingDirectory: string) => Promise<string>;

export interface ManagedIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name?: string }>;
  assignees: Array<{ login?: string }>;
  createdAt: string;
  blockedBy: { nodes: Array<{ number: number; state: string }> };
}

export interface SelectedManagedIssue extends ManagedIssue {
  body: string;
  comments: string[];
}

export type ManagedQueueReason =
  | "epic-or-spec"
  | "closed"
  | "assigned"
  | "has-blocker"
  | "wrong-label";

export interface ManagedQueueBlockEntry {
  number: number;
  title: string;
  reasons: ManagedQueueReason[];
}

export interface ManagedQueueClassification {
  managed: ManagedIssue[];
  eligible: ManagedIssue[];
  blocked: ManagedQueueBlockEntry[];
}

export type ManagedQueueOutcome =
  | { kind: "empty" }
  | { kind: "blocked"; reasons: ManagedQueueBlockEntry[] }
  | { kind: "selected"; issue: SelectedManagedIssue; repository: GitHubRepositoryContext };

export type ManagedQueueSelection =
  | { kind: "empty" }
  | { kind: "blocked"; reasons: ManagedQueueBlockEntry[] }
  | { kind: "candidate"; issue: ManagedIssue; repository: GitHubRepositoryContext };

export interface GitHubRepositoryContext {
  nameWithOwner: string;
}

export interface GitHubAuthenticatedIdentity {
  login: string;
}

const READY_FOR_AGENT_LABEL = "ready-for-agent";
const EPIC_TITLE_PREFIXES = ["[Epic]", "[Spec]"];
const ADD_ASSIGNEE_FLAG = "--add-assignee";
const REMOVE_ASSIGNEE_FLAG = "--remove-assignee";
const ME_HANDLE = "@me";

export const runGh: GhRunner = async (args, workingDirectory) => {
  const child = Bun.spawn(["gh", ...args], { cwd: workingDirectory, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`gh ${args[0] ?? "command"} fallo (${stderr.trim() || `exit ${exitCode}`})`);
  return stdout;
};

function labelNames(issue: Pick<ManagedIssue, "labels">): string[] {
  return issue.labels.map(({ name }) => (typeof name === "string" ? name : "")).filter(Boolean);
}

export function assigneeLogins(issue: Pick<ManagedIssue, "assignees">): string[] {
  return issue.assignees.map(({ login }) => (typeof login === "string" ? login : "")).filter(Boolean);
}

function openBlockers(issue: Pick<ManagedIssue, "blockedBy">): number[] {
  return (issue.blockedBy?.nodes ?? []).filter(({ state }) => state === "OPEN").map(({ number }) => number);
}

function titlePrefix(title: string): string | null {
  for (const prefix of EPIC_TITLE_PREFIXES) {
    if (title.startsWith(prefix)) return prefix;
  }
  return null;
}

export function evaluateEligibility(issue: ManagedIssue): ManagedQueueReason[] {
  const reasons: ManagedQueueReason[] = [];
  if (issue.state !== "OPEN") reasons.push("closed");
  if (assigneeLogins(issue).length > 0) reasons.push("assigned");
  if (!labelNames(issue).includes(READY_FOR_AGENT_LABEL)) reasons.push("wrong-label");
  if (openBlockers(issue).length > 0) reasons.push("has-blocker");
  if (titlePrefix(issue.title) !== null) reasons.push("epic-or-spec");
  if (labelNames(issue).includes("epic")) reasons.push("epic-or-spec");
  return reasons;
}

export function isEligibleManagedIssue(issue: ManagedIssue): boolean {
  return evaluateEligibility(issue).length === 0;
}

export function classifyQueueIssues(issues: ManagedIssue[]): ManagedQueueClassification {
  const managed: ManagedIssue[] = [];
  const blocked: ManagedQueueBlockEntry[] = [];
  const eligible: ManagedIssue[] = [];
  for (const issue of issues) {
    managed.push(issue);
    const reasons = evaluateEligibility(issue);
    if (reasons.length === 0) eligible.push(issue);
    else blocked.push({ number: issue.number, title: issue.title, reasons });
  }
  return { managed, eligible, blocked };
}

export function orderEligibleManagedIssues(issues: ManagedIssue[]): ManagedIssue[] {
  return [...issues].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.number - right.number;
  });
}

export interface GitHubManagedQueueAdapter {
  selectAndClaimEligibleIssue(workingDirectory: string): Promise<ManagedQueueOutcome>;
  verifyRepository?(workingDirectory: string): Promise<GitHubRepositoryContext>;
  verifyAuthentication?(workingDirectory: string): Promise<GitHubAuthenticatedIdentity>;
  selectEligibleIssue?(workingDirectory: string): Promise<ManagedQueueSelection>;
  claimSelectedIssue?(issueNumber: number, workingDirectory: string): Promise<SelectedManagedIssue>;
  readIssueDetail?(issueNumber: number, workingDirectory: string): Promise<SelectedManagedIssue>;
  reconcileClaimedIssue?(issueNumber: number, workingDirectory: string): Promise<SelectedManagedIssue>;
  releaseOwnClaim?(issueNumber: number, login: string, workingDirectory: string): Promise<void>;
}

export class GitHubManagedQueueService implements GitHubManagedQueueAdapter {
  constructor(private readonly gh: GhRunner = runGh) {}

  async verifyAuthentication(workingDirectory: string): Promise<GitHubAuthenticatedIdentity> {
    const output = await this.gh(["api", "user"], workingDirectory);
    const parsed = JSON.parse(output) as { login?: string };
    if (typeof parsed.login !== "string" || !parsed.login) {
      throw new Error("gh api user no devolvio la identidad autenticada");
    }
    return { login: parsed.login };
  }

  async verifyRepository(workingDirectory: string): Promise<GitHubRepositoryContext> {
    const output = await this.gh(["repo", "view", "--json", "nameWithOwner"], workingDirectory);
    const parsed = JSON.parse(output) as { nameWithOwner?: string };
    if (!parsed.nameWithOwner) throw new Error("gh repo view no devolvio el repositorio");
    return { nameWithOwner: parsed.nameWithOwner };
  }

  async listManagedIssues(workingDirectory: string): Promise<ManagedIssue[]> {
    const output = await this.gh([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      READY_FOR_AGENT_LABEL,
      "--limit",
      "100",
      "--json",
      "number,title,state,labels,assignees,createdAt,blockedBy",
    ], workingDirectory);
    const parsed = JSON.parse(output) as ManagedIssue[];
    return Array.isArray(parsed) ? parsed : [];
  }

  async readIssueDetail(issueNumber: number, workingDirectory: string): Promise<SelectedManagedIssue> {
    const output = await this.gh([
      "issue",
      "view",
      `${issueNumber}`,
      "--json",
      "number,title,state,labels,assignees,createdAt,blockedBy,body,comments",
    ], workingDirectory);
    const parsed = JSON.parse(output) as {
      number?: number;
      title?: string;
      state?: string;
      labels?: Array<{ name?: string }>;
      assignees?: Array<{ login?: string }>;
      createdAt?: string;
      blockedBy?: { nodes?: Array<{ number: number; state: string }> };
      body?: string;
      comments?: Array<{ body?: string }>;
    };
    if (parsed.number !== issueNumber || typeof parsed.title !== "string" || typeof parsed.createdAt !== "string") {
      throw new Error(`gh issue view devolvio un alcance inesperado para el Issue ${issueNumber}`);
    }
    return {
      number: issueNumber,
      title: parsed.title,
      state: parsed.state ?? "",
      labels: parsed.labels ?? [],
      assignees: parsed.assignees ?? [],
      createdAt: parsed.createdAt,
      blockedBy: { nodes: parsed.blockedBy?.nodes ?? [] },
      body: parsed.body ?? "",
      comments: (parsed.comments ?? []).map(({ body }) => body ?? ""),
    };
  }

  async reconcileClaimedIssue(issueNumber: number, workingDirectory: string): Promise<SelectedManagedIssue> {
    const identity = await this.verifyAuthentication(workingDirectory);
    const issue = await this.readIssueDetail(issueNumber, workingDirectory);
    const assignees = assigneeLogins(issue);
    const eligibilityAfterClaim = evaluateEligibility(issue).filter((reason) => reason !== "assigned");
    if (assignees.length !== 1
      || assignees[0] !== identity.login
      || eligibilityAfterClaim.length > 0) {
      throw new Error(`el Issue #${issueNumber} ya no conserva el claim GitHub verificable`);
    }
    return issue;
  }

  async selectEligibleIssue(workingDirectory: string): Promise<ManagedQueueSelection> {
    await this.verifyAuthentication(workingDirectory);
    const repository = await this.verifyRepository(workingDirectory);
    const classification = classifyQueueIssues(await this.listManagedIssues(workingDirectory));
    const candidate = orderEligibleManagedIssues(classification.eligible)[0];
    if (candidate) return { kind: "candidate", issue: candidate, repository };
    if (classification.managed.length === 0) return { kind: "empty" };
    return { kind: "blocked", reasons: classification.blocked };
  }

  async claimSelectedIssue(issueNumber: number, workingDirectory: string): Promise<SelectedManagedIssue> {
    await this.claimIssue(issueNumber, workingDirectory);
    return this.reconcileClaimedIssue(issueNumber, workingDirectory);
  }

  async claimIssue(issueNumber: number, workingDirectory: string): Promise<void> {
    await this.gh(["issue", "edit", `${issueNumber}`, ADD_ASSIGNEE_FLAG, ME_HANDLE], workingDirectory);
  }

  async releaseOwnClaim(issueNumber: number, login: string, workingDirectory: string): Promise<void> {
    await this.gh(["issue", "edit", `${issueNumber}`, REMOVE_ASSIGNEE_FLAG, login], workingDirectory);
  }

  async selectAndClaimEligibleIssue(workingDirectory: string): Promise<ManagedQueueOutcome> {
    const identity = await this.verifyAuthentication(workingDirectory);
    const repository = await this.verifyRepository(workingDirectory);
    const issues = await this.listManagedIssues(workingDirectory);
    const classification = classifyQueueIssues(issues);
    const ordered = orderEligibleManagedIssues(classification.eligible);
    while (ordered.length > 0) {
      const candidate = ordered.shift()!;
      await this.claimIssue(candidate.number, workingDirectory);
      const detail = await this.readIssueDetail(candidate.number, workingDirectory);
      const assignees = assigneeLogins(detail);
      const lost = assignees.length !== 1 || assignees[0] !== identity.login;
      if (lost && assignees.includes(identity.login)) {
        await this.releaseOwnClaim(candidate.number, identity.login, workingDirectory);
      }
      if (!lost && detail.state === "OPEN" && openBlockers(detail).length === 0) {
        return { kind: "selected", issue: detail, repository };
      }
    }
    if (classification.managed.length === 0) return { kind: "empty" };
    return { kind: "blocked", reasons: classification.blocked };
  }
}
