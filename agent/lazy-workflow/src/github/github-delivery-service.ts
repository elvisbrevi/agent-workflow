import { resolve } from "node:path";
import { GitTicketBranchCleaner, checkoutGitBranch, pushGitBranch, runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import { runGh, type GhRunner } from "./managed-queue-service.ts";

export interface GitHubReadyManifest {
  issue: number;
  branch: string;
  commit: string;
  validation: Array<{ command: string; result: string }>;
  clean: boolean;
  summary: string;
}

export interface GitHubBranchPreparation {
  branch: string;
  baseBranch: string;
  manifestPath: string;
}

export interface GitHubPullRequest {
  number: number;
  mergeCommit?: string;
}

export interface GitHubDeliveryAdapter {
  prepareBranch(issue: number, workingDirectory: string): Promise<GitHubBranchPreparation>;
  readManifest(path: string, workingDirectory: string): Promise<GitHubReadyManifest>;
  pushCommit(branch: string, commit: string, workingDirectory: string): Promise<void>;
  createOrReusePullRequest(issue: number, branch: string, baseBranch: string, workingDirectory: string): Promise<GitHubPullRequest>;
  mergePullRequest(pullRequest: number, issue: number, branch: string, baseBranch: string, workingDirectory: string): Promise<GitHubPullRequest & { mergeCommit: string }>;
  closeIssue(issue: number, pullRequest: number, mergeCommit: string, workingDirectory: string): Promise<void>;
  cleanupBranch(branch: string, baseBranch: string, workingDirectory: string): Promise<void>;
}

interface RepositoryView {
  nameWithOwner?: string;
  defaultBranchRef?: { name?: string };
}

interface PullRequestView {
  number?: number;
  state?: string;
  body?: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  mergeCommit?: { oid?: string };
  mergedAt?: string | null;
  statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function requireBranch(value: string, label: string): string {
  const name = value.replace(/^refs\/heads\//, "");
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value)
    || name.includes("..")
    || name.includes("//")
    || name.startsWith("/")
    || name.endsWith("/")) {
    throw new Error(`${label} no es una rama válida`);
  }
  return value;
}

function requireCommit(value: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new Error("El commit del manifest no es válido");
  return value;
}

function parseJson<T>(output: string, label: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`${label} devolvió JSON inválido`, { cause: error });
  }
}

function repositoryFromRemote(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, "");
  const match = value.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return match?.[1] ?? null;
}

