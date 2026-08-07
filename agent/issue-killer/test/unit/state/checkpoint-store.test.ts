import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { asIssueNumber, emptyCheckpoint, CHECKPOINT_FORMAT_VERSION } from "../../../src/domain/checkpoint"
import { parseSessionId } from "../../../src/domain/session-id"
import {
  CheckpointValidationError,
  buildCheckpoint,
  fileCheckpointStore,
  parseCheckpointText,
  parseCheckpointTextStrict,
  serializeCheckpoint,
  validateRawCheckpoint,
} from "../../../src/state/checkpoint-store"
import { systemClock } from "../../../src/system/clock"

const fixedClock = systemClock({ now: () => new Date("2026-08-06T10:30:45Z") })

const checkpointBase = emptyCheckpoint({
  pid: 4321,
  iteration: 7,
  branch: "feature/issue-81",
  baseBranch: "main",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  profileName: "opencode-main",
  cli: "opencode",
  model: "provider/model",
  command: "opencode",
  state: "starting",
  updatedAt: "2026-08-06 10:00:00 +0000",
})

const sampleGithub = () => {
  const number = asIssueNumber(81)
  if (number === null) throw new Error("expected issue 81 to be valid")
  return {
    ...checkpointBase,
    identity: { kind: "github" as const, number },
    branch: "feature/81-state-primitives",
  }
}

describe("validateRawCheckpoint", () => {
  test("accepts the full allowlisted key set", () => {
    const session = parseSessionId("ses_abc123-xyz")
    if (session === null) throw new Error("invalid session for fixture")
    const entries = [
      { key: "pid" as const, value: "1234" },
      { key: "iteration" as const, value: "3" },
      { key: "issue" as const, value: "81" },
      { key: "branch" as const, value: "feature/81" },
      { key: "base_branch" as const, value: "main" },
      { key: "base_sha" as const, value: "0123456789abcdef0123456789abcdef01234567" },
      { key: "profile" as const, value: "opencode-main" },
      { key: "cli" as const, value: "opencode" },
      { key: "model" as const, value: "provider/model" },
      { key: "command" as const, value: "opencode" },
      { key: "session_id" as const, value: session },
      { key: "session_cli" as const, value: "opencode" },
      { key: "state" as const, value: "starting" },
      { key: "updated_at" as const, value: "2026-08-06 10:00:00 +0000" },
      { key: "format_version" as const, value: "2" },
      { key: "fallback_chain" as const, value: "opencode-backup" },
      { key: "fallback_remaining" as const, value: "opencode-backup" },
      { key: "fallback_position" as const, value: "0" },
    ]
    expect(() => validateRawCheckpoint({ entries })).not.toThrow()
  })

  test("rejects unknown keys", () => {
    expect(() =>
      validateRawCheckpoint({
        entries: [{ key: "secret" as never, value: "token" }],
      }),
    ).toThrow(CheckpointValidationError)
  })

  test("rejects duplicate single-value keys", () => {
    expect(() =>
      validateRawCheckpoint({
        entries: [
          { key: "issue", value: "1" },
          { key: "issue", value: "2" },
        ],
      }),
    ).toThrow(/duplicate single-value key 'issue'/)
  })

  test("rejects values containing control characters", () => {
    expect(() =>
      validateRawCheckpoint({
        entries: [{ key: "branch", value: "feature/\n81" }],
      }),
    ).toThrow(/control character/)
  })

  test("rejects oversized values", () => {
    const long = "x".repeat(300)
    expect(() =>
      validateRawCheckpoint({
        entries: [{ key: "branch", value: long }],
      }),
    ).toThrow(/value for 'branch' is 300 bytes/)
  })

  test("rejects invalid session ids before persistence", () => {
    expect(() =>
      validateRawCheckpoint({
        entries: [{ key: "session_id", value: "../etc/passwd" }],
      }),
    ).toThrow(/invalid session id/)
  })

  test("rejects invalid format_version values", () => {
    expect(() =>
      validateRawCheckpoint({
        entries: [{ key: "format_version", value: "3" }],
      }),
    ).toThrow(/invalid format_version '3'/)
  })

  test("accepts unavailable session id sentinel", () => {
    expect(() =>
      validateRawCheckpoint({
        entries: [{ key: "session_id", value: "unavailable" }],
      }),
    ).not.toThrow()
  })
})

