import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunCommandRunner } from "../../src/system/command"
import type { CommandRunnerPort } from "../../src/domain/ports"
import {
  createGithubTracker,
  detectGithubSlug,
  parseGithubRemoteUrl,
  preflightGithubTracker,
  slugEquals,
  toCompletionVerification,
} from "../../src/tracker/github"
import { systemGitPort } from "../../src/system/git"
import type { TrackerSelection, CompletionVerification, TrackerIdentity } from "../../src/domain/tracker"
import { asIssueNumber } from "../../src/domain/checkpoint"

type StubbedGh = {
  readonly binDir: string
  readonly logPath: string
  readonly calls: () => Promise<ReadonlyArray<string>>
  setResponse(argKey: string, response: unknown): Promise<void>
  setError(argKey: string, stderr: string, exitCode?: number): void
  setRawResponse(argKey: string, response: string): void
  reset(): Promise<void>
}

const buildStubGh = async (): Promise<StubbedGh> => {
  const binDir = await mkdtemp(join(tmpdir(), "ik-gh-stub-"))
  const logPath = join(binDir, "calls.log")
  const statePath = join(binDir, "state.json")
  await writeFile(statePath, JSON.stringify({ responses: {}, errors: {}, raw: {} }), "utf8")
  await writeFile(logPath, "", "utf8")
  const script = `#!/usr/bin/env bash
LOG="${logPath}"
STATE="${statePath}"
printf '%s\\\\n' "$*" >> "$LOG"
key="$1"
shift
case "$key" in
  --version)
    printf 'gh version 2.96.0 (fixture)\\\\n'
    exit 0
    ;;
  auth)
    sub="$1"
    if [ "$sub" = "status" ]; then
      printf 'Logged in to github.com account fixture\\\\n'
      exit 0
    fi
    exit 1
    ;;
  api)
    target=""
    for arg in "$@"; do
      case "$arg" in
        repos/*/issues/*/dependencies/blocked_by) target="$arg" ;;
      esac
    done
    payload=$(jq -r --arg k "$target" '.responses[$k] // "0"' "$STATE")
    printf '%s' "$payload"
    exit 0
    ;;
  issue)
    sub="$1"
    shift
    case "$sub" in
      list)
        err=$(jq -r '.errors["issue list"] // empty' "$STATE")
        if [ -n "$err" ]; then
          printf '%s' "$err" 1>&2
          exit 1
        fi
        payload=$(jq -r '.responses["issue list"] // "[]"' "$STATE")
        printf '%s' "$payload"
        exit 0
        ;;
      view)
        number="$1"
        payload=$(jq -r --arg n "$number" '.responses["issue view " + $n] // empty' "$STATE")
        err=$(jq -r --arg n "$number" '.errors["issue view " + $n] // empty' "$STATE")
        if [ -n "$err" ]; then
          printf '%s' "$err" 1>&2
          exit 1
        fi
        printf '%s' "$payload"
        exit 0
        ;;
      close)
        number="$1"
        err=$(jq -r --arg n "$number" '.errors["issue close " + $n] // empty' "$STATE")
        if [ -n "$err" ]; then
          printf '%s' "$err" 1>&2
          exit 1
        fi
        printf 'closed %s\\\\n' "$number"
        exit 0
        ;;
      edit)
        number="$1"
        err=$(jq -r --arg n "$number" '.errors["issue edit " + $n] // empty' "$STATE")
        if [ -n "$err" ]; then
          printf '%s' "$err" 1>&2
          exit 1
        fi
        printf 'claimed %s\\n' "$number"
        exit 0
        ;;
    esac
    ;;
  pr)
    sub="$1"
    case "$sub" in
      list)
        payload=$(jq -r '.responses["pr list"] // "[]"' "$STATE")
        printf '%s' "$payload"
        exit 0
        ;;
    esac
    ;;
esac
`
  await writeFile(join(binDir, "gh"), script, "utf8")
  await Bun.$`chmod +x ${join(binDir, "gh")}`.quiet()
  return {
    binDir,
    logPath,
    calls: async (): Promise<ReadonlyArray<string>> => {
      try {
        const text = await readFile(logPath, "utf8")
        return text.split("\\n").filter((line) => line.length > 0)
      } catch {
        return []
      }
    },
    setResponse(argKey, response) {
      return stateUpdate(statePath, (state) => {
        state.responses ??= {}
        const value =
          typeof response === "string" ? response : JSON.stringify(response)
        state.responses[argKey] = value
      })
    },
    setError(argKey, stderr, exitCode = 1) {
      return stateUpdate(statePath, (state) => {
        state.errors ??= {}
        state.errors[argKey] = stderr
        state.exitCodes ??= {}
        state.exitCodes[argKey] = exitCode
      })
    },
    setRawResponse(argKey, response) {
      return stateUpdate(statePath, (state) => {
        state.raw ??= {}
        state.raw[argKey] = response
      })
    },
    async reset() {
      await writeFile(logPath, "", "utf8")
      await writeFile(statePath, JSON.stringify({ responses: {}, errors: {} }), "utf8")
    },
  }
}