function manifestIsValid(value: unknown): value is GitHubReadyManifest {
  if (typeof value !== "object" || value === null) return false;
  const allowedKeys = new Set(["issue", "branch", "commit", "validation", "clean", "summary"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const manifest = value as Partial<GitHubReadyManifest>;
  return Number.isInteger(manifest.issue)
    && (manifest.issue ?? 0) > 0
    && typeof manifest.branch === "string"
    && typeof manifest.commit === "string"
    && Array.isArray(manifest.validation)
    && manifest.validation.length > 0
    && manifest.validation.every((entry) => typeof entry?.command === "string" && typeof entry.result === "string")
    && manifest.clean === true
    && typeof manifest.summary === "string"
    && manifest.summary.length > 0;
}

export class GitHubDeliveryService implements GitHubDeliveryAdapter {
  constructor(
    private readonly gh: GhRunner = runGh,
    private readonly git: GitRunner = runGit,
    private readonly cleaner: GitTicketBranchCleaner = new GitTicketBranchCleaner(git),
  ) {}

  private async repository(workingDirectory: string): Promise<{ name: string; baseBranch: string }> {
    const view = parseJson<RepositoryView>(await this.gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], workingDirectory), "gh repo view");
    const name = view.nameWithOwner;
    const base = view.defaultBranchRef?.name;
    if (!name || !base) throw new Error("No se pudo verificar el repositorio o su rama base");
    const remote = await this.git(["remote", "get-url", "origin"], workingDirectory);
    if (repositoryFromRemote(remote) !== name) throw new Error("El remote origin no coincide con el repositorio GitHub fijado");
    return { name, baseBranch: requireBranch(`refs/heads/${base}`, "La rama base") };
  }

  async prepareBranch(issue: number, workingDirectory: string): Promise<GitHubBranchPreparation> {
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("El issue no es válido");
    const { baseBranch } = await this.repository(workingDirectory);
    const branch = `refs/heads/issue/${issue}`;
    const status = await this.git(["status", "--porcelain", "--untracked-files=all"], workingDirectory);
    if (status.trim()) throw new Error("El repositorio tiene cambios sin guardar");
    const baseName = branchName(baseBranch);
    await this.git(["fetch", "origin", `+${baseBranch}:refs/remotes/origin/${baseName}`], workingDirectory);
    const remote = (await this.git(["ls-remote", "--heads", "origin", branch], workingDirectory)).trim();
    if (remote) {
      await checkoutGitBranch(this.git, branch, workingDirectory);
    } else {
      const local = await this.git(["branch", "--list", branchName(branch)], workingDirectory);
      if (local.trim()) throw new Error(`La rama local ${branch} existe sin rama remota verificable`);
      await this.git(["switch", "--create", branchName(branch), `refs/remotes/origin/${baseName}`], workingDirectory);
    }
    const commonDirectory = resolve(workingDirectory, (await this.git(["rev-parse", "--git-common-dir"], workingDirectory)).trim());
    const manifestPath = resolve(commonDirectory, "lazy-workflow/github-completion-manifest.json");
    return { branch, baseBranch, manifestPath };
  }

  async readManifest(path: string, workingDirectory: string): Promise<GitHubReadyManifest> {
    const value: unknown = await Bun.file(path).json();
    if (!manifestIsValid(value)) throw new Error("El manifest IMPLEMENTATION_READY es inválido");
    const manifest = value;
    const branch = requireBranch(manifest.branch, "El manifest");
    const active = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
    if (active !== branchName(branch)) throw new Error("La rama activa no coincide con el manifest");
    const commit = requireCommit(manifest.commit);
    const head = (await this.git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
    if (head !== commit) throw new Error("El commit del manifest no coincide con HEAD");
    const status = await this.git(["status", "--porcelain", "--untracked-files=all"], workingDirectory);
    if (status.trim()) throw new Error("El worktree no está limpio para publicar el manifest");
    return { ...manifest, branch, commit };
  }

  async pushCommit(branch: string, commit: string, workingDirectory: string): Promise<void> {
    requireBranch(branch, "La rama");
    requireCommit(commit);
    const head = (await this.git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
    if (head !== commit) throw new Error("El commit a publicar no coincide con HEAD");
    await pushGitBranch(this.git, branch, workingDirectory);
  }

  async createOrReusePullRequest(issue: number, branch: string, baseBranch: string, workingDirectory: string): Promise<GitHubPullRequest> {
    const { name } = await this.repository(workingDirectory);
    const head = branchName(branch);
    const base = branchName(baseBranch);
    const output = await this.gh(["pr", "list", "--repo", name, "--state", "all", "--head", head, "--base", base, "--json", "number,state,body,headRefName,baseRefName"], workingDirectory);
    const pullRequests = parseJson<PullRequestView[]>(output, "gh pr list").filter((pr) =>
      pr.headRefName === head && pr.baseRefName === base && typeof pr.number === "number" && (pr.body ?? "").includes(`#${issue}`));
    if (pullRequests.length > 1) throw new Error(`El Issue #${issue} tiene múltiples PR canónicos`);
    if (pullRequests.length === 1) return { number: pullRequests[0]!.number! };
    const created = await this.gh([
      "pr", "create", "--repo", name, "--base", base, "--head", head,
      "--title", `Issue #${issue}`, "--body", `Closes #${issue}`,
    ], workingDirectory);
    const match = created.match(/\/pull\/(\d+)(?:\s|$)/);
    if (!match) throw new Error("gh pr create no devolvió un PR verificable");
    return { number: Number(match[1]) };
  }

  private async readPullRequest(number: number, workingDirectory: string): Promise<PullRequestView> {
    return parseJson<PullRequestView>(await this.gh([
      "pr", "view", `${number}`, "--json", "number,state,body,headRefName,baseRefName,isDraft,mergeStateStatus,mergeCommit,mergedAt,statusCheckRollup",
    ], workingDirectory), "gh pr view");
  }

  private validatePullRequest(pr: PullRequestView, issue: number, branch: string, baseBranch: string): void {
    if (pr.headRefName !== branchName(branch) || pr.baseRefName !== branchName(baseBranch) || !(pr.body ?? "").includes(`#${issue}`)) {
      throw new Error("El PR no coincide con el issue, la rama o la rama base fijados");
    }
    if (pr.state === "MERGED") return;
    if (pr.state !== "OPEN" || pr.isDraft || pr.mergeStateStatus !== "CLEAN") throw new Error("El PR no cumple los requisitos de merge");
    const failedCheck = (pr.statusCheckRollup ?? []).find(({ conclusion, state }) =>
      conclusion && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion) || state && !["SUCCESS", "COMPLETED"].includes(state));
    if (failedCheck) throw new Error("El PR tiene checks requeridos no satisfactorios");
  }

  async mergePullRequest(pullRequest: number, issue: number, branch: string, baseBranch: string, workingDirectory: string): Promise<GitHubPullRequest & { mergeCommit: string }> {
    let current = await this.readPullRequest(pullRequest, workingDirectory);
    this.validatePullRequest(current, issue, branch, baseBranch);
    if (current.state !== "MERGED") {
      await this.gh(["pr", "merge", `${pullRequest}`, "--merge"], workingDirectory);
      current = await this.readPullRequest(pullRequest, workingDirectory);
      this.validatePullRequest(current, issue, branch, baseBranch);
    }
    const mergeCommit = current.mergeCommit?.oid;
    if (current.state !== "MERGED" || !mergeCommit) throw new Error("El PR no tiene un commit de merge verificable");
    return { number: pullRequest, mergeCommit };
  }

  async closeIssue(issue: number, pullRequest: number, mergeCommit: string, workingDirectory: string): Promise<void> {
    const state = parseJson<{ state?: string }>(await this.gh(["issue", "view", `${issue}`, "--json", "state"], workingDirectory), "gh issue view");
    if (state.state === "CLOSED") return;
    await this.gh(["issue", "comment", `${issue}`, "--body", `Delivered by merged PR #${pullRequest} (${mergeCommit}).`], workingDirectory);
    await this.gh(["issue", "close", `${issue}`], workingDirectory);
    const verified = parseJson<{ state?: string }>(await this.gh(["issue", "view", `${issue}`, "--json", "state"], workingDirectory), "gh issue view");
    if (verified.state !== "CLOSED") throw new Error(`El Issue #${issue} no quedó cerrado`);
  }

  async cleanupBranch(branch: string, baseBranch: string, workingDirectory: string): Promise<void> {
    await this.cleaner.deleteTicketBranch(branch, baseBranch, workingDirectory);
    if ((await this.git(["branch", "--list", branchName(branch)], workingDirectory)).trim()) {
      throw new Error(`La rama local ${branch} no se pudo eliminar`);
    }
    if ((await this.git(["ls-remote", "--heads", "origin", branch], workingDirectory)).trim()) {
      throw new Error(`La rama remota ${branch} no se pudo eliminar`);
    }
  }
}
