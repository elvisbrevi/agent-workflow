import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  RepositoryLockError,
  acquireRepositoryLock,
  generateLockToken,
  isRepositoryLockStale,
  parseOwnerFile,
  parseStatusFile,
  readRepositoryLock,
  releaseRepositoryLock,
  repositoryLockPort,
  serializeOwner,
  serializeStatus,
  writeLockStatus,
} from "../../../src/state/repository-lock"
import type { LockOwner } from "../../../src/domain/ports"
import type { LifecycleState } from "../../../src/domain/lifecycle"

const makeOwner = (pid: number): LockOwner => ({
  pid,
  token: `tok-${pid}`,
  repository: "/repo",
  startedAt: "2026-08-06 10:00:00 +0000",
})

const aliveFalse = async () => false
const aliveTrue = async () => true

describe("parseOwnerFile / serializeOwner", () => {
  test("round-trips an owner record", () => {
    const owner = makeOwner(4242)
    const serialized = serializeOwner(owner)
    const parsed = parseOwnerFile(serialized)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") {
      expect(parsed.owner).toEqual(owner)
    }
  })

  test("rejects a missing pid", () => {
    const result = parseOwnerFile("token=abc\nrepository=/repo\nstarted_at=now\n")
    expect(result.kind).toBe("malformed")
  })

  test("rejects a non-numeric pid", () => {
    const result = parseOwnerFile("pid=abc\ntoken=abc\nrepository=/repo\nstarted_at=now\n")
    expect(result.kind).toBe("malformed")
  })

  test("rejects control characters in any value", () => {
    const result = parseOwnerFile("pid=1\ntoken=ab\u0000c\nrepository=/repo\nstarted_at=now\n")
    expect(result.kind).toBe("malformed")
  })
})

describe("parseStatusFile / serializeStatus", () => {
  test("round-trips a status snapshot", () => {
    const owner = makeOwner(123)
    const serialized = serializeStatus({
      owner,
      state: "issue_selected",
      updatedAt: "2026-08-06 11:00:00 +0000",
      issueLabel: "github issue 91",
    })
    const parsed = parseStatusFile(serialized)
    expect(parsed).not.toBeNull()
    if (parsed !== null) {
      expect(parsed.owner).toEqual(owner)
      expect(parsed.state).toBe<LifecycleState>("issue_selected")
      expect(parsed.issueLabel).toBe("github issue 91")
    }
  })

  test("returns null when state is not a known lifecycle state", () => {
    const owner = makeOwner(1)
    const serialized = `pid=1\ntoken=tok-1\nrepository=/repo\nstarted_at=now\nstate=banana\nupdated_at=2026-08-06 11:00:00 +0000\n`
    expect(parseStatusFile(serialized)).toBeNull()
  })
})

