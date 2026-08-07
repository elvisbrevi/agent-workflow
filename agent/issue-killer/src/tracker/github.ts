// GitHub implementation of the normalized tracker port.
//
// The adapter is the only place that talks to the GitHub CLI; the rest of
// the supervisor consumes the typed `TrackerPort` surface in
// `src/domain/ports.ts`. Every shell invocation is a static argv array,
// JSON output is validated against the documented shape, and ambiguous or
// missing values fail closed rather than fall back to permissive defaults.
//
// Composition:
//   * `createGithubTracker` builds a `TrackerPort` from a command runner and a
//     pre-validated slug (e.g. `elvisbrevi/agent-workflow`). Preflight lives
//     in `preflightGithubTracker` so callers can fail before constructing
//     any worker state.

import { join } from "node:path"
import type { CommandRunnerPort, GitPort, TrackerPort } from "../domain/ports"
import type { TrackerIdentity } from "../domain/tracker"
import {
  type CompletionEvidence,
  type CompletionVerification,
  type TrackerSelection,
} from "../domain/tracker"
import {
  type GithubCompletion,
  type GithubIssue,
  type GithubPullRequest,
  evaluateGithubEligibility,
  parseGithubIssue,
  parseGithubPullRequestList,
  verifyGithubCompletion,
} from "../domain/github"
import type { IssueNumber } from "../domain/checkpoint"
import { asIssueNumber } from "../domain/checkpoint"
import type { AzureDeliveryScope } from "../domain/tracker"

export type GithubTrackerOptions = {
  readonly runner: CommandRunnerPort
  readonly git: GitPort
  readonly cwd: string
  readonly slug: string
  readonly ghPath?: string
}

export type GithubPreflightInput = {
  readonly runner: CommandRunnerPort
  readonly git: GitPort
  readonly cwd: string
  readonly docsPath?: string
  readonly ghPath?: string
}

export type GithubPreflightError =
  | { readonly kind: "gh_missing"; readonly message: string }
  | { readonly kind: "gh_auth_missing"; readonly message: string }
  | { readonly kind: "remote_ambiguous"; readonly message: string }
  | { readonly kind: "remote_unsupported"; readonly message: string }
  | { readonly kind: "remote_missing"; readonly message: string }
  | { readonly kind: "tracker_doc_missing"; readonly message: string }
  | { readonly kind: "tracker_doc_mismatch"; readonly message: string }
  | { readonly kind: "tracker_doc_no_gh"; readonly message: string }
  | { readonly kind: "command_failed"; readonly message: string }

export const defaultTrackerDocsPath = (cwd: string): string =>
  join(cwd, "docs", "agents", "issue-tracker.md")

const GH_REMOTE_PATTERNS: ReadonlyArray<RegExp> = [
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  /^http:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
]

export const parseGithubRemoteUrl = (url: string): { readonly owner: string; readonly repo: string } | null => {
  const trimmed = url.trim()
  for (const pattern of GH_REMOTE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match === null) continue
    const owner = match[1]
    const repo = match[2]
    if (owner === undefined || repo === undefined) continue
    if (owner.length === 0 || repo.length === 0) continue
    return { owner, repo }
  }
  return null
}

export const slugEquals = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

const readTextFile = async (input: {
  readonly runner: CommandRunnerPort
  readonly path: string
}): Promise<string> => {
  const result = await input.runner.spawn({
    program: "cat",
    args: [input.path],
    cwd: "/",
    env: {},
  })
  if (result.exitCode !== 0) {
    throw new Error(`unable to read ${input.path}: ${result.stderr.trim() || "exit " + result.exitCode}`)
  }
  return result.stdout
}

