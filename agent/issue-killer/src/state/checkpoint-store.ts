import { readFile, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseSessionId } from "../domain/session-id"
import {
  CHECKPOINT_FORMAT_VERSION,
  type Checkpoint,
  type CheckpointIdentity,
  type HuNumber,
  type IssueNumber,
  type TicketNumber,
  asHuNumber,
  asIssueNumber,
  asTicketNumber,
} from "../domain/checkpoint"
import { isLifecycleState } from "../domain/lifecycle"
import { AtomicFileError, cleanupAtomicTempFiles, writeAtomic } from "./atomic-file"

export const CHECKPOINT_VALUE_MAX_LENGTH = 256
export const CHECKPOINT_SESSION_VALUE_MAX_LENGTH = 128

export type CheckpointSingleValueKey =
  | "pid"
  | "iteration"
  | "issue"
  | "hu"
  | "ticket"
  | "branch"
  | "base_branch"
  | "base_sha"
  | "profile"
  | "cli"
  | "model"
  | "command"
  | "selected_profile"
  | "fallback_position"
  | "failed_profile"
  | "next_profile"
  | "fallback_failure"
  | "hu_branch"
  | "hu_category"
  | "hu_origin"
  | "hu_origin_sha"
  | "session_id"
  | "session_cli"
  | "state"
  | "updated_at"
  | "format_version"

export type CheckpointMultiValueKey = "fallback_chain" | "fallback_remaining"

export type CheckpointKey = CheckpointSingleValueKey | CheckpointMultiValueKey

const SINGLE_VALUE_KEYS: ReadonlyArray<CheckpointSingleValueKey> = [
  "pid",
  "iteration",
  "issue",
  "hu",
  "ticket",
  "branch",
  "base_branch",
  "base_sha",
  "profile",
  "cli",
  "model",
  "command",
  "selected_profile",
  "fallback_position",
  "failed_profile",
  "next_profile",
  "fallback_failure",
  "hu_branch",
  "hu_category",
  "hu_origin",
  "hu_origin_sha",
  "session_id",
  "session_cli",
  "state",
  "updated_at",
  "format_version",
]

const MULTI_VALUE_KEYS: ReadonlyArray<CheckpointMultiValueKey> = [
  "fallback_chain",
  "fallback_remaining",
]

const SINGLE_VALUE_KEY_SET: ReadonlySet<string> = new Set<string>(SINGLE_VALUE_KEYS)
const MULTI_VALUE_KEY_SET: ReadonlySet<string> = new Set<string>(MULTI_VALUE_KEYS)
const ALLOWED_KEY_SET: ReadonlySet<string> = new Set<string>([
  ...SINGLE_VALUE_KEYS,
  ...MULTI_VALUE_KEYS,
])

const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0a-\x1f\x7f]/

export type CheckpointValidationFailure =
  | { readonly kind: "unknown_key"; readonly key: string }
  | { readonly kind: "duplicate_single_value"; readonly key: CheckpointSingleValueKey }
  | { readonly kind: "invalid_format_version"; readonly value: string }
  | { readonly kind: "control_character"; readonly key: string; readonly position: number }
  | { readonly kind: "value_too_large"; readonly key: string; readonly length: number; readonly max: number }
  | { readonly kind: "empty_value"; readonly key: string }
  | { readonly kind: "invalid_session_id"; readonly key: string; readonly value: string }

export class CheckpointValidationError extends Error {
  readonly failure: CheckpointValidationFailure

  constructor(failure: CheckpointValidationFailure) {
    super(`checkpoint validation failed: ${formatCheckpointFailure(failure)}`)
    this.name = "CheckpointValidationError"
    this.failure = failure
  }
}

export const formatCheckpointFailure = (failure: CheckpointValidationFailure): string => {
  switch (failure.kind) {
    case "unknown_key":
      return `unknown key '${failure.key}'`
    case "duplicate_single_value":
      return `duplicate single-value key '${failure.key}'`
    case "invalid_format_version":
      return `invalid format_version '${failure.value}' (expected 1 or 2)`
    case "control_character":
      return `control character in '${failure.key}' at position ${failure.position}`
    case "value_too_large":
      return `value for '${failure.key}' is ${failure.length} bytes (max ${failure.max})`
    case "empty_value":
      return `empty value for '${failure.key}'`
    case "invalid_session_id":
      return `invalid session id in '${failure.key}': ${failure.value}`
  }
}

const assertNoControlChars = (key: string, value: string): void => {
  const index = value.search(CONTROL_CHAR_PATTERN)
  if (index === -1) return
  throw new CheckpointValidationError({
    kind: "control_character",
    key,
    position: index,
  })
}