const stateUpdate = async (
  path: string,
  update: (state: { responses?: Record<string, string>; errors?: Record<string, string>; exitCodes?: Record<string, number>; raw?: Record<string, string> }) => void,
): Promise<void> => {
  const current = JSON.parse(await readFile(path, "utf8"))
  update(current)
  await writeFile(path, JSON.stringify(current), "utf8")
}

const setupRepo = async (cwd: string): Promise<void> => {
  const runner = bunCommandRunner()
  const run = async (args: ReadonlyArray<string>): Promise<void> => {
    const result = await runner.spawn({ program: "git", args, cwd, env: {} })
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
    }
  }
  await run(["init", "--quiet", "--initial-branch=main", cwd])
  await run(["config", "user.email", "test@example.com"])
  await run(["config", "user.name", "Issue Killer Test"])
  await run(["config", "commit.gpgsign", "false"])
  await writeFile(join(cwd, "README.md"), "hello\\n", "utf8")
  await run(["add", "README.md"])
  await run(["commit", "--quiet", "-m", "init"])
  await run(["remote", "add", "origin", "https://github.com/example/fixture.git"])
}

const stubIssue = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 91,
  title: "issue-killer V2 fixture",
  state: "OPEN",
  labels: [{ name: "enhancement" }, { name: "ready-for-agent" }],
  assignees: [],
  issueType: { name: "Feature" },
  ...overrides,
})

const stubPr = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  state: "MERGED",
  mergedAt: "2026-08-06T10:00:00Z",
  baseRefName: "main",
  headRefName: "issue-91",
  ...overrides,
})

let stub: StubbedGh
let runner: CommandRunnerPort
let cwd: string
let cleanupRoot: string

beforeAll(async () => {
  stub = await buildStubGh()
  cleanupRoot = await mkdtemp(join(tmpdir(), "ik-int-github-"))
  cwd = join(cleanupRoot, "repo")
  await mkdir(cwd, { recursive: true })
  await setupRepo(cwd)
  await mkdir(join(cwd, "docs", "agents"), { recursive: true })
  await writeFile(
    join(cwd, "docs", "agents", "issue-tracker.md"),
    "# Issue Tracker: GitHub\\n\\nUse the `gh` CLI for all operations.\\n",
    "utf8",
  )
  process.env["PATH"] = `${stub.binDir}:${process.env["PATH"] ?? ""}`
  runner = bunCommandRunner()
})

afterAll(async () => {
  if (cleanupRoot) {
    await rm(cleanupRoot, { recursive: true, force: true })
  }
})

describe("parseGithubRemoteUrl", () => {
  test("recognizes https, ssh, and git@ forms", () => {
    expect(parseGithubRemoteUrl("https://github.com/example/fixture.git")).toEqual({
      owner: "example",
      repo: "fixture",
    })
    expect(parseGithubRemoteUrl("git@github.com:example/fixture.git")).toEqual({
      owner: "example",
      repo: "fixture",
    })
    expect(parseGithubRemoteUrl("ssh://git@github.com/example/fixture")).toEqual({
      owner: "example",
      repo: "fixture",
    })
  })

  test("rejects non-GitHub hosts", () => {
    expect(parseGithubRemoteUrl("https://gitlab.com/example/fixture.git")).toBeNull()
    expect(parseGithubRemoteUrl("not a url")).toBeNull()
  })

  test("slugEquals is case-insensitive", () => {
    expect(slugEquals("Example/Foo", "example/foo")).toBe(true)
    expect(slugEquals("Example/Foo", "example/bar")).toBe(false)
  })
})