describe("parseCheckpointText", () => {
  test("ignores unknown keys and only emits allowlisted entries", () => {
    const text = [
      "secret=top-secret",
      "issue=81",
      "branch=feature/81",
      "session_id=../etc/passwd",
    ].join("\n")
    const entries = parseCheckpointText({ text })
    const keys = entries.map((entry) => entry.key as string)
    expect(keys.includes("secret")).toBe(false)
    expect(keys.includes("issue")).toBe(true)
    expect(keys.includes("branch")).toBe(true)
  })

  test("strict mode rejects unknown keys", () => {
    const text = ["secret=top-secret", "issue=81"].join("\n")
    expect(() => parseCheckpointTextStrict({ text })).toThrow(CheckpointValidationError)
  })

  test("skips empty lines and lines without = separator", () => {
    const text = ["", "no-separator", "issue=81"].join("\n")
    const entries = parseCheckpointText({ text })
    expect(entries.length).toBe(1)
    expect(entries[0]?.key).toBe("issue")
  })
})

describe("serializeCheckpoint", () => {
  test("round-trips through parse → build → serialize (V1 key=value compatible)", () => {
    const checkpoint = sampleGithub()
    const serialized = serializeCheckpoint({ checkpoint, clock: fixedClock })
    const entries = parseCheckpointText({ text: serialized })
    const raw = validateRawCheckpoint({ entries })
    const built = buildCheckpoint({ raw, clock: fixedClock })
    expect(built.identity).toEqual(checkpoint.identity)
    expect(built.branch).toBe(checkpoint.branch)
    expect(built.baseBranch).toBe(checkpoint.baseBranch)
    expect(built.baseSha).toBe(checkpoint.baseSha)
    expect(built.profileName).toBe(checkpoint.profileName)
    expect(built.formatVersion).toBe(CHECKPOINT_FORMAT_VERSION)
  })

  test("writes format_version=2 marker", () => {
    const checkpoint = sampleGithub()
    const serialized = serializeCheckpoint({ checkpoint, clock: fixedClock })
    expect(serialized).toContain("format_version=2\n")
  })

  test("does not include prompts, credentials, full commands, or authorization fragments", () => {
    const checkpoint = sampleGithub()
    const serialized = serializeCheckpoint({ checkpoint, clock: fixedClock })
    expect(serialized.includes("ghp_")).toBe(false)
    expect(serialized.includes("Bearer")).toBe(false)
    expect(serialized.includes("Authorization")).toBe(false)
    expect(serialized.includes("command=")).toBe(true)
  })
})

