import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { kill } from "node:process"
import type {
  LockOwner,
  LockSnapshot,
  RepositoryLockPort,
} from "../domain/ports"
import type { LifecycleState } from "../domain/lifecycle"
import { isLifecycleState } from "../domain/lifecycle"
import { writeAtomic, cleanupAtomicTempFiles } from "./atomic-file"

export type RepositoryLockErrorKind =
  | "owner_unreadable"
  | "owner_malformed"
  | "owner_changed_during_recovery"
  | "missing_owner"
  | "stale_recovery_failed"
  | "permission_denied"

export class RepositoryLockError extends Error {
  readonly kind: RepositoryLockErrorKind
  readonly gitCommonDir: string
  readonly cause?: unknown

  constructor(
    kind: RepositoryLockErrorKind,
    gitCommonDir: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message)
    this.name = "RepositoryLockError"
    this.kind = kind
    this.gitCommonDir = gitCommonDir
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0a-\x1f\x7f]/

const PID_PATTERN = /^\d+$/

export const assertSafeValue = (key: string, value: string): boolean => {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    return false
  }
  return true
}

export type ParseOwnerResult =
  | { readonly kind: "ok"; readonly owner: LockOwner; readonly raw: string }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly reason: string }

export const parseOwnerFile = (raw: string): ParseOwnerResult => {
  if (raw.length === 0) {
    return { kind: "missing" }
  }
  const lines = raw.split("\n")
  let pid: number | undefined
  let token: string | undefined
  let repository: string | undefined
  let startedAt: string | undefined
  for (const line of lines) {
    if (line.length === 0) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (CONTROL_CHAR_PATTERN.test(value)) {
      return { kind: "malformed", reason: `control character in ${key}` }
    }
    switch (key) {
      case "pid":
        if (!PID_PATTERN.test(value)) {
          return { kind: "malformed", reason: `pid='${value}'` }
        }
        pid = Number.parseInt(value, 10)
        break
      case "token":
        token = value
        break
      case "repository":
        repository = value
        break
      case "started_at":
        startedAt = value
        break
      default:
        break
    }
  }
  if (pid === undefined || token === undefined || repository === undefined) {
    return { kind: "malformed", reason: "missing required key" }
  }
  return {
    kind: "ok",
    owner: { pid, token, repository, startedAt: startedAt ?? "" },
    raw,
  }
}

export const serializeOwner = (owner: LockOwner): string => {
  const lines = [
    `pid=${owner.pid}`,
    `token=${owner.token}`,
    `repository=${owner.repository}`,
    `started_at=${owner.startedAt}`,
  ]
  return `${lines.join("\n")}\n`
}

export const parseStatusFile = (raw: string): LockSnapshot | null => {
  if (raw.length === 0) return null
  const lines = raw.split("\n")
  let pid: number | undefined
  let token: string | undefined
  let repository: string | undefined
  let startedAt: string | undefined
  let state: LifecycleState | undefined
  let updatedAt: string | undefined
  let issueLabel: string | undefined

  for (const line of lines) {
    if (line.length === 0) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (CONTROL_CHAR_PATTERN.test(value)) {
      return null
    }
    switch (key) {
      case "pid":
        if (!PID_PATTERN.test(value)) return null
        pid = Number.parseInt(value, 10)
        break
      case "token":
        token = value
        break
      case "repository":
        repository = value
        break
      case "started_at":
        startedAt = value
        break
      case "state":
        if (!isLifecycleState(value)) return null
        state = value
        break
      case "updated_at":
        updatedAt = value
        break
      case "issue":
        issueLabel = value
        break
      default:
        break
    }
  }

  if (pid === undefined || state === undefined || updatedAt === undefined) {
    return null
  }
  return {
    owner: {
      pid,
      token: token ?? "",
      repository: repository ?? "",
      startedAt: startedAt ?? "",
    },
    state,
    updatedAt,
    ...(issueLabel !== undefined ? { issueLabel } : {}),
  }
}