describe("detectGithubSlug", () => {
  test("reads a single GitHub remote", async () => {
    const slug = await detectGithubSlug({ runner, git: systemGitPort({ runner }), cwd })
    expect(slug).toBe("example/fixture")
  })
})

describe("preflightGithubTracker", () => {
  test("passes with stubbed gh and a valid doc", async () => {
    const result = await preflightGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      ghPath: "gh",
    })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.slug).toBe("example/fixture")
    }
  })

  test("fails when gh is missing", async () => {
    const result = await preflightGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      ghPath: "gh-does-not-exist",
    })
    expect(result.kind).toBe("gh_missing")
  })

  test("rejects an unsupported remote instead of treating it as missing", async () => {
    const fakeRunner: CommandRunnerPort = {
      spawn: async (input) => {
        if (input.program === "gh" && input.args[0] === "--version") {
          return { stdout: "gh version fixture", stderr: "", exitCode: 0 }
        }
        if (input.program === "gh" && input.args[0] === "auth") {
          return { stdout: "logged in", stderr: "", exitCode: 0 }
        }
        if (input.program === "git" && input.args[0] === "remote") {
          return { stdout: "origin\n", stderr: "", exitCode: 0 }
        }
        if (input.program === "git" && input.args[0] === "config") {
          return { stdout: "https://gitlab.com/example/fixture.git\n", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "", exitCode: 1 }
      },
    }
    const result = await preflightGithubTracker({
      runner: fakeRunner,
      git: systemGitPort({ runner: fakeRunner }),
      cwd,
      ghPath: "gh",
    })
    expect(result.kind).toBe("remote_unsupported")
  })

  test("rejects remotes that resolve to different GitHub repositories", async () => {
    const fakeRunner: CommandRunnerPort = {
      spawn: async (input) => {
        if (input.program === "gh" && input.args[0] === "--version") {
          return { stdout: "gh version fixture", stderr: "", exitCode: 0 }
        }
        if (input.program === "gh" && input.args[0] === "auth") {
          return { stdout: "logged in", stderr: "", exitCode: 0 }
        }
        if (input.program === "git" && input.args[0] === "remote") {
          return { stdout: "origin\nupstream\n", stderr: "", exitCode: 0 }
        }
        if (input.program === "git" && input.args[0] === "config") {
          return input.args[2] === "remote.origin.url"
            ? { stdout: "https://github.com/example/fixture.git\n", stderr: "", exitCode: 0 }
            : { stdout: "https://github.com/example/other.git\n", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "", exitCode: 1 }
      },
    }
    const result = await preflightGithubTracker({
      runner: fakeRunner,
      git: systemGitPort({ runner: fakeRunner }),
      cwd,
      ghPath: "gh",
    })
    expect(result.kind).toBe("remote_ambiguous")
  })
})

describe("GitHub tracker adapter", () => {
  test("selectEligibleIssue pins exactly one eligible open issue", async () => {
    await stub.reset()
    const issueList = JSON.stringify([
      {
        number: 1,
        title: "epic label",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }, { name: "epic" }],
        assignees: [],
        issueType: { name: "Feature" },
      },
      {
        number: 2,
        title: "ready and assigned",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        assignees: [{ login: "someone" }],
        issueType: { name: "Feature" },
      },
      {
        number: 3,
        title: "ready and eligible",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        assignees: [],
        issueType: { name: "Feature" },
      },
    ])
    await stub.setResponse("issue list", issueList)
    await stub.setResponse("repos/example/fixture/issues/1/dependencies/blocked_by", "0")
    await stub.setResponse("repos/example/fixture/issues/2/dependencies/blocked_by", "0")
    await stub.setResponse("repos/example/fixture/issues/3/dependencies/blocked_by", "0")

    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })

    const selection: TrackerSelection = await adapter.selectEligibleIssue({
      baseBranch: "main",
      currentState: "starting",
    })
    expect(selection.kind).toBe("selected")
    if (selection.kind === "selected") {
      const expected = asIssueNumber(3)
      if (expected === null) throw new Error("expected issue number")
      expect(selection.identity).toEqual({ kind: "github", number: expected })
    }
  })

  test("selectEligibleIssue returns empty when nothing matches", async () => {
    await stub.reset()
    const issueList = JSON.stringify([
      {
        number: 1,
        title: "epic label",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }, { name: "epic" }],
        assignees: [],
        issueType: { name: "Feature" },
      },
    ])
    await stub.setResponse("issue list", issueList)
    await stub.setResponse("repos/example/fixture/issues/1/dependencies/blocked_by", "0")

    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const selection: TrackerSelection = await adapter.selectEligibleIssue({
      baseBranch: "main",
      currentState: "starting",
    })
    expect(selection.kind).toBe("empty")
  })

  test("selectEligibleIssue reports blocked on gh error", async () => {
    await stub.reset()
    await stub.setError("issue list", "API rate limit exceeded", 1)
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const selection: TrackerSelection = await adapter.selectEligibleIssue({
      baseBranch: "main",
      currentState: "starting",
    })
    expect(selection.kind).toBe("blocked")
  })