describe("fileCheckpointStore", () => {
  let directory: string
  const runnerName = "issue-killer"

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-checkpoint-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("saves and loads a checkpoint atomically", async () => {
    const store = fileCheckpointStore({ clock: fixedClock })
    const checkpoint = sampleGithub()
    await store.save({ gitCommonDir: directory, runnerName, checkpoint })
    const loaded = await store.load({ gitCommonDir: directory, runnerName })
    expect(loaded).not.toBeNull()
    if (loaded !== null) {
      expect(loaded.branch).toBe(checkpoint.branch)
      expect(loaded.identity).toEqual(checkpoint.identity)
      expect(loaded.formatVersion).toBe(CHECKPOINT_FORMAT_VERSION)
    }
  })

  test("returns null when no checkpoint exists", async () => {
    const store = fileCheckpointStore({ clock: fixedClock })
    expect(
      await store.load({ gitCommonDir: directory, runnerName }),
    ).toBeNull()
  })

  test("clear removes the checkpoint and any sibling temp files", async () => {
    const store = fileCheckpointStore({ clock: fixedClock })
    await store.save({ gitCommonDir: directory, runnerName, checkpoint: sampleGithub() })
    const filePath = join(directory, `${runnerName}.checkpoint`)
    await Bun.$`touch ${filePath}.tmp.aaa111 ${filePath}.tmp.bbb222`.text()
    await store.clear({ gitCommonDir: directory, runnerName })
    const siblings = await Bun.$`ls -1 ${directory}`.text()
    const remaining = siblings
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    expect(remaining.length).toBe(0)
  })

  test("never persists prompt text, bearer tokens, authorization headers, or full commands", async () => {
    const store = fileCheckpointStore({ clock: fixedClock })
    const checkpoint = sampleGithub()
    await store.save({ gitCommonDir: directory, runnerName, checkpoint })
    const filePath = join(directory, `${runnerName}.checkpoint`)
    const written = await readFile(filePath, "utf8")
    expect(written.includes("ghp_supersecret")).toBe(false)
    expect(written.includes("Bearer ")).toBe(false)
    expect(written.includes("Authorization")).toBe(false)
    expect(written.includes("gh issue view")).toBe(false)
  })

  test("rejects control characters and oversized values during strict validation", async () => {
    const entries = parseCheckpointText({
      text: [
        "pid=4321",
        "iteration=1",
        "issue=81",
        "branch=feature/with\u0000nul",
        "base_branch=main",
        "state=starting",
      ].join("\n"),
    })
    expect(() => validateRawCheckpoint({ entries })).toThrow(CheckpointValidationError)
  })
})

describe("Legacy V1 fixture compatibility", () => {
  test("loads a V1 fixture without loss", () => {
    const v1Text = [
      "pid=9999",
      "iteration=4",
      "issue=72",
      "branch=feature/legacy-72",
      "base_branch=main",
      "base_sha=0123456789abcdef0123456789abcdef01234567",
      "hu_branch=feature/hu-1234",
      "hu_category=feature",
      "hu_origin=main",
      "hu_origin_sha=0123456789abcdef0123456789abcdef01234567",
      "session_id=unavailable",
      "profile=opencode-main",
      "cli=opencode",
      "model=provider/model",
      "command=opencode",
      "state=issue_selected",
      "updated_at=2026-08-06 10:00:00 +0000",
    ].join("\n")
    const entries = parseCheckpointText({ text: v1Text })
    const raw = validateRawCheckpoint({ entries })
    const checkpoint = buildCheckpoint({ raw, clock: fixedClock })
    const expectedNumber = asIssueNumber(72)
    if (expectedNumber === null) throw new Error("expected issue 72 to be valid")
    expect(checkpoint.identity).toEqual({
      kind: "github",
      number: expectedNumber,
    })
    expect(checkpoint.huBranch).toBe("feature/hu-1234")
    expect(checkpoint.huBranchCategory).toBe("feature")
    expect(checkpoint.huBranchOrigin).toBe("main")
    expect(checkpoint.state).toBe("issue_selected")
  })

  test("loads a V1 fixture with optional fallback chain", () => {
    const v1Text = [
      "pid=9999",
      "iteration=5",
      "issue=72",
      "branch=feature/72",
      "base_branch=main",
      "base_sha=0123456789abcdef0123456789abcdef01234567",
      "session_id=unavailable",
      "profile=opencode-main",
      "cli=opencode",
      "model=provider/model",
      "command=opencode",
      "selected_profile=opencode-backup",
      "fallback_position=1",
      "fallback_chain=opencode-backup",
      "fallback_chain=opencode-third",
      "fallback_remaining=opencode-third",
      "state=fallback_in_progress",
      "updated_at=2026-08-06 10:00:00 +0000",
    ].join("\n")
    const entries = parseCheckpointText({ text: v1Text })
    const raw = validateRawCheckpoint({ entries })
    const checkpoint = buildCheckpoint({ raw, clock: fixedClock })
    expect(checkpoint.fallbackChain).toEqual(["opencode-backup", "opencode-third"])
    expect(checkpoint.fallbackRemaining).toEqual(["opencode-third"])
    expect(checkpoint.fallbackPosition).toBe(1)
    expect(checkpoint.selectedProfile).toBe("opencode-backup")
    expect(checkpoint.state).toBe("fallback_in_progress")
  })
})