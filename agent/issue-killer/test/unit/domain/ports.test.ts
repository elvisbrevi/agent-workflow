import { describe, expect, test } from "bun:test"
import type {
  CheckpointStorePort,
  ClockPort,
  CommandRunnerPort,
  GitPort,
  HarnessLogPort,
  LockSnapshot,
  OpenCodeRuntimePort,
  ProfileCatalogPort,
  ProviderFailureClassifierPort,
  RepositoryLockPort,
  TerminalPort,
  TrackerPort,
} from "../../../src/domain/ports"
import { isCompletionVerified } from "../../../src/domain/tracker"
import { asHuNumber, asIssueNumber } from "../../../src/domain/checkpoint"
import { parseSessionId } from "../../../src/domain/session-id"

const issue91 = asIssueNumber(91)
if (issue91 === null) throw new Error("invalid issue for port test")
const hu1 = asHuNumber(1)
if (hu1 === null) throw new Error("invalid HU for port test")

const trackerPort: TrackerPort = {
  kind: "github",
  selectEligibleIssue: async () => ({ kind: "empty", reason: "no issues" }),
  verifyCompletion: async () => ({
    kind: "verified",
    identity: { kind: "github", number: issue91 },
    evidence: { kind: "github_pr_merged", prNumber: 1, baseRef: "main", mergedAt: "2026-08-06" },
  }),
  closeIssue: async () => undefined,
  readEvidenceScope: async () => ({
    hu: hu1,
    tickets: [],
    integrationBranch: "feature/hu",
    category: "feature",
  }),
  evidenceForCompletion: async () => undefined,
}

const clockPort: ClockPort = {
  now: () => "2026-08-06 12:00:00 +0000",
}

const commandPort: CommandRunnerPort = {
  spawn: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
}

const checkpointPort: CheckpointStorePort = {
  load: async () => null,
  save: async () => undefined,
  clear: async () => undefined,
}

const gitPort: GitPort = {
  commonDir: async () => "/.git",
  currentBranch: async () => "main",
  currentBaseSha: async () => "0123456789abcdef",
  worktreeIsClean: async () => true,
}

const lockSnapshot: LockSnapshot = {
  owner: { pid: 1, token: "tok", repository: "/repo", startedAt: "2026-08-06 12:00:00 +0000" },
  state: "starting",
  updatedAt: "2026-08-06 12:00:00 +0000",
}

const lockPort: RepositoryLockPort = {
  acquire: async () => ({ acquired: true }),
  release: async () => true,
  read: async () => lockSnapshot,
  isStale: async () => false,
  writeStatus: async () => undefined,
}

const session = parseSessionId("ses_port_test")
if (session === null) throw new Error("invalid session id for port test")

const runtimePort: OpenCodeRuntimePort = {
  host: "127.0.0.1",
  ephemeralPort: true,
  health: async () => ({ version: "1.18.14" }),
  createSession: async () => ({ sessionId: session, directory: "/repo" }),
  getSession: async () => ({ sessionId: session, directory: "/repo", title: "scaffold" }),
  abortSession: async () => undefined,
  deleteSession: async () => undefined,
  sendPrompt: async () => ({ runId: "run-1" }),
  subscribeEvents: async function* () {
    yield { type: "server.connected" }
  },
  close: async () => undefined,
}

const providerPort: ProviderFailureClassifierPort = {
  classify: () => "none",
  knownStatuses: new Set<number>([200, 400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504]),
}

const profilePort: ProfileCatalogPort = {
  resolveDefaultProfile: () => null,
  resolveProfile: () => null,
  listProfileNames: () => [],
}

const harnessPort: HarnessLogPort = {
  startRun: async () => undefined,
  appendEvent: async () => undefined,
  endRun: async () => undefined,
  readRunPath: () => "/tmp/run.jsonl",
}

const terminalPort: TerminalPort = {
  confirmDestructive: async () => false,
  selectProfile: async () => "opencode-main",
  isInteractive: () => false,
}

describe("ports shape", () => {
  test("verify that every port declared in src/domain/ports.ts matches its runtime signature", () => {
    expect(typeof trackerPort.selectEligibleIssue).toBe("function")
    expect(typeof trackerPort.verifyCompletion).toBe("function")
    expect(typeof trackerPort.closeIssue).toBe("function")
    expect(typeof trackerPort.readEvidenceScope).toBe("function")
    expect(typeof trackerPort.evidenceForCompletion).toBe("function")
    expect(trackerPort.kind).toBe("github")

    expect(typeof clockPort.now()).toBe("string")

    expect(typeof runtimePort.health).toBe("function")
    expect(runtimePort.host).toBe("127.0.0.1")
    expect(runtimePort.ephemeralPort).toBe(true)

    expect(typeof gitPort.commonDir).toBe("function")
    expect(typeof gitPort.currentBranch).toBe("function")
    expect(typeof gitPort.currentBaseSha).toBe("function")
    expect(typeof gitPort.worktreeIsClean).toBe("function")

    expect(typeof commandPort.spawn).toBe("function")

    expect(typeof checkpointPort.load).toBe("function")
    expect(typeof checkpointPort.save).toBe("function")
    expect(typeof checkpointPort.clear).toBe("function")

    expect(typeof lockPort.acquire).toBe("function")
    expect(typeof lockPort.release).toBe("function")
    expect(typeof lockPort.read).toBe("function")
    expect(typeof lockPort.isStale).toBe("function")
    expect(typeof lockPort.writeStatus).toBe("function")

    expect(providerPort.classify({ error: "boom" })).toBe("none")
    expect(providerPort.knownStatuses.has(429)).toBe(true)

    expect(Array.isArray(profilePort.listProfileNames())).toBe(true)
    expect(profilePort.resolveDefaultProfile({ defaultProfile: "opencode-main" })).toBeNull()

    expect(harnessPort.readRunPath({ runId: "run-1" })).toBe("/tmp/run.jsonl")

    expect(terminalPort.isInteractive()).toBe(false)
  })
})

describe("isCompletionVerified", () => {
  test("flags only the verified discriminator as successful", () => {
    const issue = asIssueNumber(91)
    if (issue === null) throw new Error("invalid issue")
    const identity = { kind: "github" as const, number: issue }
    expect(
      isCompletionVerified({
        kind: "verified",
        identity,
        evidence: { kind: "github_pr_merged", prNumber: 1, baseRef: "main", mergedAt: "2026-08-06" },
      }),
    ).toBe(true)
    expect(isCompletionVerified({ kind: "issue_still_open", identity })).toBe(false)
    expect(isCompletionVerified({ kind: "no_attributable_pr", identity })).toBe(false)
  })
})