export const serializeStatus = (snapshot: LockSnapshot): string => {
  const lines = [
    `pid=${snapshot.owner.pid}`,
    `token=${snapshot.owner.token}`,
    `repository=${snapshot.owner.repository}`,
    `started_at=${snapshot.owner.startedAt}`,
    `state=${snapshot.state}`,
    `updated_at=${snapshot.updatedAt}`,
  ]
  if (snapshot.issueLabel !== undefined) {
    lines.push(`issue=${snapshot.issueLabel}`)
  }
  return `${lines.join("\n")}\n`
}

const isPidAlive = async (pid: number): Promise<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { readonly code?: unknown }).code === "ESRCH" ||
        (error as { readonly code?: unknown }).code === "EPERM")
    ) {
      return (error as { readonly code?: unknown }).code === "EPERM"
    }
    return false
  }
}

const readOwnerFileSafe = async (
  ownerPath: string,
): Promise<ParseOwnerResult> => {
  let raw: string
  try {
    raw = await readFile(ownerPath, "utf8")
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return { kind: "missing" }
    }
    const message = error instanceof Error ? error.message : String(error)
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "EACCES"
    ) {
      throw new RepositoryLockError(
        "permission_denied",
        dirname(ownerPath),
        `cannot read lock owner file: ${message}`,
        { cause: error },
      )
    }
    throw new RepositoryLockError(
      "owner_unreadable",
      dirname(ownerPath),
      `cannot read lock owner file: ${message}`,
      { cause: error },
    )
  }
  return parseOwnerFile(raw)
}

const tryRemoveIfPresent = async (filePath: string): Promise<void> => {
  try {
    await rm(filePath, { force: true })
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return
    }
    throw error
  }
}

const tryRemoveDirIfEmpty = async (dirPath: string): Promise<void> => {
  try {
    await rmdir(dirPath)
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { readonly code?: unknown }).code === "ENOENT" ||
        (error as { readonly code?: unknown }).code === "ENOTEMPTY" ||
        (error as { readonly code?: unknown }).code === "EEXIST")
    ) {
      return
    }
    throw error
  }
}

const readStatusFile = async (lockDir: string): Promise<LockSnapshot | null> => {
  let raw: string
  try {
    raw = await readFile(join(lockDir, "status"), "utf8")
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return null
    }
    return null
  }
  return parseStatusFile(raw)
}

const tryMkdir = async (path: string): Promise<boolean> => {
  try {
    await mkdir(path, { recursive: false })
    return true
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "EEXIST"
    ) {
      return false
    }
    throw error
  }
}

export type RepositoryLockOptions = {
  readonly isPidAlive?: (pid: number) => Promise<boolean> | boolean
}

const TOKEN_BYTES = 16

export const generateLockToken = (pid: number): string =>
  `${pid}-${randomBytes(TOKEN_BYTES).toString("hex")}`

export type AcquireInput = {
  readonly gitCommonDir: string
  readonly runnerName: string
  readonly owner: LockOwner
  readonly statusState: LifecycleState
  readonly now: string
}

export type AcquireResult =
  | { readonly acquired: true; readonly lockDir: string; readonly token: string }
  | {
      readonly acquired: false
      readonly lockDir: string
      readonly holder: LockSnapshot | null
    }

const tryAcquireOnce = async (
  lockDir: string,
  owner: LockOwner,
  snapshot: Omit<LockSnapshot, "owner">,
): Promise<{ readonly acquired: true } | { readonly acquired: false; readonly holder: LockSnapshot | null }> => {
  const created = await tryMkdir(lockDir)
  if (!created) {
    return { acquired: false, holder: await readStatusFile(lockDir) }
  }
  try {
    await writeFile(join(lockDir, "owner"), serializeOwner(owner), {
      encoding: "utf8",
      flag: "wx",
    })
  } catch (error) {
    await tryRemoveDirIfEmpty(lockDir)
    throw new RepositoryLockError(
      "missing_owner",
      lockDir,
      `cannot write owner file: ${(error as Error).message}`,
      { cause: error },
    )
  }
  try {
    await writeAtomic({
      filePath: join(lockDir, "status"),
      content: serializeStatus({
        owner,
        state: snapshot.state,
        updatedAt: snapshot.updatedAt,
        ...(snapshot.issueLabel !== undefined ? { issueLabel: snapshot.issueLabel } : {}),
      }),
    })
  } catch (error) {
    await tryRemoveIfPresent(join(lockDir, "owner"))
    await tryRemoveDirIfEmpty(lockDir)
    throw error
  }
  return { acquired: true }
}