test("verifyCompletion returns verified for a merged PR into the configured base", async () => {
    await stub.reset()
    await stub.setResponse("issue view 91", stubIssue({ number: 91, state: "CLOSED" }))
    await stub.setResponse("pr list", JSON.stringify([stubPr({ number: 7, mergedAt: "2026-08-06T10:00:00Z", baseRefName: "main" })]))

    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })

    const result: CompletionVerification = await adapter.verifyCompletion({
      identity: { kind: "github", number: 91 as never },
      branch: "issue-91",
      baseBranch: "main",
    })
    expect(result.kind).toBe("verified")
    if (result.kind === "verified") {
      expect(result.evidence.kind).toBe("github_pr_merged")
    }
  })

  test("verifyCompletion returns issue_still_open when the issue is open", async () => {
    await stub.reset()
    await stub.setResponse("issue view 91", stubIssue({ state: "OPEN" }))
    await stub.setResponse("pr list", JSON.stringify([stubPr({ number: 7, mergedAt: "2026-08-06T10:00:00Z", baseRefName: "main" })]))

    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const result = await adapter.verifyCompletion({
      identity: { kind: "github", number: 91 as never },
      branch: "issue-91",
      baseBranch: "main",
    })
    expect(result.kind).toBe("issue_still_open")
  })

  test("verifyCompletion returns no_attributable_pr when no PR exists", async () => {
    await stub.reset()
    await stub.setResponse("issue view 91", stubIssue({ state: "CLOSED" }))
    await stub.setResponse("pr list", "[]")

    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const result = await adapter.verifyCompletion({
      identity: { kind: "github", number: 91 as never },
      branch: "issue-91",
      baseBranch: "main",
    })
    expect(result.kind).toBe("no_attributable_pr")
  })

  test("verifyCompletion returns multiple_prs when more than one PR has mergedAt", async () => {
    await stub.reset()
    await stub.setResponse("issue view 91", stubIssue({ state: "CLOSED" }))
    await stub.setResponse(
      "pr list",
      JSON.stringify([
        stubPr({ number: 7, mergedAt: "2026-08-01T00:00:00Z" }),
        stubPr({ number: 8, mergedAt: "2026-08-02T00:00:00Z" }),
      ]),
    )
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const result = await adapter.verifyCompletion({
      identity: { kind: "github", number: 91 as never },
      branch: "issue-91",
      baseBranch: "main",
    })
    expect(result.kind).toBe("multiple_prs")
    if (result.kind === "multiple_prs") {
      expect(result.count).toBe(2)
    }
  })

  test("verifyCompletion returns wrong_base_branch when PR targets a different base", async () => {
    await stub.reset()
    await stub.setResponse("issue view 91", stubIssue({ state: "CLOSED" }))
    await stub.setResponse("pr list", JSON.stringify([stubPr({ baseRefName: "develop" })]))
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const result = await adapter.verifyCompletion({
      identity: { kind: "github", number: 91 as never },
      branch: "issue-91",
      baseBranch: "main",
    })
    expect(result.kind).toBe("wrong_base_branch")
    if (result.kind === "wrong_base_branch") {
      expect(result.expected).toBe("main")
      expect(result.actual).toBe("develop")
    }
  })

  test("verifyCompletion returns tracker_unreachable when gh fails", async () => {
    await stub.reset()
    await stub.setError("issue view 91", "API rate limit exceeded", 1)
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const result = await adapter.verifyCompletion({
      identity: { kind: "github", number: 91 as never },
      branch: "issue-91",
      baseBranch: "main",
    })
    expect(result.kind).toBe("tracker_unreachable")
  })

  test("verifyCompletion rejects a response for a different issue", async () => {
    await stub.reset()
    await stub.setResponse("issue view 91", stubIssue({ number: 92, state: "CLOSED" }))
    await stub.setResponse("pr list", JSON.stringify([stubPr()]))
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const result = await adapter.verifyCompletion({
      identity: { kind: "github", number: 91 as never },
      branch: "issue-91",
      baseBranch: "main",
    })
    expect(result.kind).toBe("drift")
  })

  test("verifyCompletion rejects mismatched tracker identity kinds", async () => {
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    const result = await adapter.verifyCompletion({
      identity: { kind: "azure_ticket", hu: 1 as never, ticket: 2 as never },
      branch: "any",
      baseBranch: "main",
    })
    expect(result.kind).toBe("drift")
  })

  test("closeIssue delegates to gh issue close and records the call", async () => {
    await stub.reset()
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    await adapter.closeIssue({ identity: { kind: "github", number: 91 as never } })
    const calls = await stub.calls()
    expect(calls.some((line) => line.startsWith("issue close 91"))).toBe(true)
  })

  test("claimIssue delegates to gh issue edit with the current user", async () => {
    await stub.reset()
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    await adapter.claimIssue({ identity: { kind: "github", number: 91 as never } })
    const calls = await stub.calls()
    expect(
      calls.some(
        (line) =>
          line.startsWith("issue edit 91") &&
          line.includes("--repo example/fixture") &&
          line.includes("--add-assignee @me"),
      ),
    ).toBe(true)
  })

  test("closeIssue surfaces gh failures", async () => {
    await stub.reset()
    await stub.setError("issue close 91", "permission denied", 1)
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    await expect(
      adapter.closeIssue({ identity: { kind: "github", number: 91 as never } }),
    ).rejects.toThrow(/gh issue close failed/)
  })

  test("evidenceForCompletion is a no-op on GitHub", async () => {
    const adapter = createGithubTracker({
      runner,
      git: systemGitPort({ runner }),
      cwd,
      slug: "example/fixture",
    })
    await expect(
      adapter.evidenceForCompletion({
        identity: { kind: "github", number: 91 as never },
        evidence: {
          kind: "github_pr_merged",
          prNumber: 7,
          baseRef: "main",
          mergedAt: "2026-08-06T10:00:00Z",
        },
      }),
    ).resolves.toBeUndefined()
  })
})