describe("acquireRepositoryLock", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-lock-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("creates an exclusive lock directory and writes owner + status", async () => {
    const owner = makeOwner(4242)
    const result = await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner,
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })
    expect(result.acquired).toBe(true)
    if (result.acquired) {
      const ownerRaw = await readFile(join(result.lockDir, "owner"), "utf8")
      const statusRaw = await readFile(join(result.lockDir, "status"), "utf8")
      expect(ownerRaw).toContain(`pid=${owner.pid}`)
      expect(ownerRaw).toContain(`token=${owner.token}`)
      expect(statusRaw).toContain("state=starting")
    }
  })

  test("rejects a live owner without modification", async () => {
    const lockDir = join(directory, "issue-killer.lock")
    await mkdir(lockDir)
    await writeFile(join(lockDir, "owner"), serializeOwner(makeOwner(9999)))
    const result = await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner: makeOwner(4321),
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveTrue })
    expect(result.acquired).toBe(false)
    if (!result.acquired) {
      expect(existsSync(join(lockDir, "owner"))).toBe(true)
    }
  })

  test("recovers a stale lock when PID is dead and owner unchanged", async () => {
    const lockDir = join(directory, "issue-killer.lock")
    await mkdir(lockDir)
    const previousOwner = makeOwner(99999)
    await writeFile(join(lockDir, "owner"), serializeOwner(previousOwner))
    await writeFile(
      join(lockDir, "status"),
      serializeStatus({
        owner: previousOwner,
        state: "starting",
        updatedAt: previousOwner.startedAt,
      }),
    )

    const result = await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner: makeOwner(4321),
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })
    expect(result.acquired).toBe(true)
    if (result.acquired) {
      const ownerRaw = await readFile(join(result.lockDir, "owner"), "utf8")
      expect(ownerRaw).toContain("pid=4321")
      expect(ownerRaw).not.toContain("pid=99999")
    }
  })

  test("aborts stale recovery when owner file is unreadable", async () => {
    const lockDir = join(directory, "issue-killer.lock")
    await mkdir(lockDir)
    await writeFile(join(lockDir, "owner"), "not a real owner file\n")
    await expect(
      acquireRepositoryLock({
        gitCommonDir: directory,
        runnerName: "issue-killer",
        owner: makeOwner(4321),
        statusState: "starting",
        now: "2026-08-06 10:00:00 +0000",
      }, { isPidAlive: aliveFalse }),
    ).rejects.toBeInstanceOf(RepositoryLockError)
  })

  test("fails closed when owner file is missing while lock dir exists", async () => {
    const lockDir = join(directory, "issue-killer.lock")
    await mkdir(lockDir)
    await expect(
      acquireRepositoryLock({
        gitCommonDir: directory,
        runnerName: "issue-killer",
        owner: makeOwner(4321),
        statusState: "starting",
        now: "2026-08-06 10:00:00 +0000",
      }, { isPidAlive: aliveFalse }),
    ).rejects.toBeInstanceOf(RepositoryLockError)
  })
})

describe("releaseRepositoryLock", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-lock-release-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("releases when the token matches and refuses on mismatch", async () => {
    await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner: makeOwner(1111),
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })

    const mismatch = await releaseRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      token: "tok-9999",
    })
    expect(mismatch.released).toBe(false)
    expect(mismatch.reason).toBe("token_mismatch")

    const match = await releaseRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      token: "tok-1111",
    })
    expect(match.released).toBe(true)
    expect(existsSync(join(directory, "issue-killer.lock"))).toBe(false)
  })

  test("reports missing lock cleanly", async () => {
    const result = await releaseRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      token: "tok",
    })
    expect(result.released).toBe(false)
    expect(result.reason).toBe("missing")
  })
})

describe("readRepositoryLock", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-lock-read-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("returns the snapshot when present", async () => {
    await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner: makeOwner(2024),
      statusState: "issue_selected",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })
    const result = await readRepositoryLock(directory, "issue-killer")
    expect(result.kind).toBe("present")
    if (result.kind === "present") {
      expect(result.snapshot.state).toBe<LifecycleState>("issue_selected")
      expect(result.snapshot.owner.pid).toBe(2024)
    }
  })

  test("returns absent when no lock exists", async () => {
    expect((await readRepositoryLock(directory, "issue-killer")).kind).toBe("absent")
  })
})

describe("isRepositoryLockStale", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-lock-stale-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("flags the lock as stale when PID is dead and owner unchanged", async () => {
    await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner: makeOwner(9876),
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })
    const result = await isRepositoryLockStale(directory, "issue-killer", { isPidAlive: aliveFalse })
    expect(result.stale).toBe(true)
  })

  test("does not flag as stale when PID is alive", async () => {
    await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner: makeOwner(9876),
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveTrue })
    const result = await isRepositoryLockStale(directory, "issue-killer", { isPidAlive: aliveTrue })
    expect(result.stale).toBe(false)
    expect(result.reason).toBe("owner_alive")
  })

  test("does not flag as stale when owner file is malformed", async () => {
    const lockDir = join(directory, "issue-killer.lock")
    await mkdir(lockDir)
    await writeFile(join(lockDir, "owner"), "totally broken content\n")
    const result = await isRepositoryLockStale(directory, "issue-killer", { isPidAlive: aliveFalse })
    expect(result.stale).toBe(false)
    expect(result.reason).toBe("owner_malformed")
  })
})