export const acquireRepositoryLock = async (
  input: AcquireInput,
  options?: RepositoryLockOptions,
): Promise<AcquireResult> => {
  const isAlive = options?.isPidAlive ?? isPidAlive
  const lockDir = join(input.gitCommonDir, `${input.runnerName}.lock`)
  const ownerPath = join(lockDir, "owner")

  while (true) {
    const result = await tryAcquireOnce(lockDir, input.owner, {
      state: input.statusState,
      updatedAt: input.now,
    })
    if (result.acquired) {
      return { acquired: true, lockDir, token: input.owner.token }
    }
    const existing = await readOwnerFileSafe(ownerPath)
    if (existing.kind === "missing") {
      throw new RepositoryLockError(
        "missing_owner",
        input.gitCommonDir,
        `lock directory ${lockDir} exists but owner file is missing`,
      )
    }
    if (existing.kind === "malformed") {
      throw new RepositoryLockError(
        "owner_malformed",
        input.gitCommonDir,
        `lock owner file is malformed: ${existing.reason}`,
      )
    }
    const alive = await isAlive(existing.owner.pid)
    if (alive) {
      const holder = await readStatusFile(lockDir)
      return { acquired: false, lockDir, holder }
    }
    const snapshotBefore = existing.raw
    const reRead = await readOwnerFileSafe(ownerPath)
    if (reRead.kind !== "ok" || reRead.raw !== snapshotBefore) {
      throw new RepositoryLockError(
        "owner_changed_during_recovery",
        input.gitCommonDir,
        `lock owner changed during stale recovery; aborting to avoid stealing a live lock`,
      )
    }
    await tryRemoveIfPresent(join(lockDir, "status"))
    await tryRemoveIfPresent(ownerPath)
    await tryRemoveDirIfEmpty(lockDir)
    const finalSnapshot = await readStatusFile(lockDir)
    if (finalSnapshot !== null) {
      throw new RepositoryLockError(
        "stale_recovery_failed",
        input.gitCommonDir,
        `lock directory ${lockDir} still contains status after recovery`,
      )
    }
  }
}

export type ReleaseInput = {
  readonly gitCommonDir: string
  readonly runnerName: string
  readonly token: string
}

export type ReleaseResult = {
  readonly released: boolean
  readonly reason?: "missing" | "token_mismatch" | "owner_malformed" | "permission_denied" | "unreadable"
}

export const releaseRepositoryLock = async (
  input: ReleaseInput,
): Promise<ReleaseResult> => {
  const lockDir = join(input.gitCommonDir, `${input.runnerName}.lock`)
  const ownerPath = join(lockDir, "owner")

  const parsed = await readOwnerFileSafe(ownerPath)
  if (parsed.kind === "missing") {
    return { released: false, reason: "missing" }
  }
  if (parsed.kind === "malformed") {
    return { released: false, reason: "owner_malformed" }
  }
  if (parsed.owner.token !== input.token) {
    return { released: false, reason: "token_mismatch" }
  }
  await cleanupAtomicTempFiles({ filePath: join(lockDir, "status") })
  await tryRemoveIfPresent(join(lockDir, "status"))
  await tryRemoveIfPresent(ownerPath)
  await tryRemoveDirIfEmpty(lockDir)
  return { released: true }
}

export type ReadLockResult =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly snapshot: LockSnapshot }
  | { readonly kind: "malformed"; readonly reason: string }

export const readRepositoryLock = async (
  gitCommonDir: string,
  runnerName: string,
): Promise<ReadLockResult> => {
  const lockDir = join(gitCommonDir, `${runnerName}.lock`)
  const ownerPath = join(lockDir, "owner")
  const parsed = await readOwnerFileSafe(ownerPath)
  if (parsed.kind === "missing") return { kind: "absent" }
  if (parsed.kind === "malformed") {
    return { kind: "malformed", reason: parsed.reason }
  }
  const statusRaw = await readStatusFile(lockDir)
  if (statusRaw === null) {
    return {
      kind: "present",
      snapshot: {
        owner: parsed.owner,
        state: "starting",
        updatedAt: parsed.owner.startedAt,
      },
    }
  }
  return { kind: "present", snapshot: statusRaw }
}