describe("toCompletionVerification", () => {
  test("maps every domain completion result", () => {
    const issueNumber = asIssueNumber(91)
    if (issueNumber === null) throw new Error("expected valid identity")
    const identity: TrackerIdentity = { kind: "github", number: issueNumber }
    expect(
      toCompletionVerification(identity, {
        kind: "verified",
        issueNumber,
        prNumber: 7,
        baseRef: "main",
        mergedAt: "x",
      }).kind,
    ).toBe("verified")
    expect(
      toCompletionVerification(identity, {
        kind: "issue_still_open",
        issueNumber,
      }).kind,
    ).toBe("issue_still_open")
    expect(
      toCompletionVerification(identity, {
        kind: "no_attributable_pr",
        issueNumber,
      }).kind,
    ).toBe("no_attributable_pr")
    expect(
      toCompletionVerification(identity, {
        kind: "multiple_prs",
        issueNumber,
        count: 3,
      }).kind,
    ).toBe("multiple_prs")
    expect(
      toCompletionVerification(identity, {
        kind: "pr_unmerged",
        issueNumber,
        prNumber: 9,
      }).kind,
    ).toBe("pr_unmerged")
    expect(
      toCompletionVerification(identity, {
        kind: "wrong_base_branch",
        issueNumber,
        prNumber: 9,
        expected: "main",
        actual: "develop",
      }).kind,
    ).toBe("wrong_base_branch")
    expect(
      toCompletionVerification(identity, {
        kind: "malformed",
        reason: "x",
      }).kind,
    ).toBe("drift")
    expect(
      toCompletionVerification(identity, {
        kind: "missing_issue_number",
      }).kind,
    ).toBe("drift")
  })
})