const fileExists = async (input: { readonly runner: CommandRunnerPort; readonly path: string }): Promise<boolean> => {
  try {
    const result = await input.runner.spawn({
      program: "test",
      args: ["-r", input.path],
      cwd: "/",
      env: {},
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

const runGh = async (
  options: GithubTrackerOptions,
  args: ReadonlyArray<string>,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> => {
  const program = options.ghPath ?? "gh"
  return options.runner.spawn({
    program,
    args,
    cwd: options.cwd,
    env: {
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      CLICOLOR: "0",
      ...(process.env["GH_HOST"] !== undefined ? { GH_HOST: process.env["GH_HOST"] } : {}),
    },
  })
}

type GithubRemoteInspection =
  | { readonly kind: "ok"; readonly slug: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "command_failed" }

const inspectGithubRemotes = async (input: {
  readonly runner: CommandRunnerPort
  readonly git: GitPort
  readonly cwd: string
}): Promise<GithubRemoteInspection> => {
  let remoteList: { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
  try {
    remoteList = await input.runner.spawn({
      program: "git",
      args: ["remote"],
      cwd: input.cwd,
      env: {},
    })
  } catch {
    return { kind: "command_failed" }
  }
  if (remoteList.exitCode !== 0) {
    return { kind: "command_failed" }
  }
  const remotes = remoteList.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (remotes.length === 0) return { kind: "missing" }
  const slugs: string[] = []
  for (const remote of remotes) {
    let urlResult: { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
    try {
      urlResult = await input.runner.spawn({
        program: "git",
        args: ["config", "--get", `remote.${remote}.url`],
        cwd: input.cwd,
        env: {},
      })
    } catch {
      return { kind: "command_failed" }
    }
    if (urlResult.exitCode !== 0) return { kind: "unsupported" }
    const parsed = parseGithubRemoteUrl(urlResult.stdout)
    if (parsed === null) return { kind: "unsupported" }
    slugs.push(`${parsed.owner}/${parsed.repo}`)
  }
  if (slugs.length === 0) return { kind: "missing" }
  const first = slugs[0]
  if (first === undefined) return { kind: "missing" }
  if (!slugs.every((slug) => slugEquals(slug, first))) return { kind: "ambiguous" }
  return { kind: "ok", slug: first }
}

export const detectGithubSlug = async (input: {
  readonly runner: CommandRunnerPort
  readonly git: GitPort
  readonly cwd: string
}): Promise<string | null> => {
  const inspection = await inspectGithubRemotes(input)
  return inspection.kind === "ok" ? inspection.slug : null
}

export const preflightGithubTracker = async (
  input: GithubPreflightInput,
): Promise<
  | { readonly kind: "ok"; readonly slug: string }
  | GithubPreflightError
> => {
  const ghPath = input.ghPath ?? "gh"
  let versionResult: { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
  try {
    versionResult = await input.runner.spawn({
      program: ghPath,
      args: ["--version"],
      cwd: input.cwd,
      env: {},
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: "gh_missing", message: `gh CLI is unavailable: ${message}` }
  }
  if (versionResult.exitCode !== 0) {
    return {
      kind: "gh_missing",
      message: `gh CLI is unavailable: ${versionResult.stderr.trim() || "exit " + versionResult.exitCode}`,
    }
  }

  let authResult: { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
  try {
    authResult = await input.runner.spawn({
      program: ghPath,
      args: ["auth", "status", "--hostname", "github.com"],
      cwd: input.cwd,
      env: {},
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: "gh_auth_missing", message: `gh CLI auth status failed: ${message}` }
  }
  if (authResult.exitCode !== 0) {
    const combined = `${authResult.stdout}\n${authResult.stderr}`.toLowerCase()
    if (combined.includes("not logged in") || combined.includes("no oauth token")) {
      return {
        kind: "gh_auth_missing",
        message: "gh CLI is not authenticated: run `gh auth login` before starting a worker",
      }
    }
    return {
      kind: "gh_auth_missing",
      message: `gh CLI auth status failed: ${(authResult.stderr || authResult.stdout).trim()}`,
    }
  }

  const remoteInspection = await inspectGithubRemotes({
    runner: input.runner,
    git: input.git,
    cwd: input.cwd,
  })
  if (remoteInspection.kind !== "ok") {
    switch (remoteInspection.kind) {
      case "missing":
        return { kind: "remote_missing", message: "no GitHub remote is configured for the current repository" }
      case "unsupported":
        return { kind: "remote_unsupported", message: "a repository remote is not a supported GitHub URL" }
      case "ambiguous":
        return { kind: "remote_ambiguous", message: "repository remotes resolve to different GitHub repositories" }
      case "command_failed":
        return { kind: "command_failed", message: "unable to inspect GitHub repository remotes" }
      default: {
        const exhaustive: never = remoteInspection
        throw new Error(`unhandled GitHub remote inspection: ${(exhaustive as { kind: string }).kind}`)
      }
    }
  }
  const slug = remoteInspection.slug

  const docsPath = input.docsPath ?? defaultTrackerDocsPath(input.cwd)
  const exists = await fileExists({ runner: input.runner, path: docsPath })
  if (!exists) {
    return {
      kind: "tracker_doc_missing",
      message: `tracker documentation is missing: ${docsPath}`,
    }
  }
  let docsBody: string
  try {
    docsBody = await readTextFile({ runner: input.runner, path: docsPath })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: "command_failed", message }
  }
  if (!docsBody.includes("# Issue Tracker: GitHub")) {
    return {
      kind: "tracker_doc_mismatch",
      message: `tracker documentation does not declare the GitHub tracker: ${docsPath}`,
    }
  }
  if (!docsBody.toLowerCase().includes("gh")) {
    return {
      kind: "tracker_doc_no_gh",
      message: `tracker documentation does not mention the gh CLI: ${docsPath}`,
    }
  }

  return { kind: "ok", slug }
}

export const createGithubTracker = (options: GithubTrackerOptions): TrackerPort => {
  const slug = options.slug

  const fetchIssueList = async (): Promise<ReadonlyArray<GithubIssue> | { readonly kind: "tracker_unreachable"; readonly message: string }> => {
    const result = await runGh(options, [
      "issue",
      "list",
      "--repo",
      slug,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,state,labels,assignees,issueType",
    ])
    if (result.exitCode !== 0) {
      return {
        kind: "tracker_unreachable",
        message: `gh issue list failed: ${(result.stderr || result.stdout).trim()}`,
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: "tracker_unreachable", message: `gh issue list produced invalid JSON: ${message}` }
    }
    if (!Array.isArray(parsed)) {
      return { kind: "tracker_unreachable", message: "gh issue list output was not an array" }
    }
    const issues: GithubIssue[] = []
    for (const entry of parsed) {
      const issue = parseGithubIssue(entry)
      if (issue === null) {
        return { kind: "tracker_unreachable", message: "gh issue list entry had an invalid shape" }
      }
      issues.push(issue)
    }
    return issues
  }

  const fetchBlockedByCount = async (issueNumber: IssueNumber): Promise<number | null> => {
    const result = await runGh(options, [
      "api",
      `repos/${slug}/issues/${issueNumber}/dependencies/blocked_by`,
      "--jq",
      "length",
    ])
    if (result.exitCode !== 0) {
      return null
    }
    const trimmed = result.stdout.trim()
    if (trimmed.length === 0) return 0
    const parsed = Number(trimmed)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
  }

  return {
    kind: "github",
    async selectEligibleIssue(_input): Promise<TrackerSelection> {
      const list = await fetchIssueList()
      if ("kind" in list) {
        return { kind: "blocked", reason: list.message }
      }
      for (const issue of list) {
        const blockedBy = await fetchBlockedByCount(issue.number as IssueNumber)
        if (blockedBy === null) {
          return { kind: "blocked", reason: `unable to read blockers for issue ${issue.number}` }
        }
        const decision = evaluateGithubEligibility({ issue, blockedByCount: blockedBy })
        if (decision.kind === "eligible") {
          return { kind: "selected", identity: { kind: "github", number: decision.issueNumber } }
        }
      }
      if (list.length === 0) {
        return { kind: "empty", reason: "no open issues returned by `gh issue list`" }
      }
      return { kind: "empty", reason: "no eligible issues found in the open queue" }
    },
    async claimIssue(input): Promise<void> {
      if (input.identity.kind !== "github") {
        throw new Error("claimIssue called with a non-GitHub identity")
      }
      const result = await runGh(options, [
        "issue",
        "edit",
        String(input.identity.number),
        "--repo",
        slug,
        "--add-assignee",
        "@me",
      ])
      if (result.exitCode !== 0) {
        throw new Error(
          `gh issue edit failed: ${(result.stderr || result.stdout).trim() || "exit " + result.exitCode}`,
        )
      }
    },
    async verifyCompletion(input): Promise<CompletionVerification> {
      if (input.identity.kind !== "github") {
        return { kind: "drift", identity: input.identity, details: "expected a GitHub identity" }
      }
      const issueResult = await runGh(options, [
        "issue",
        "view",
        String(input.identity.number),
        "--repo",
        slug,
        "--json",
        "number,state,title",
      ])
      if (issueResult.exitCode !== 0) {
        return {
          kind: "tracker_unreachable",
          identity: input.identity,
          error: `gh issue view failed: ${(issueResult.stderr || issueResult.stdout).trim()}`,
        }
      }
      if (issueResult.stdout.trim().length === 0) {
        return {
          kind: "tracker_unreachable",
          identity: input.identity,
          error: `gh issue view returned an empty body for issue ${input.identity.number}`,
        }
      }
      let issueJson: unknown
      try {
        issueJson = JSON.parse(issueResult.stdout)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: "tracker_unreachable",
          identity: input.identity,
          error: `gh issue view returned invalid JSON: ${message}`,
        }
      }
      const issue = parseGithubIssue(issueJson)
      if (issue === null) {
        return {
          kind: "tracker_unreachable",
          identity: input.identity,
          error: "gh issue view returned an unexpected shape",
        }
      }

      const prResult = await runGh(options, [
        "pr",
        "list",
        "--repo",
        slug,
        "--state",
        "all",
        "--head",
        input.branch,
        "--json",
        "number,state,mergedAt,baseRefName,headRefName,title",
      ])
      if (prResult.exitCode !== 0) {
        return {
          kind: "tracker_unreachable",
          identity: input.identity,
          error: `gh pr list failed: ${(prResult.stderr || prResult.stdout).trim()}`,
        }
      }
      let prJson: unknown
      try {
        prJson = JSON.parse(prResult.stdout)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: "tracker_unreachable",
          identity: input.identity,
          error: `gh pr list returned invalid JSON: ${message}`,
        }
      }
      const pullRequests = parseGithubPullRequestList(prJson)
      if (pullRequests === null) {
        return {
          kind: "tracker_unreachable",
          identity: input.identity,
          error: "gh pr list returned an unexpected shape",
        }
      }

      const completion = verifyGithubCompletion({
        issue,
        baseBranch: input.baseBranch,
        pullRequests,
      })
      return toCompletionVerification(input.identity, completion)
    },
    async closeIssue(input): Promise<void> {
      if (input.identity.kind !== "github") {
        throw new Error("closeIssue called with a non-GitHub identity")
      }
      const result = await runGh(options, ["issue", "close", String(input.identity.number), "--repo", slug])
      if (result.exitCode !== 0) {
        throw new Error(
          `gh issue close failed: ${(result.stderr || result.stdout).trim() || "exit " + result.exitCode}`,
        )
      }
    },
    async readEvidenceScope(): Promise<AzureDeliveryScope> {
      throw new Error("readEvidenceScope is not supported by the GitHub tracker")
    },
    async evidenceForCompletion(): Promise<void> {
      // GitHub completion verification derives its evidence from the PR and
      // issue state; no separate evidence artifact is required. The
      // operation is intentionally a no-op so the supervisor can still
      // call this port unconditionally on every tracker.
    },
  }
}

export const toCompletionVerification = (
  identity: TrackerIdentity,
  completion: GithubCompletion,
): CompletionVerification => {
  switch (completion.kind) {
    case "verified": {
      const evidence: CompletionEvidence = {
        kind: "github_pr_merged",
        prNumber: completion.prNumber,
        baseRef: completion.baseRef,
        mergedAt: completion.mergedAt,
      }
      return { kind: "verified", identity, evidence }
    }
    case "issue_still_open":
      return { kind: "issue_still_open", identity }
    case "no_attributable_pr":
      return { kind: "no_attributable_pr", identity }
    case "multiple_prs":
      return { kind: "multiple_prs", identity, count: completion.count }
    case "wrong_base_branch":
      return {
        kind: "wrong_base_branch",
        identity,
        expected: completion.expected,
        actual: completion.actual,
      }
    case "pr_unmerged":
      return { kind: "pr_unmerged", identity, prNumber: completion.prNumber }
    case "malformed":
      return { kind: "drift", identity, details: completion.reason }
    case "missing_issue_number":
      return { kind: "drift", identity, details: "issue number is missing or invalid" }
    default: {
      const exhaustive: never = completion
      throw new Error(`unhandled completion result: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}