export type StaleCheckResult = {
  readonly stale: boolean
  readonly reason: "owner_alive" | "owner_changed" | "owner_missing" | "owner_malformed" | "absent"
}

export const isRepositoryLockStale = async (
  gitCommonDir: string,
  runnerName: string,
  options?: { readonly now?: string; readonly isPidAlive?: (pid: number) => Promise<boolean> | boolean },
): Promise<StaleCheckResult> => {
  const isAlive = options?.isPidAlive ?? isPidAlive
  const lockDir = join(gitCommonDir, `${runnerName}.lock`)
  const ownerPath = join(lockDir, "owner")

  const first = await readOwnerFileSafe(ownerPath)
  if (first.kind === "missing") return { stale: false, reason: "absent" }
  if (first.kind === "malformed") {
    return { stale: false, reason: "owner_malformed" }
  }
  const alive = await isAlive(first.owner.pid)
  if (alive) return { stale: false, reason: "owner_alive" }
  const second = await readOwnerFileSafe(ownerPath)
  if (second.kind === "missing") return { stale: true, reason: "owner_missing" }
  if (second.kind === "malformed") return { stale: true, reason: "owner_malformed" }
  if (second.raw !== first.raw) {
    return { stale: false, reason: "owner_changed" }
  }
  return { stale: true, reason: "owner_missing" }
}

export const writeLockStatus = async (
  input: {
    readonly gitCommonDir: string
    readonly runnerName: string
    readonly token: string
    readonly status: LifecycleState
    readonly issueLabel?: string
    readonly updatedAt: string
  },
): Promise<boolean> => {
  const lockDir = join(input.gitCommonDir, `${input.runnerName}.lock`)
  const ownerPath = join(lockDir, "owner")
  const parsed = await readOwnerFileSafe(ownerPath)
  if (parsed.kind !== "ok") return false
  if (parsed.owner.token !== input.token) return false
  await writeAtomic({
    filePath: join(lockDir, "status"),
    content: serializeStatus({
      owner: parsed.owner,
      state: input.status,
      updatedAt: input.updatedAt,
      ...(input.issueLabel !== undefined ? { issueLabel: input.issueLabel } : {}),
    }),
  })
  return true
}

export const repositoryLockPort = (
  options?: RepositoryLockOptions,
): RepositoryLockPort => {
  return {
    acquire: async ({ gitCommonDir, owner }) => {
      const result = await acquireRepositoryLock(
        {
          gitCommonDir,
          runnerName: "issue-killer",
          owner,
          statusState: "starting",
          now: owner.startedAt,
        },
        options,
      )
      if (result.acquired) {
        return { acquired: true }
      }
      return { acquired: false, holder: result.holder }
    },
    release: async ({ gitCommonDir, token }) => {
      const result = await releaseRepositoryLock({
        gitCommonDir,
        runnerName: "issue-killer",
        token,
      })
      return result.released
    },
    read: async ({ gitCommonDir }) => {
      const result = await readRepositoryLock(gitCommonDir, "issue-killer")
      return result.kind === "present" ? result.snapshot : null
    },
    isStale: async ({ gitCommonDir, now }) => {
      const result = await isRepositoryLockStale(gitCommonDir, "issue-killer", { now })
      return result.stale
    },
    writeStatus: async ({ gitCommonDir, token, status, issueLabel, updatedAt }) => {
      const ok = await writeLockStatus({
        gitCommonDir,
        runnerName: "issue-killer",
        token,
        status,
        issueLabel,
        updatedAt,
      })
      if (!ok) {
        throw new RepositoryLockError(
          "owner_changed_during_recovery",
          gitCommonDir,
          `cannot write lock status: token mismatch or missing owner`,
        )
      }
    },
  }
}

export const _internal = { isPidAlive }