import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { GitTicketBranchCleaner, checkoutGitBranch, pushGitBranch, runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import { writeVerifiedManifest } from "../manifest/verified-write.ts";
import { reportOperator } from "../output/operator-output.ts";
import { runGh, type GhRunner } from "./managed-queue-service.ts";
import { renderEvidenceMarkdown, type EvidenceFile } from "../evidence/evidence-report.ts";
import type { EvidenceKind } from "../azure/completion-manifest.ts";

export interface GitHubReadyManifest {
  issue: number;
  branch: string;
  commit: string;
  validation: Array<{ command: string; result: string }>;
  clean: boolean;
  summary: string;
  evidence?: Array<{ path: string; sha256: string }>;
}

/**
 * What a session declares for its manifest, and only that: what it alone knows.
 * The commit, the clean flag and every digest are read from the repository by
 * `writeManifest`, so they cannot be misdeclared.
 */
export interface GitHubManifestInput {
  issue: number;
  branch: string;
  commit?: string;
  validation: Array<{ command: string; result: string }>;
  summary: string;
  evidence: string[];
}

/**
 * The evidence a closure publishes, and the repository it lives in.
 *
 * In a workspace delivery the issue lives in the anchor repository while the manifest and its
 * evidence files belong to whichever repository actually changed, so the directory travels with the
 * manifest: reading the files, resolving the repository name and pinning the image URLs all follow
 * it rather than the directory the `gh` commands run in.
 */
export interface DeliveredEvidence {
  manifest: GitHubReadyManifest;
  directory: string;
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

export class GitHubPullRequestConflictError extends Error {
  constructor(readonly pullRequest: number) {
    super(`El PR #${pullRequest} tiene conflictos con su rama base`);
    this.name = "GitHubPullRequestConflictError";
  }
}

export class GitHubManifestNotVerifiableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubManifestNotVerifiableError";
  }
}