const assertValueLength = (key: string, value: string, max: number): void => {
  if (value.length > max) {
    throw new CheckpointValidationError({
      kind: "value_too_large",
      key,
      length: value.length,
      max,
    })
  }
}

const assertValidSessionValue = (
  key: CheckpointSingleValueKey,
  value: string,
): void => {
  if (value === "unavailable") return
  const parsed = parseSessionId(value)
  if (parsed === null) {
    throw new CheckpointValidationError({
      kind: "invalid_session_id",
      key,
      value,
    })
  }
}

const assertValidFormatVersion = (value: string): void => {
  if (value !== "1" && value !== "2") {
    throw new CheckpointValidationError({
      kind: "invalid_format_version",
      value,
    })
  }
}

export type RawCheckpointEntry = {
  readonly key: CheckpointKey
  readonly value: string
}

export type ValidateRawCheckpointInput = {
  readonly entries: ReadonlyArray<RawCheckpointEntry>
}

export type ValidateRawCheckpointResult = {
  readonly singleValues: ReadonlyMap<CheckpointSingleValueKey, string>
  readonly multiValues: ReadonlyMap<CheckpointMultiValueKey, ReadonlyArray<string>>
}

export const validateRawCheckpoint = (
  input: ValidateRawCheckpointInput,
): ValidateRawCheckpointResult => {
  const single = new Map<CheckpointSingleValueKey, string>()
  const multi = new Map<CheckpointMultiValueKey, string[]>()
  const seenMulti = new Set<CheckpointMultiValueKey>()

  for (const entry of input.entries) {
    const key = entry.key
    if (!ALLOWED_KEY_SET.has(key)) {
      throw new CheckpointValidationError({ kind: "unknown_key", key })
    }
    const value = entry.value

    if (SINGLE_VALUE_KEY_SET.has(key)) {
      if (single.has(key as CheckpointSingleValueKey)) {
        throw new CheckpointValidationError({
          kind: "duplicate_single_value",
          key: key as CheckpointSingleValueKey,
        })
      }
      assertNoControlChars(key, value)
      assertValueLength(key, value, CHECKPOINT_VALUE_MAX_LENGTH)
      if (value.length === 0) {
        throw new CheckpointValidationError({ kind: "empty_value", key })
      }
      if (key === "session_id") {
        assertValidSessionValue(key, value)
      } else if (key === "format_version") {
        assertValidFormatVersion(value)
      }
      single.set(key as CheckpointSingleValueKey, value)
      continue
    }

    if (MULTI_VALUE_KEY_SET.has(key)) {
      assertNoControlChars(key, value)
      assertValueLength(key, value, CHECKPOINT_VALUE_MAX_LENGTH)
      if (value.length === 0) continue
      const multiKey = key as CheckpointMultiValueKey
      const list = multi.get(multiKey) ?? []
      list.push(value)
      multi.set(multiKey, list)
      seenMulti.add(multiKey)
      continue
    }
  }

  const multiValues = new Map<CheckpointMultiValueKey, ReadonlyArray<string>>()
  for (const [key, values] of multi) {
    multiValues.set(key, [...values])
  }
  return { singleValues: single, multiValues }
}

export type ParseCheckpointTextInput = {
  readonly text: string
}

export const parseCheckpointText = (
  input: ParseCheckpointTextInput,
): ReadonlyArray<RawCheckpointEntry> => {
  return parseCheckpointLines(input.text, false)
}

export const parseCheckpointTextStrict = (
  input: ParseCheckpointTextInput,
): ReadonlyArray<RawCheckpointEntry> => {
  return parseCheckpointLines(input.text, true)
}

