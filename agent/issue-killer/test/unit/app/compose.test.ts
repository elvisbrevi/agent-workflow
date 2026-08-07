import { describe, expect, test } from "bun:test"
import type { CheckpointStorePort, LockOwner, RepositoryLockPort, TrackerPort, GitPort } from "../../../src/domain/ports"
import type { ExecutionProfile } from "../../../src/domain/execution-profile"
import type { TrackerSelection } from "../../../src/domain/tracker"
import { asIssueNumber } from "../../../src/domain/checkpoint"
import { runVerticalSlice, type SupervisorInput } from "../../../src/app/compose"

type TestInput = SupervisorInput & {
  readonly _test: { states: string[]; cleared: string[]; deleted: string[] }
}

const profile: ExecutionProfile = {
  name: "main",
  label: "Main",
  cli: "opencode",
  command: "opencode",
  providerID: "provider",
  modelID: "model",
  autoApprove: true,
  options: {},
  fallbacks: [],
}

const issue = asIssueNumber(17)
if (issue === null) throw new Error("test issue number is invalid")

const makeInput = (overrides: Partial<SupervisorInput> = {}): TestInput => {
  const states: string[] = []
  const cleared: string[] = []
  const deleted: string[] = []
  const selections: TrackerSelection[] = [{ kind: "selected", identity: { kind: "github", number: issue } }]
  const tracker: TrackerPort = {
    kind: "github",
    selectEligibleIssue: async () => selections.shift() ?? { kind: "empty", reason: "fixture queue empty" },
    claimIssue: async () => undefined,
    verifyCompletion: async () => ({
      kind: "verified",
      identity: { kind: "github", number: issue },
      evidence: { kind: "github_pr_merged", prNumber: 42, baseRef: "main", mergedAt: "2026-08-07T00:00:00Z" },
    }),
    closeIssue: async () => undefined,
    readEvidenceScope: async () => { throw new Error("not used") },
    evidenceForCompletion: async () => undefined,
  }
  const git: GitPort = {
    commonDir: async () => "/repo/.git",
    currentBranch: async () => "issue-17",
    currentBaseSha: async () => "base-sha",
    worktreeIsClean: async () => true,
  }
  const checkpoint: CheckpointStorePort = {
    load: async () => null,
    save: async ({ checkpoint: value }) => { states.push(value.state) },
    clear: async () => { cleared.push("clear") },
  }
  const lock: RepositoryLockPort = {
    acquire: async () => ({ acquired: true }),
    release: async () => true,
    read: async () => null,
    isStale: async () => false,
    writeStatus: async ({ status }) => { states.push(`lock:${status}`) },
  }
  const owner: LockOwner = { pid: 123, token: "token", repository: "/repo", startedAt: "2026-08-07T00:00:00Z" }
  return {
    directory: "/repo",
    baseBranch: "main",
    profile,
    iterationLimit: 1,
    runnerName: "issue-killer",
    owner,
    tracker,
    git,
    checkpoint,
    lock,
    now: () => "2026-08-07T00:00:00Z",
    worker: async () => ({
      sessionId: "session-17" as never,
      outcome: { status: "ISSUE_COMPLETED", issue: 17, summary: "done" },
    }),
    deleteSession: async ({ sessionId }) => { deleted.push(sessionId) },
    ...overrides,
    _test: { states, cleared, deleted },
  } as TestInput
}

describe("runVerticalSlice", () => {
  test("clears the checkpoint and deletes the session only after verified completion", async () => {
    const input = makeInput()
    const result = await runVerticalSlice(input)

    expect(result.status).toBe("ISSUE_COMPLETED")
    expect(result.exitCode).toBe(3)
    expect(input._test.deleted).toEqual(["session-17"])
    expect(input._test.cleared).toEqual(["clear"])
    expect(input._test.states).toContain("verified")
  })

  test("does not advance after a false completion", async () => {
    const input = makeInput({
      tracker: {
        ...makeInput().tracker,
        verifyCompletion: async ({ identity }) => ({ kind: "no_attributable_pr", identity }),
        selectEligibleIssue: async () => ({ kind: "selected", identity: { kind: "github", number: issue } }),
      },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("RECOVERY_REQUIRED")
    expect(input._test.deleted).toEqual([])
    expect(input._test.cleared).toEqual([])
  })

  test("emits idle heartbeats without adding concurrent status writes", async () => {
    let heartbeats = 0
    const input = makeInput({
      progressIntervalSeconds: 0.001,
      onHeartbeat: () => { heartbeats += 1 },
      worker: async () => {
        await new Promise((resolve) => setTimeout(resolve, 8))
        return {
          sessionId: "session-17" as never,
          outcome: { status: "BLOCKED", issue: 17, summary: "needs input" },
        }
      },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("BLOCKED")
    expect(heartbeats).toBeGreaterThan(0)
    expect(input._test.states.filter((state) => state.startsWith("lock:")).length).toBeGreaterThan(0)
  })
})