export interface GitHubDeliveryAdapter {
  verifyRepository?(repository: string, workingDirectory: string): Promise<void>;
  checkoutBranch?(branch: string, baseBranch: string, workingDirectory: string): Promise<void>;
  verifyBranch?(branch: string, baseBranch: string, workingDirectory: string): Promise<void>;
  prepareBranch(issue: number, workingDirectory: string): Promise<GitHubBranchPreparation>;
  readManifest(path: string, workingDirectory: string): Promise<GitHubReadyManifest>;
  writeManifest?(path: string, input: GitHubManifestInput, workingDirectory: string): Promise<GitHubReadyManifest>;
  pushCommit(branch: string, commit: string, workingDirectory: string): Promise<void>;
  createOrReusePullRequest(issue: number, branch: string, baseBranch: string, commit: string, workingDirectory: string, closesIssue?: boolean, issueReference?: string, manifest?: GitHubReadyManifest): Promise<GitHubPullRequest>;
  preparePullRequestReconciliation?(branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<{ baseCommit: string }>;
  verifyPendingPullRequestReconciliation?(branch: string, originalCommit: string, baseCommit: string, workingDirectory: string): Promise<void>;
  verifyPullRequestReconciliation?(branch: string, originalCommit: string, baseCommit: string, reconciledCommit: string, workingDirectory: string): Promise<void>;
  mergePullRequest(pullRequest: number, issue: number, branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<GitHubPullRequest & { mergeCommit: string }>;
  closeIssue(issue: number, pullRequest: number, mergeCommit: string, workingDirectory: string, evidence?: DeliveredEvidence): Promise<void>;
  cleanupBranch(branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<void>;
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
  headRefOid?: string;
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

export function githubRepositoryFromRemote(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, "");
  const match = value.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return match?.[1] ?? null;
}

function referencesIssue(body: string, issue: number): boolean {
  return new RegExp(`(?:^|\\s)(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#${issue}(?!\\d)`).test(body);
}

/**
 * A GitHub manifest names evidence files without naming their kind, because in this workflow the
 * evidence lives in the repository and the file already says what it is. The extension is the only
 * declaration there is, so it is the one the renderer reads.
 */
function githubEvidenceKind(path: string): EvidenceKind {
  if (/\.(?:png|jpe?g|webp)$/i.test(path)) return "screen";
  return /\.json$/i.test(path) ? "http-json" : "command-output";
}

/** Where a repository file can be shown from, pinned to the commit that carries it. */
const blobUrl = (repository: string, commit: string, path: string): string =>
  `https://github.com/${repository}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}?raw=1`;

/**
 * A GitHub comment has a size of its own, and evidence can be long. Cutting at a section boundary
 * is what keeps a truncated document readable: a cut inside a fenced block leaves the rest of the
 * comment rendered as code.
 */
const MAX_COMMENT_CHARACTERS = 55000;

function capMarkdown(body: string): string | null {
  if (body.length <= MAX_COMMENT_CHARACTERS) return body;
  // Any heading the document uses, not just the top level: cutting only at `###` threw away every
  // capture that fit, because a capture is a `####` inside the section the cut fell back to.
  const headings = [...body.slice(0, MAX_COMMENT_CHARACTERS).matchAll(/\n#{2,4} /g)];
  const boundary = headings.at(-1)?.index ?? -1;
  if (boundary <= 0) return null;
  return `${body.slice(0, boundary)}\n\n_(evidencia truncada; el resto vive en el repositorio)_`;
}

function validationResultIsNotFailure(result: string): boolean {
  return !/^(?:fail(?:ed|ure)?|error)(?:\b|:)/i.test(result.trim()) && !/^exit\s+[1-9]/i.test(result.trim());
}

function manifestIsValid(value: unknown): value is GitHubReadyManifest {
  if (typeof value !== "object" || value === null) return false;
  const allowedKeys = new Set(["issue", "branch", "commit", "validation", "clean", "summary", "evidence"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const manifest = value as Partial<GitHubReadyManifest>;
  return Number.isInteger(manifest.issue)
    && (manifest.issue ?? 0) > 0
    && typeof manifest.branch === "string"
    && typeof manifest.commit === "string"
    && Array.isArray(manifest.validation)
    && manifest.validation.length > 0
    && manifest.validation.every((entry) => typeof entry?.command === "string" && entry.command.trim().length > 0 && typeof entry.result === "string" && entry.result.trim().length > 0 && validationResultIsNotFailure(entry.result))
    && manifest.clean === true
    && typeof manifest.summary === "string"
    && manifest.summary.trim().length > 0
    && (manifest.evidence === undefined || (Array.isArray(manifest.evidence) && manifest.evidence.length > 0 && manifest.evidence.every((entry) => typeof entry?.path === "string" && entry.path.trim().length > 0 && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/i.test(entry.sha256))));
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
    if (githubRepositoryFromRemote(remote) !== name) throw new Error("El remote origin no coincide con el repositorio GitHub fijado");
    return { name, baseBranch: requireBranch(`refs/heads/${base}`, "La rama base") };
  }

  async verifyRepository(repository: string, workingDirectory: string): Promise<void> {
    const current = await this.repository(workingDirectory);
    if (current.name !== repository) throw new Error(`el checkpoint GitHub pertenece a ${repository}, no a ${current.name}`);
  }

  async checkoutBranch(branch: string, baseBranch: string, workingDirectory: string): Promise<void> {
    const verifiedBranch = requireBranch(branch, "La rama");
    requireBranch(baseBranch, "La rama base");
    const operationPaths = (await this.git([
      "rev-parse",
      "--git-path", "MERGE_HEAD",
      "--git-path", "CHERRY_PICK_HEAD",
      "--git-path", "REVERT_HEAD",
      "--git-path", "BISECT_LOG",
      "--git-path", "rebase-merge",
      "--git-path", "rebase-apply",
    ], workingDirectory)).trim().split(/\r?\n/).filter(Boolean);
    if (operationPaths.some((path) => existsSync(resolve(workingDirectory, path)))) {
      throw new Error("El repositorio tiene una operación Git en curso");
    }
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (status.trim()) {
      // Never auto-pop: a stash never lands on any branch's history, so it
      // cannot mix unrelated work into whatever the recovery flow commits next.
      // The operator must retrieve it deliberately once reconciliation is done.
      // Tracked changes only, matching the status above: the untracked files an
      // agent leaves behind are its own scratch, and stashing them would break
      // the next run that expects them in place.
      await this.git(["stash", "push", "-m", `lazy-workflow: auto-stash antes de reconciliar ${verifiedBranch}`], workingDirectory);
      reportOperator(`lazy-workflow: se detectaron cambios sin guardar; se guardaron con "git stash" antes de reconciliar la rama ${verifiedBranch} (recuperalos con "git stash list" / "git stash pop").`);
    }
    const active = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
    if (active === branchName(verifiedBranch)) return;
    if (!(await this.git(["branch", "--list", branchName(verifiedBranch)], workingDirectory)).trim()) {
      throw new Error(`La rama local ${verifiedBranch} no existe`);
    }
    await this.git(["switch", "--no-guess", branchName(verifiedBranch)], workingDirectory);
  }

  async verifyBranch(branch: string, baseBranch: string, workingDirectory: string): Promise<void> {
    const verifiedBranch = requireBranch(branch, "La rama");
    requireBranch(baseBranch, "La rama base");
    const active = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
    if (active !== branchName(verifiedBranch)) throw new Error(`La rama activa ${active || "detached"} no coincide con ${verifiedBranch}`);
    if (!(await this.git(["branch", "--list", branchName(verifiedBranch)], workingDirectory)).trim()) {
      throw new Error(`La rama local ${verifiedBranch} no existe`);
    }
    const remote = (await this.git(["ls-remote", "--heads", "origin", verifiedBranch], workingDirectory)).trim();
    if (remote) {
      const localCommit = (await this.git(["rev-parse", `refs/heads/${branchName(verifiedBranch)}^{commit}`], workingDirectory)).trim();
      if (remote.split(/\s+/)[0] !== localCommit) throw new Error(`La rama local ${verifiedBranch} no coincide con su rama remota`);
    }
  }

  async prepareBranch(issue: number, workingDirectory: string): Promise<GitHubBranchPreparation> {
    if (!Number.isInteger(issue) || issue <= 0) throw new Error("El issue no es válido");
    const { baseBranch } = await this.repository(workingDirectory);
    const branch = `refs/heads/issue/${issue}`;
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (status.trim()) throw new Error("El repositorio tiene cambios sin guardar");
    const baseName = branchName(baseBranch);
    await this.git(["fetch", "origin", `+${baseBranch}:refs/remotes/origin/${baseName}`], workingDirectory);
    const remote = (await this.git(["ls-remote", "--heads", "origin", branch], workingDirectory)).trim();
    if (remote) {
      await checkoutGitBranch(this.git, branch, workingDirectory);
    } else {
      const local = await this.git(["branch", "--list", branchName(branch)], workingDirectory);
      if (local.trim()) {
        const active = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
        if (active !== branchName(branch)) throw new Error(`La rama local ${branch} existe sin rama remota verificable`);
      } else {
        await this.git(["switch", "--create", branchName(branch), `refs/remotes/origin/${baseName}`], workingDirectory);
      }
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
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (status.trim()) throw new Error("El worktree no está limpio para publicar el manifest");
    for (const evidence of manifest.evidence ?? []) {
      const evidencePath = resolve(workingDirectory, evidence.path);
      const relativeEvidencePath = relative(resolve(workingDirectory), evidencePath);
      const outsideRepository = relativeEvidencePath === ".." || relativeEvidencePath.startsWith(`..${sep}`);
      if (outsideRepository || !await Bun.file(evidencePath).exists()) throw new Error(`La evidencia del manifest no es un archivo del repositorio: ${evidence.path}`);
      const digest = createHash("sha256").update(new Uint8Array(await Bun.file(evidencePath).arrayBuffer())).digest("hex");
      if (digest.toLowerCase() !== evidence.sha256.toLowerCase()) throw new Error(`El digest de evidencia no coincide: ${evidence.path}`);
    }
    return { ...manifest, branch, commit };
  }

  /**
   * Writes the `IMPLEMENTATION_READY` manifest, already valid.
   *
   * The session declares only what it alone knows — the issue, the branch, what
   * it ran and what came out, and the summary. Everything a session used to get
   * wrong is taken from the repository instead: the commit is HEAD, `clean` is
   * the worktree's real state rather than a claim, and every evidence digest is
   * read off the file. The result goes back through `readManifest`, the same gate
   * the coordinator applies, so the file on disk is one the delivery accepts or
   * there is no file at all.
   */
  async writeManifest(path: string, input: GitHubManifestInput, workingDirectory: string): Promise<GitHubReadyManifest> {
    if (!Number.isInteger(input.issue) || input.issue <= 0) throw new Error("El issue del manifest no es válido");
    const branch = requireBranch(input.branch, "La rama");
    const summary = input.summary.trim();
    if (!summary) throw new Error("El manifest requiere un resumen");
    const head = (await this.git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
    const commit = input.commit ? requireCommit(input.commit) : requireCommit(head);
    if (commit !== head) throw new Error("El commit del manifest no coincide con HEAD");
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (status.trim()) throw new Error("El worktree no está limpio para publicar el manifest");
    const root = resolve(workingDirectory);
    const evidence: Array<{ path: string; sha256: string }> = [];
    for (const declared of input.evidence) {
      const evidencePath = resolve(root, declared);
      const relativePath = relative(root, evidencePath);
      const outsideRepository = !relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`);
      if (outsideRepository || !await Bun.file(evidencePath).exists()) {
        throw new Error(`La evidencia del manifest no es un archivo del repositorio: ${declared}`);
      }
      evidence.push({
        path: relativePath,
        sha256: createHash("sha256").update(new Uint8Array(await Bun.file(evidencePath).arrayBuffer())).digest("hex"),
      });
    }
    const manifest: GitHubReadyManifest = {
      issue: input.issue,
      branch,
      commit,
      validation: input.validation,
      clean: true,
      summary,
      // The key itself is optional, and an empty array is invalid, so an evidence-less
      // delivery must not carry it at all (`manifestIsValid`).
      ...(evidence.length > 0 ? { evidence } : {}),
    };
    if (!manifestIsValid(manifest)) throw new Error("El manifest IMPLEMENTATION_READY es inválido");
    return writeVerifiedManifest(resolve(path), manifest, (manifestPath) => this.readManifest(manifestPath, workingDirectory));
  }

  async pushCommit(branch: string, commit: string, workingDirectory: string): Promise<void> {
    requireBranch(branch, "La rama");
    requireCommit(commit);
    const head = (await this.git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
    if (head !== commit) throw new Error("El commit a publicar no coincide con HEAD");
    await pushGitBranch(this.git, branch, workingDirectory);
  }

  async createOrReusePullRequest(issue: number, branch: string, baseBranch: string, commit: string, workingDirectory: string, closesIssue = true, issueReference = `#${issue}`, manifest?: GitHubReadyManifest): Promise<GitHubPullRequest> {
    const { name } = await this.repository(workingDirectory);
    const head = branchName(branch);
    const base = branchName(baseBranch);
    const remote = (await this.git(["ls-remote", "--heads", "origin", branch], workingDirectory)).trim();
    if (!remote || remote.split(/\s+/)[0] !== commit) throw new Error(`La rama remota ${branch} no coincide con el commit fijado`);
    const output = await this.gh(["pr", "list", "--repo", name, "--state", "all", "--head", head, "--base", base, "--json", "number,state,body,headRefName,baseRefName,headRefOid"], workingDirectory);
    const relatedPullRequests = parseJson<PullRequestView[]>(output, "gh pr list").filter((pr) =>
      pr.headRefName === head && pr.baseRefName === base && typeof pr.number === "number" && referencesIssue(pr.body ?? "", issue));
    const pullRequests = relatedPullRequests.filter((pr) => pr.headRefOid === commit);
    if (relatedPullRequests.some((pr) => pr.headRefOid !== commit)) throw new Error(`El Issue #${issue} tiene un PR con una rama o commit conflictivo`);
    if (pullRequests.length > 1) throw new Error(`El Issue #${issue} tiene múltiples PR canónicos`);
    if (pullRequests.length === 1) return { number: pullRequests[0]!.number! };
    const reference = closesIssue ? `Closes ${issueReference}` : `Tracks ${issueReference}`;
    // The body a reviewer opens is the delivery itself: what changed, what was validated, and every
    // capture the session produced, shown where the review happens instead of listed as file names.
    const report = manifest && await this.evidenceReport(
      `Issue #${issue}`,
      [{ label: "Rama", value: head }, { label: "Commit", value: commit }],
      commit,
      { manifest, directory: workingDirectory },
    );
    // The reference is what ties the pull request to its issue, and every later check reads it back
    // out of the body: it is added around the report so no truncation can ever drop it.
    const body = report ? [reference, "", manifest!.summary, "", report].join("\n") : reference;
    const created = await this.gh([
      "pr", "create", "--repo", name, "--base", base, "--head", head,
      "--title", `Issue #${issue}`, "--body", body,
    ], workingDirectory);
    const match = created.match(/\/pull\/(\d+)(?:\s|$)/);
    if (!match) throw new Error("gh pr create no devolvió un PR verificable");
    return { number: Number(match[1]) };
  }

  private async readPullRequest(number: number, workingDirectory: string): Promise<PullRequestView> {
    return parseJson<PullRequestView>(await this.gh([
      "pr", "view", `${number}`, "--json", "number,state,body,headRefName,headRefOid,baseRefName,isDraft,mergeStateStatus,mergeCommit,mergedAt,statusCheckRollup",
    ], workingDirectory), "gh pr view");
  }

  private validatePullRequest(pr: PullRequestView, issue: number, branch: string, baseBranch: string, commit: string): void {
    if (pr.headRefName !== branchName(branch) || pr.headRefOid !== commit || pr.baseRefName !== branchName(baseBranch) || !referencesIssue(pr.body ?? "", issue)) {
      throw new Error("El PR no coincide con el issue, la rama o la rama base fijados");
    }
    if (pr.state === "MERGED") return;
    if (pr.state === "OPEN" && !pr.isDraft && pr.mergeStateStatus === "DIRTY") {
      throw new GitHubPullRequestConflictError(pr.number ?? 0);
    }
    if (pr.state !== "OPEN" || pr.isDraft || pr.mergeStateStatus !== "CLEAN") throw new Error("El PR no cumple los requisitos de merge");
    const failedCheck = (pr.statusCheckRollup ?? []).find(({ conclusion, state }) =>
      conclusion && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion) || state && !["SUCCESS", "COMPLETED"].includes(state));
    if (failedCheck) throw new Error("El PR tiene checks requeridos no satisfactorios");
  }

  async preparePullRequestReconciliation(branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<{ baseCommit: string }> {
    const fixedBranch = requireBranch(branch, "La rama");
    const fixedBaseBranch = requireBranch(baseBranch, "La rama base");
    const fixedCommit = requireCommit(commit);
    const active = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
    const head = (await this.git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (active !== branchName(fixedBranch) || head !== fixedCommit || status.trim()) {
      throw new Error("La rama del PR cambió antes de reconciliar conflictos");
    }
    const baseName = branchName(fixedBaseBranch);
    await this.git(["fetch", "origin", `+${fixedBaseBranch}:refs/remotes/origin/${baseName}`], workingDirectory);
    const baseCommit = requireCommit((await this.git(["rev-parse", `refs/remotes/origin/${baseName}^{commit}`], workingDirectory)).trim());
    return { baseCommit };
  }

  async verifyPullRequestReconciliation(branch: string, originalCommit: string, baseCommit: string, reconciledCommit: string, workingDirectory: string): Promise<void> {
    const fixedBranch = requireBranch(branch, "La rama");
    const original = requireCommit(originalCommit);
    const base = requireCommit(baseCommit);
    const reconciled = requireCommit(reconciledCommit);
    const active = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
    const head = (await this.git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (active !== branchName(fixedBranch) || head !== reconciled || status.trim()) {
      throw new Error("La reconciliación no dejó la rama fijada limpia en el commit declarado");
    }
    await this.git(["merge-base", "--is-ancestor", original, reconciled], workingDirectory);
    await this.git(["merge-base", "--is-ancestor", base, reconciled], workingDirectory);
  }

  async verifyPendingPullRequestReconciliation(branch: string, originalCommit: string, baseCommit: string, workingDirectory: string): Promise<void> {
    const fixedBranch = requireBranch(branch, "La rama");
    const original = requireCommit(originalCommit);
    const base = requireCommit(baseCommit);
    const active = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
    const head = requireCommit((await this.git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim());
    if (active !== branchName(fixedBranch)) throw new Error("La rama activa no coincide con la reconciliación fijada");
    if (head !== original) {
      await this.verifyPullRequestReconciliation(fixedBranch, original, base, head, workingDirectory);
      return;
    }
    const mergeHeadPath = (await this.git(["rev-parse", "--git-path", "MERGE_HEAD"], workingDirectory)).trim();
    if (await Bun.file(resolve(workingDirectory, mergeHeadPath)).exists()) {
      const mergeHead = requireCommit((await Bun.file(resolve(workingDirectory, mergeHeadPath)).text()).trim());
      if (mergeHead !== base) throw new Error("MERGE_HEAD no coincide con la base fijada");
      return;
    }
    if ((await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory)).trim()) {
      throw new Error("El worktree cambió fuera de la reconciliación fijada");
    }
  }

  private async verifyMergeRequirements(repository: string, baseBranch: string, pullRequest: number, workingDirectory: string): Promise<void> {
    const branch = parseJson<{ protected?: boolean }>(await this.gh(["api", `repos/${repository}/branches/${branchName(baseBranch)}`], workingDirectory), "GitHub branch");
    if (branch.protected) {
      const protection = await this.gh(["api", `repos/${repository}/branches/${branchName(baseBranch)}/protection`], workingDirectory);
      if (!protection.trim()) throw new Error("La protección de la rama base no se pudo verificar");
    }
    const checks = await this.readRequiredChecks(pullRequest, workingDirectory);
    if (checks.some(({ state, bucket }) => !["SUCCESS", "COMPLETED"].includes(state ?? "") && bucket !== "pass" && bucket !== "skipping")) {
      throw new Error("El PR tiene checks requeridos no satisfactorios");
    }
  }

  private async readRequiredChecks(pullRequest: number, workingDirectory: string): Promise<Array<{ state?: string; bucket?: string }>> {
    let checksOutput: string;
    try {
      checksOutput = await this.gh(["pr", "checks", `${pullRequest}`, "--required", "--json", "name,state,bucket"], workingDirectory);
    } catch (error) {
      // `gh pr checks` exits non-zero with "no [required] checks reported on the '<branch>' branch"
      // when the head commit has no status checks. That is not a failing check: there is nothing to
      // satisfy. Swallowing it is safe because a genuinely failing/missing required check makes the PR
      // BLOCKED, and validatePullRequest already rejected everything but CLEAN before we reach here.
      if (error instanceof Error && /no (?:required )?checks reported/i.test(error.message)) return [];
      throw error;
    }
    return parseJson<Array<{ state?: string; bucket?: string }>>(checksOutput.trim() || "[]", "gh pr checks");
  }

  async mergePullRequest(pullRequest: number, issue: number, branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<GitHubPullRequest & { mergeCommit: string }> {
    const { name } = await this.repository(workingDirectory);
    let current = await this.readPullRequest(pullRequest, workingDirectory);
    this.validatePullRequest(current, issue, branch, baseBranch, commit);
    if (current.state !== "MERGED") {
      await this.verifyMergeRequirements(name, baseBranch, pullRequest, workingDirectory);
      await this.gh(["pr", "merge", `${pullRequest}`, "--merge"], workingDirectory);
      current = await this.readPullRequest(pullRequest, workingDirectory);
      this.validatePullRequest(current, issue, branch, baseBranch, commit);
    }
    const mergeCommit = current.mergeCommit?.oid;
    if (current.state !== "MERGED" || !mergeCommit) throw new Error("El PR no tiene un commit de merge verificable");
    return { number: pullRequest, mergeCommit };
  }

  async closeIssue(issue: number, pullRequest: number, mergeCommit: string, workingDirectory: string, evidence?: DeliveredEvidence): Promise<void> {
    const state = parseJson<{ state?: string; comments?: Array<{ body?: string }> }>(await this.gh(["issue", "view", `${issue}`, "--json", "state,comments"], workingDirectory), "gh issue view");
    if (state.state === "CLOSED") return;
    const marker = `lazy-workflow: delivered PR #${pullRequest} (${mergeCommit})`;
    if (!(state.comments ?? []).some(({ body }) => body?.includes(marker))) {
      const report = evidence && await this.evidenceReport(
        `Issue #${issue}`,
        [
          { label: "Pull request", value: `#${pullRequest}` },
          { label: "Commit de merge", value: mergeCommit },
          { label: "Rama", value: branchName(evidence.manifest.branch) },
        ],
        mergeCommit,
        evidence,
      );
      // The marker stays in the body it always was, because a rerun still recognises the delivery
      // by it; it is added around the report so no truncation can drop it.
      const body = report ? [report, "", evidence!.manifest.summary, "", marker].join("\n") : marker;
      await this.gh(["issue", "comment", `${issue}`, "--body", body], workingDirectory);
    }
    await this.gh(["issue", "close", `${issue}`], workingDirectory);
    const verified = parseJson<{ state?: string }>(await this.gh(["issue", "view", `${issue}`, "--json", "state"], workingDirectory), "gh issue view");
    if (verified.state !== "CLOSED") throw new Error(`El Issue #${issue} no quedó cerrado`);
  }

  /**
   * The delivery as one readable document, or `null` when it cannot be rendered.
   *
   * Evidence a GitHub delivery produces lives in the repository, so the files can be shown where
   * they already are: a screenshot becomes an image pinned to the commit that carries it, and a
   * browser capture becomes its endpoint, its headers, its body and its response laid out as
   * tables. Both surfaces render through here, so the pull request and the closing comment cannot
   * show different things — and both fall back to their own minimum, because evidence that cannot
   * be rendered must not cost a delivery its pull request or its closure.
   */
  private async evidenceReport(
    subject: string,
    facts: Array<{ label: string; value: string }>,
    commit: string,
    { manifest, directory }: DeliveredEvidence,
  ): Promise<string | null> {
    try {
      // Resolved in here, under the same fallback: a lookup that failed outside it published a
      // comment whose every image pointed at `https://github.com//blob/...` and stayed broken.
      const { name: repository } = await this.repository(directory);
      const files: EvidenceFile[] = [];
      for (const { path } of manifest.evidence ?? []) {
        const kind = githubEvidenceKind(path);
        if (kind === "screen") {
          files.push({ name: path, path, kind, imageUrl: blobUrl(repository, commit, path) });
          continue;
        }
        // A file that cannot be read is worth less than the rest of the document is worth losing.
        const content = await Bun.file(resolve(directory, path)).text().catch(() => "");
        if (content.trim()) files.push({ name: path, path, kind, content });
      }
      return capMarkdown(renderEvidenceMarkdown({ subject, facts, validation: manifest.validation, files }));
    } catch {
      return null;
    }
  }

  async cleanupBranch(branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<void> {
    const remote = (await this.git(["ls-remote", "--heads", "origin", branch], workingDirectory)).trim();
    if (remote && remote.split(/\s+/)[0] !== commit) throw new Error(`La rama remota ${branch} cambió antes de la limpieza`);
    const local = (await this.git(["branch", "--list", branchName(branch)], workingDirectory)).trim();
    if (local && (await this.git(["rev-parse", `refs/heads/${branchName(branch)}^{commit}`], workingDirectory)).trim() !== commit) {
      throw new Error(`La rama local ${branch} cambió antes de la limpieza`);
    }
    await this.cleaner.deleteTicketBranch(branch, baseBranch, workingDirectory, commit);
    if ((await this.git(["branch", "--list", branchName(branch)], workingDirectory)).trim()) {
      throw new Error(`La rama local ${branch} no se pudo eliminar`);
    }
    if ((await this.git(["ls-remote", "--heads", "origin", branch], workingDirectory)).trim()) {
      throw new Error(`La rama remota ${branch} no se pudo eliminar`);
    }
  }
}