const parseCheckpointLines = (text: string, strict: boolean): ReadonlyArray<RawCheckpointEntry> => {
  const entries: RawCheckpointEntry[] = []
  const lines = text.split("\n")
  for (const line of lines) {
    if (line.length === 0) continue
    const eq = line.indexOf("=")
    if (eq <= 0) {
      if (strict) {
        throw new CheckpointValidationError({
          kind: "unknown_key",
          key: line,
        })
      }
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (!ALLOWED_KEY_SET.has(key)) {
      if (strict) {
        throw new CheckpointValidationError({
          kind: "unknown_key",
          key,
        })
      }
      continue
    }
    entries.push({ key: key as CheckpointKey, value })
  }
  return entries
}

const readSessionValue = (
  key: CheckpointSingleValueKey,
  single: ReadonlyMap<CheckpointSingleValueKey, string>,
): ReturnType<typeof parseSessionId> | "unavailable" | undefined => {
  const raw = single.get(key)
  if (raw === undefined) return undefined
  if (raw === "unavailable") return "unavailable"
  return parseSessionId(raw)
}

export type BuildCheckpointInput = {
  readonly raw: ValidateRawCheckpointResult
  readonly clock: ClockLike
}

type ClockLike = { now(): string }

export const buildCheckpoint = (input: BuildCheckpointInput): Checkpoint => {
  const { single, multi } = { single: input.raw.singleValues, multi: input.raw.multiValues }

  const identity = readIdentity(single)
  const branch = single.get("branch") ?? ""
  const baseBranch = single.get("base_branch") ?? ""
  const baseSha = single.get("base_sha") ?? ""
  const profileName = single.get("profile") ?? ""
  const cli = single.get("cli") ?? ""
  const model = single.get("model") ?? ""
  const command = single.get("command") ?? ""
  const stateRaw = single.get("state")
  if (stateRaw === undefined || !isLifecycleState(stateRaw)) {
    throw new CheckpointValidationError({
      kind: "invalid_format_version",
      value: `state=${stateRaw ?? "missing"}`,
    })
  }
  const updatedAt = single.get("updated_at") ?? input.clock.now()

  const sessionIdRaw = single.get("session_id")
  const sessionId = sessionIdRaw === undefined
    ? undefined
    : sessionIdRaw === "unavailable"
      ? undefined
      : parseSessionId(sessionIdRaw)

  if (sessionIdRaw !== undefined && sessionIdRaw !== "unavailable" && sessionId === null) {
    throw new CheckpointValidationError({
      kind: "invalid_session_id",
      key: "session_id",
      value: sessionIdRaw,
    })
  }

  const formatVersionRaw = single.get("format_version")
  const formatVersion: 1 | 2 = formatVersionRaw === "1" ? 1 : CHECKPOINT_FORMAT_VERSION

  const fallbackChain = multi.get("fallback_chain") ?? []
  const fallbackRemaining = multi.get("fallback_remaining") ?? []
  const fallbackPositionRaw = single.get("fallback_position")
  const fallbackPosition = fallbackPositionRaw === undefined ? 0 : Number.parseInt(fallbackPositionRaw, 10)

  const checkpoint: Checkpoint = {
    pid: Number.parseInt(single.get("pid") ?? "0", 10),
    iteration: Number.parseInt(single.get("iteration") ?? "0", 10),
    identity,
    branch,
    baseBranch,
    baseSha,
    profileName,
    cli,
    model,
    command,
    ...(sessionId !== undefined && sessionId !== null ? { sessionId } : {}),
    sessionCli: single.get("session_cli"),
    selectedProfile: single.get("selected_profile"),
    fallbackChain: [...fallbackChain],
    fallbackRemaining: [...fallbackRemaining],
    fallbackPosition: Number.isFinite(fallbackPosition) ? fallbackPosition : 0,
    failedProfile: single.get("failed_profile"),
    nextProfile: single.get("next_profile"),
    fallbackFailure: single.get("fallback_failure"),
    huBranch: single.get("hu_branch"),
    huBranchCategory: readHuBranchCategory(single),
    huBranchOrigin: single.get("hu_origin"),
    huBranchOriginSha: single.get("hu_origin_sha"),
    state: stateRaw,
    updatedAt,
    formatVersion,
  }
  return checkpoint
}

const readHuBranchCategory = (
  single: ReadonlyMap<CheckpointSingleValueKey, string>,
): "feature" | "hotfix" | "refactor" | undefined => {
  const raw = single.get("hu_category")
  if (raw === undefined) return undefined
  if (raw === "feature" || raw === "hotfix" || raw === "refactor") {
    return raw
  }
  return undefined
}

const readIdentity = (
  single: ReadonlyMap<CheckpointSingleValueKey, string>,
): CheckpointIdentity => {
  const huRaw = single.get("hu")
  const ticketRaw = single.get("ticket")
  const issueRaw = single.get("issue")

  if (huRaw !== undefined) {
    const hu = asHuNumber(Number.parseInt(huRaw, 10))
    if (hu === null) {
      return { kind: "unknown" }
    }
    if (ticketRaw !== undefined) {
      const ticket = asTicketNumber(Number.parseInt(ticketRaw, 10))
      if (ticket === null) {
        return { kind: "azure_hu", hu }
      }
      return { kind: "azure_hu", hu, ticket }
    }
    return { kind: "azure_hu", hu }
  }

  if (issueRaw !== undefined) {
    const number = asIssueNumber(Number.parseInt(issueRaw, 10))
    if (number === null) return { kind: "unknown" }
    return { kind: "github", number }
  }

  return { kind: "unknown" }
}

export const serializeCheckpoint = (input: {
  readonly checkpoint: Checkpoint
  readonly clock: ClockLike
}): string => {
  const lines: string[] = []
  const c = input.checkpoint

  const pushSingle = (key: CheckpointSingleValueKey, value: string | number | undefined): void => {
    if (value === undefined) return
    const text = typeof value === "string" ? value : String(value)
    if (text.length === 0) return
    lines.push(`${key}=${text}`)
  }

  const pushMulti = (key: CheckpointMultiValueKey, value: string): void => {
    if (value.length === 0) return
    lines.push(`${key}=${value}`)
  }

  pushSingle("pid", c.pid)
  pushSingle("iteration", c.iteration)
  switch (c.identity.kind) {
    case "github":
      pushSingle("issue", c.identity.number as unknown as number)
      break
    case "azure_hu":
      pushSingle("hu", c.identity.hu as unknown as number)
      if (c.identity.ticket !== undefined) {
        pushSingle("ticket", c.identity.ticket as unknown as number)
      }
      break
    case "unknown":
      pushSingle("issue", "unknown")
      break
  }
  pushSingle("branch", c.branch)
  pushSingle("base_branch", c.baseBranch)
  pushSingle("base_sha", c.baseSha)
  pushSingle("profile", c.profileName)
  pushSingle("cli", c.cli)
  pushSingle("model", c.model)
  pushSingle("command", c.command)
  if (c.sessionId !== undefined) {
    pushSingle("session_id", c.sessionId)
    pushSingle("session_cli", c.sessionCli)
  } else {
    pushSingle("session_id", "unavailable")
  }
  pushSingle("selected_profile", c.selectedProfile)
  if (c.fallbackPosition > 0 || c.fallbackChain.length > 0) {
    pushSingle("fallback_position", c.fallbackPosition)
  }
  for (const entry of c.fallbackChain) pushMulti("fallback_chain", entry)
  for (const entry of c.fallbackRemaining) pushMulti("fallback_remaining", entry)
  pushSingle("failed_profile", c.failedProfile)
  pushSingle("next_profile", c.nextProfile)
  pushSingle("fallback_failure", c.fallbackFailure)
  pushSingle("hu_branch", c.huBranch)
  pushSingle("hu_category", c.huBranchCategory)
  pushSingle("hu_origin", c.huBranchOrigin)
  pushSingle("hu_origin_sha", c.huBranchOriginSha)
  pushSingle("state", c.state)
  pushSingle("updated_at", input.clock.now())
  pushSingle("format_version", c.formatVersion)

  return `${lines.join("\n")}\n`
}

export type CheckpointStorePortLike = {
  load(input: { readonly gitCommonDir: string; readonly runnerName: string }): Promise<Checkpoint | null>
  save(input: {
    readonly gitCommonDir: string
    readonly runnerName: string
    readonly checkpoint: Checkpoint
  }): Promise<void>
  clear(input: { readonly gitCommonDir: string; readonly runnerName: string }): Promise<void>
}

export type FileCheckpointStoreInput = {
  readonly clock: ClockLike
  readonly validateOnRead?: boolean
}

export const fileCheckpointStore = (
  input: FileCheckpointStoreInput,
): CheckpointStorePortLike => {
  const validateStrict = input.validateOnRead ?? false

  const resolveFile = (gitCommonDir: string, runnerName: string): string =>
    join(gitCommonDir, `${runnerName}.checkpoint`)

  return {
    load: async ({ gitCommonDir, runnerName }) => {
      const filePath = resolveFile(gitCommonDir, runnerName)
      let text: string
      try {
        text = await readFile(filePath, "utf8")
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { readonly code?: unknown }).code === "ENOENT"
        ) {
          return null
        }
        throw error
      }

      const parser = validateStrict ? parseCheckpointTextStrict : parseCheckpointText
      const entries = parser({ text })
      const raw = validateRawCheckpoint({ entries })
      return buildCheckpoint({ raw, clock: input.clock })
    },

    save: async ({ gitCommonDir, runnerName, checkpoint }) => {
      const filePath = resolveFile(gitCommonDir, runnerName)
      const serialized = serializeCheckpoint({ checkpoint, clock: input.clock })
      try {
        await writeAtomic({ filePath, content: serialized })
      } catch (error) {
        if (error instanceof AtomicFileError) {
          throw error
        }
        throw error
      }
    },

    clear: async ({ gitCommonDir, runnerName }) => {
      const filePath = resolveFile(gitCommonDir, runnerName)
      await cleanupAtomicTempFiles({ filePath })
      try {
        await unlink(filePath)
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
    },
  }
}

export const _internal = {
  dirname,
  SINGLE_VALUE_KEYS,
  MULTI_VALUE_KEYS,
}