describe("writeLockStatus", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-lock-status-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("writes status atomically with the matching token", async () => {
    const owner = makeOwner(314)
    await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner,
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })
    const ok = await writeLockStatus({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      token: owner.token,
      status: "mutating",
      updatedAt: "2026-08-06 10:05:00 +0000",
    })
    expect(ok).toBe(true)
    const statusRaw = await readFile(join(directory, "issue-killer.lock", "status"), "utf8")
    expect(statusRaw).toContain("state=mutating")
  })

  test("refuses status writes with a mismatched token", async () => {
    const owner = makeOwner(315)
    await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner,
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })
    const ok = await writeLockStatus({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      token: "wrong-token",
      status: "mutating",
      updatedAt: "2026-08-06 10:05:00 +0000",
    })
    expect(ok).toBe(false)
  })

  test("V2-SEC-04: concurrent heartbeat and status writes do not corrupt the snapshot", async () => {
    const owner = makeOwner(4242)
    await acquireRepositoryLock({
      gitCommonDir: directory,
      runnerName: "issue-killer",
      owner,
      statusState: "starting",
      now: "2026-08-06 10:00:00 +0000",
    }, { isPidAlive: aliveFalse })

    const writes = Array.from({ length: 8 }, (_, index) =>
      writeLockStatus({
        gitCommonDir: directory,
        runnerName: "issue-killer",
        token: owner.token,
        status: "mutating",
        updatedAt: `2026-08-06 10:05:${String(index).padStart(2, "0")} +0000`,
      }),
    )
    const results = await Promise.all(writes)
    expect(results.every((ok) => ok === true)).toBe(true)

    const siblings = await Bun.$`ls -1 ${join(directory, "issue-killer.lock")}`.text()
    const names = siblings
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const tmpFiles = names.filter((name) => name.startsWith("status.tmp."))
    expect(tmpFiles.length).toBe(0)
    const statusRaw = await readFile(join(directory, "issue-killer.lock", "status"), "utf8")
    expect(statusRaw.includes("\nstate=mutating\n")).toBe(true)
  })
})

describe("generateLockToken", () => {
  test("produces a unique random token per call", () => {
    const a = generateLockToken(1)
    const b = generateLockToken(1)
    expect(a).not.toBe(b)
    expect(a.startsWith("1-")).toBe(true)
    expect(b.startsWith("1-")).toBe(true)
  })
})

describe("repositoryLockPort", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-lock-port-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("acquire and release through the port surface", async () => {
    const port = repositoryLockPort({ isPidAlive: aliveTrue })
    const acquired = await port.acquire({
      gitCommonDir: directory,
      owner: { pid: 7777, token: "tok-port", repository: "/repo", startedAt: "now" },
    })
    expect(acquired.acquired).toBe(true)

    const second = await port.acquire({
      gitCommonDir: directory,
      owner: { pid: 8888, token: "tok-port-2", repository: "/repo", startedAt: "now" },
    })
    expect(second.acquired).toBe(false)
    if (!second.acquired) {
      expect(second.holder).not.toBeNull()
    }

    const released = await port.release({ gitCommonDir: directory, token: "tok-port" })
    expect(released).toBe(true)
  })

  test("writeStatus via the port persists state", async () => {
    const port = repositoryLockPort({ isPidAlive: aliveFalse })
    const owner = { pid: 8888, token: "tok-status", repository: "/repo", startedAt: "now" }
    await port.acquire({ gitCommonDir: directory, owner })
    await port.writeStatus({
      gitCommonDir: directory,
      token: owner.token,
      status: "mutating",
      updatedAt: "2026-08-06 10:10:00 +0000",
      issueLabel: "github issue 81",
    })
    const snapshot = await port.read({ gitCommonDir: directory })
    expect(snapshot?.state).toBe<LifecycleState>("mutating")
    expect(snapshot?.issueLabel).toBe("github issue 81")
  })
})