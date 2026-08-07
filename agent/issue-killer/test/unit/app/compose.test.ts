import { describe, expect, test } from "bun:test"
import type { CheckpointStorePort, LockOwner, RepositoryLockPort, TrackerPort, GitPort } from "../../../src/domain/ports"
import type { ExecutionProfile } from "../../../src/domain/execution-profile"
import type { TrackerSelection } from "../../../src/domain/tracker"
import { asIssueNumber, type Checkpoint } from "../../../src/domain/checkpoint"
import { runVerticalSlice, type SupervisorInput } from "../../../src/app/compose"

type TestInput = SupervisorInput & {
  readonly _test: { states: string[]; cleared: string[]; deleted: string[]; checkpointSnapshot: Checkpoint | null }
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

const makeInput = (overrides: Partial<SupervisorInput> = {}, initialBranch = "main"): TestInput => {
  const states: string[] = []
  const cleared: string[] = []
  const deleted: string[] = []
  let branch = initialBranch
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
    currentBranch: async () => branch,
    currentBaseSha: async () => "base-sha",
    worktreeIsClean: async () => true,
    createBranch: async ({ branch: value }) => { branch = value },
    checkoutBranch: async ({ branch: value }) => { branch = value },
  }
  let stored: Checkpoint | null = null
  const checkpoint: CheckpointStorePort = {
    load: async () => stored,
    save: async ({ checkpoint: value }) => { stored = value; states.push(value.state) },
    clear: async () => { cleared.push("clear"); stored = null },
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
    _test: { states, cleared, deleted, checkpointSnapshot: stored },
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

  test("an implementation failure never consumes a fallback profile", async () => {
    const attempts: string[] = []
    const input = makeInput({
      profile: { ...profile, fallbacks: ["backup"] },
      profiles: new Map([["backup", { ...profile, name: "backup", modelID: "backup-model" }]]),
      worker: async ({ profile: active }) => {
        attempts.push(active.name)
        throw new Error("assertion failure in worker")
      },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("FAILED")
    expect(attempts).toEqual(["main"])
    expect(input._test.cleared).toEqual([])
  })

  test("a restart restores the persisted fallback position", async () => {
    let persisted: Checkpoint | null = null
    const first = makeInput({
      profile: { ...profile, fallbacks: ["backup", "last"] },
      profiles: new Map([
        ["backup", { ...profile, name: "backup", modelID: "backup-model" }],
        ["last", { ...profile, name: "last", modelID: "last-model" }],
      ]),
      checkpoint: {
        load: async () => persisted,
        save: async ({ checkpoint: value }) => { persisted = value },
        clear: async () => undefined,
      },
      worker: async ({ profile: active, onSessionCaptured }) => {
        await onSessionCaptured("session-17" as never)
        if (active.name === "main") throw Object.assign(new Error("quota exhausted"), { status: 402 })
        throw Object.assign(new Error("another quota"), { status: 402 })
      },
    })
    await runVerticalSlice(first)
    if (persisted === null) throw new Error("expected fallback checkpoint to be persisted")
    const snapshot = persisted as Checkpoint

    const second = makeInput({
      profile: { ...profile, fallbacks: ["backup", "last"] },
      profiles: new Map([
        ["backup", { ...profile, name: "backup", modelID: "backup-model" }],
        ["last", { ...profile, name: "last", modelID: "last-model" }],
      ]),
      checkpoint: {
        load: async () => snapshot,
        save: async () => undefined,
        clear: async () => undefined,
      },
      worker: async ({ profile: active }) => {
        expect(active.name).toBe("last")
        throw Object.assign(new Error("last profile still unavailable"), { status: 402 })
      },
    }, "issue-17")
    const result = await runVerticalSlice(second)

    expect(result.status).toBe("RECOVERY_REQUIRED")
    expect(second._test.states).toContain("lock:fallback_in_progress")
  })

  test("legacy ambiguous recovery requires explicit adoptIssue", async () => {
    let stored: Checkpoint = {
      pid: 99,
      iteration: 1,
      identity: { kind: "unknown" },
      branch: "feature/stale",
      baseBranch: "main",
      baseSha: "deadbeef",
      profileName: "main",
      cli: "opencode",
      model: "provider/model",
      command: "opencode",
      fallbackChain: [],
      fallbackRemaining: [],
      fallbackPosition: 0,
      state: "mutating",
      updatedAt: "2026-08-07T00:00:00Z",
      formatVersion: 2,
    }
    const input = makeInput({
      checkpoint: {
        load: async () => stored,
        save: async ({ checkpoint: value }) => { stored = value },
        clear: async () => undefined,
      },
    })

    const without = await runVerticalSlice(input)
    expect(without.status).toBe("RECOVERY_REQUIRED")
    expect(without.reason).toMatch(/checkpoint identity is ambiguous/)

    let adopted: Checkpoint = {
      ...stored,
      identity: { kind: "github", number: issue },
      branch: "main",
      baseSha: "base-sha",
    }
    const adoptInput = makeInput({
      adoptIssue: { kind: "github", number: issue },
      checkpoint: {
        load: async () => adopted,
        save: async ({ checkpoint: value }) => { adopted = value },
        clear: async () => undefined,
      },
    })
    const withAdopt = await runVerticalSlice(adoptInput)
    expect(withAdopt.status).toBe("ISSUE_COMPLETED")
  })

  test("a quota fallback reuses the captured session and switches model", async () => {
    const seen: Array<{ model: string; sessionId: string | undefined }> = []
    const input = makeInput({
      profile: { ...profile, fallbacks: ["backup"] },
      profiles: new Map([["backup", { ...profile, name: "backup", modelID: "backup-model" }]]),
      worker: async ({ profile: active, resumeSessionId, onSessionCaptured }) => {
        if (active.name === "main") {
          await onSessionCaptured("session-17" as never)
          throw Object.assign(new Error("quota exhausted"), { status: 402 })
        }
        seen.push({ model: active.modelID, sessionId: resumeSessionId })
        return { sessionId: "session-17" as never, outcome: { status: "ISSUE_COMPLETED", issue: 17, summary: "done" } }
      },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("ISSUE_COMPLETED")
    expect(seen).toEqual([{ model: "backup-model", sessionId: "session-17" }])
  })

  test("retries transport failures before consuming the fallback chain", async () => {
    const attempts: string[] = []
    let failures = 0
    const input = makeInput({
      profile: { ...profile, fallbacks: ["backup"] },
      profiles: new Map([["backup", { ...profile, name: "backup", modelID: "backup-model" }]]),
      retryDelaysMs: [0],
      sleep: async () => undefined,
      worker: async ({ profile: active }) => {
        attempts.push(active.name)
        if (failures++ === 0) throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
        return { sessionId: "session-17" as never, outcome: { status: "ISSUE_COMPLETED", issue: 17, summary: "done" } }
      },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("ISSUE_COMPLETED")
    expect(attempts).toEqual(["main", "main"])
  })

  test("consumes fallbacks in order after an eligible provider failure", async () => {
    const attempts: string[] = []
    const input = makeInput({
      profile: { ...profile, fallbacks: ["backup", "last"] },
      profiles: new Map([
        ["backup", { ...profile, name: "backup", modelID: "backup-model" }],
        ["last", { ...profile, name: "last", modelID: "last-model" }],
      ]),
      worker: async ({ profile: active }) => {
        attempts.push(active.name)
        if (active.name !== "last") throw Object.assign(new Error("quota exhausted"), { status: 402 })
        return { sessionId: "session-17" as never, outcome: { status: "ISSUE_COMPLETED", issue: 17, summary: "done" } }
      },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("ISSUE_COMPLETED")
    expect(attempts).toEqual(["main", "backup", "last"])
  })

  test("exhausted eligible fallbacks retain recovery state and do not advance", async () => {
    const input = makeInput({
      profile: { ...profile, fallbacks: ["backup"] },
      profiles: new Map([["backup", { ...profile, name: "backup", modelID: "backup-model" }]]),
      worker: async () => { throw Object.assign(new Error("quota exhausted"), { status: 402 }) },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("RECOVERY_REQUIRED")
    expect(input._test.cleared).toEqual([])
    expect(input._test.states).toContain("fallback_in_progress")
  })

  test("reuses the captured session when a fallback is selected", async () => {
    const resumed: Array<string | undefined> = []
    const input = makeInput({
      profile: { ...profile, fallbacks: ["backup"] },
      profiles: new Map([["backup", { ...profile, name: "backup", modelID: "backup-model" }]]),
      worker: async ({ profile: active, resumeSessionId, onSessionCaptured }) => {
        resumed.push(resumeSessionId)
        await onSessionCaptured("session-17" as never)
        if (active.name === "main") throw Object.assign(new Error("quota exhausted"), { status: 402 })
        return { sessionId: "session-17" as never, outcome: { status: "ISSUE_COMPLETED", issue: 17, summary: "done" } }
      },
    })

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("ISSUE_COMPLETED")
    expect(resumed).toEqual([undefined, "session-17"])
  })

  test("rejects fallback configuration drift during restart recovery", async () => {
    const stored: Checkpoint = {
      pid: 99,
      iteration: 1,
      identity: { kind: "github", number: issue },
      branch: "issue-17",
      baseBranch: "main",
      baseSha: "base-sha",
      profileName: "main",
      cli: "opencode",
      model: "provider/model",
      command: "opencode",
      selectedProfile: "backup",
      fallbackChain: ["backup"],
      fallbackRemaining: [],
      fallbackPosition: 1,
      nextProfile: "backup",
      state: "fallback_in_progress",
      updatedAt: "2026-08-07T00:00:00Z",
      formatVersion: 2,
    }
    const input = makeInput({
      profile: { ...profile, fallbacks: ["different"] },
      profiles: new Map([[
        "different",
        { ...profile, name: "different", modelID: "different-model" },
      ]]),
      checkpoint: {
        load: async () => stored,
        save: async () => undefined,
        clear: async () => undefined,
      },
    }, "issue-17")

    const result = await runVerticalSlice(input)

    expect(result.status).toBe("RECOVERY_REQUIRED")
    expect(result.reason).toMatch(/configuration drift|fallback chain drift/)
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
