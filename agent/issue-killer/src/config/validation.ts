// Strict validation of an already-parsed TOML value into the typed
// `Config` shape consumed by the supervisor.
//
// The parser is responsible only for producing a structural value; this
// module rejects every configuration that the V2 contract must fail
// closed on:
//   * unknown top-level keys
//   * missing `default_profile` or `log_dir`
//   * profile names that are not identifier-safe
//   * `cli` / `command` other than `opencode`
//   * models that cannot be split once on `/`
//   * control characters inside any string scalar
//   * fallback chains that are empty, duplicate, self-referential,
//     reference an unknown profile, or form a cycle
//   * unknown profile or option keys (case-sensitive)
//   * reserved credential-like fields such as `token`, `api_key`
//
// The function is pure; filesystem checks (`log_dir` writability) and
// path expansion happen in `loader.ts`.

import { IssueKillerError } from "../domain/errors"
import {
  detectCycle,
  validateFallbackChain,
  type ExecutionProfile,
  type FallbackValidation,
} from "../domain/execution-profile"
import { collectControlScalarIssues, type ControlScalarIssue } from "./control-scalar"
import { splitModel } from "./model-split"

export const KNOWN_TOP_LEVEL_FIELDS = ["default_profile", "log_dir", "profiles"] as const

export const KNOWN_PROFILE_FIELDS = [
  "label",
  "cli",
  "command",
  "model",
  "options",
  "fallbacks",
] as const

export const KNOWN_OPTION_FIELDS = ["variant", "auto_approve"] as const

export const RESERVED_FORBIDDEN_FIELDS = [
  "token",
  "api_key",
  "apikey",
  "api-key",
  "password",
  "secret",
  "credential",
  "credentials",
  "auth_token",
  "access_token",
] as const

const TOP_LEVEL_FIELD_SET: ReadonlySet<string> = new Set<string>(KNOWN_TOP_LEVEL_FIELDS)
const PROFILE_FIELD_SET: ReadonlySet<string> = new Set<string>(KNOWN_PROFILE_FIELDS)
const OPTION_FIELD_SET: ReadonlySet<string> = new Set<string>(KNOWN_OPTION_FIELDS)
const RESERVED_FIELD_SET: ReadonlySet<string> = new Set<string>(RESERVED_FORBIDDEN_FIELDS)

export type ProfileOptions = Readonly<Record<string, string | number | boolean>>

export type ParsedProfileTable = {
  readonly label: string
  readonly cli: string
  readonly command: string
  readonly model: string
  readonly options: ProfileOptions
  readonly fallbacks: ReadonlyArray<string>
}

export type ParsedConfig = {
  readonly default_profile: string
  readonly log_dir: string
  readonly profiles: Readonly<Record<string, ParsedProfileTable>>
}

export type ValidatedConfig = {
  readonly defaultProfile: string
  readonly logDir: string
  readonly profiles: ReadonlyMap<string, ExecutionProfile>
}

export type ProfileValidation =
  | { readonly kind: "ok"; readonly profile: ExecutionProfile }
  | { readonly kind: "error"; readonly path: string; readonly message: string }

export type ConfigValidation =
  | { readonly kind: "ok"; readonly config: ValidatedConfig }
  | { readonly kind: "error"; readonly path: string; readonly message: string }

const joinPath = (...segments: ReadonlyArray<string>): string => segments.filter((s) => s.length > 0).join(".")

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object") return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const collectStringControlIssues = (
  value: unknown,
  path: string,
): ReadonlyArray<ControlScalarIssue> => {
  if (typeof value === "string") {
    return collectControlScalarIssues(value, path)
  }
  if (Array.isArray(value)) {
    const issues: ControlScalarIssue[] = []
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i]
      issues.push(
        ...collectControlScalarIssues(item, joinPath(path, `[${i.toString()}]`)),
      )
    }
    return issues
  }
  return []
}

const isValidProfileName = (name: string): boolean => /^[A-Za-z0-9_-]+$/.test(name)

export const validateProfileTable = (
  name: string,
  raw: unknown,
): ProfileValidation => {
  const basePath = joinPath("profiles", name)
  if (!isPlainObject(raw)) {
    return { kind: "error", path: basePath, message: "profile must be a table" }
  }
  if (!isValidProfileName(name)) {
    return {
      kind: "error",
      path: basePath,
      message: "profile name must match [A-Za-z0-9_-]+",
    }
  }
  for (const key of Object.keys(raw)) {
    if (RESERVED_FIELD_SET.has(key)) {
      return {
        kind: "error",
        path: basePath,
        message: `credential-like field ${key} is forbidden in issue-killer config`,
      }
    }
    if (!PROFILE_FIELD_SET.has(key)) {
      return {
        kind: "error",
        path: joinPath(basePath, key),
        message: `unknown profile field: ${key}`,
      }
    }
  }

  const label = raw["label"]
  const cli = raw["cli"]
  const command = raw["command"]
  const model = raw["model"]
  const fallbacks = raw["fallbacks"]
  const optionsRaw = raw["options"] ?? {}

  if (typeof label !== "string") {
    return {
      kind: "error",
      path: joinPath(basePath, "label"),
      message: "label must be a string",
    }
  }
  if (label.length === 0) {
    return {
      kind: "error",
      path: joinPath(basePath, "label"),
      message: "label must not be empty",
    }
  }
  if (cli !== "opencode") {
    return {
      kind: "error",
      path: joinPath(basePath, "cli"),
      message: `cli must be 'opencode' (received ${JSON.stringify(cli)})`,
    }
  }
  if (command !== "opencode") {
    return {
      kind: "error",
      path: joinPath(basePath, "command"),
      message: `command must be 'opencode' (received ${JSON.stringify(command)})`,
    }
  }
  if (typeof model !== "string") {
    return {
      kind: "error",
      path: joinPath(basePath, "model"),
      message: "model must be a string",
    }
  }
  if (fallbacks !== undefined && !Array.isArray(fallbacks)) {
    return {
      kind: "error",
      path: joinPath(basePath, "fallbacks"),
      message: "fallbacks must be an array",
    }
  }
  const fallbackList: string[] = []
  if (Array.isArray(fallbacks)) {
    for (let i = 0; i < fallbacks.length; i += 1) {
      const entry = fallbacks[i]
      if (typeof entry !== "string") {
        return {
          kind: "error",
          path: joinPath(basePath, `fallbacks[${i.toString()}]`),
          message: "fallback entries must be strings",
        }
      }
      fallbackList.push(entry)
    }
  }
  if (optionsRaw !== undefined && !isPlainObject(optionsRaw)) {
    return {
      kind: "error",
      path: joinPath(basePath, "options"),
      message: "options must be a table",
    }
  }
  const options: Record<string, string | number | boolean> = {}
  if (isPlainObject(optionsRaw)) {
    for (const key of Object.keys(optionsRaw)) {
      if (RESERVED_FIELD_SET.has(key)) {
        return {
          kind: "error",
          path: joinPath(basePath, "options", key),
          message: `credential-like option ${key} is forbidden`,
        }
      }
      if (!OPTION_FIELD_SET.has(key)) {
        return {
          kind: "error",
          path: joinPath(basePath, "options", key),
          message: `unknown option: ${key}`,
        }
      }
      const value = optionsRaw[key]
      if (key === "auto_approve") {
        if (typeof value !== "boolean") {
          return {
            kind: "error",
            path: joinPath(basePath, "options", "auto_approve"),
            message: "auto_approve must be a boolean",
          }
        }
        options["auto_approve"] = value
      } else if (key === "variant") {
        if (typeof value !== "string" && typeof value !== "number") {
          return {
            kind: "error",
            path: joinPath(basePath, "options", "variant"),
            message: "variant must be a string or number",
          }
        }
        options["variant"] = value as string | number
      }
    }
  }

  const controlIssues: ControlScalarIssue[] = [
    ...collectStringControlIssues(label, joinPath(basePath, "label")),
    ...collectStringControlIssues(model, joinPath(basePath, "model")),
    ...collectStringControlIssues(fallbackList, joinPath(basePath, "fallbacks")),
    ...collectStringControlIssues(name, basePath),
  ]
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string") {
      controlIssues.push(...collectControlScalarIssues(value, joinPath(basePath, "options", key)))
    }
  }
  if (controlIssues.length > 0) {
    const first = controlIssues[0] as ControlScalarIssue
    return {
      kind: "error",
      path: first.path,
      message: `control character in ${first.path} (${first.reason})`,
    }
  }

  const split = splitModel(model)
  if (split.kind === "invalid") {
    return {
      kind: "error",
      path: joinPath(basePath, "model"),
      message: `invalid model: ${split.reason}`,
    }
  }

  const profile: ExecutionProfile = {
    name,
    label,
    cli: "opencode",
    command: "opencode",
    providerID: split.providerID,
    modelID: split.modelID,
    autoApprove: options["auto_approve"] === true,
    options: { ...options },
    fallbacks: fallbackList,
  }
  if (Object.hasOwn(options, "variant")) {
    const variantValue = options["variant"]
    if (typeof variantValue === "string") {
      ;(profile as { variant?: string }).variant = variantValue
    } else if (typeof variantValue === "number") {
      ;(profile as { variant?: string }).variant = variantValue.toString()
    }
  }

  if (fallbackList.includes(name)) {
    return {
      kind: "error",
      path: joinPath(basePath, "fallbacks"),
      message: "fallback chain references the primary profile",
    }
  }

  const seen = new Set<string>()
  for (const entry of fallbackList) {
    if (seen.has(entry)) {
      return {
        kind: "error",
        path: joinPath(basePath, "fallbacks"),
        message: `duplicate fallback entry: ${entry}`,
      }
    }
    seen.add(entry)
  }

  return { kind: "ok", profile }
}

const describeFallback = (validation: FallbackValidation): string => {
  if (validation.kind === "ok") return ""
  switch (validation.reason) {
    case "unknown_reference":
      return `unknown fallback reference: ${validation.offending}`
    case "duplicate_entry":
      return `duplicate fallback entry: ${validation.offending}`
    case "cycle":
      return `fallback chain forms a cycle at ${validation.offending}`
    case "empty_chain":
      return "fallback chain is empty"
    case "self_reference":
      return `fallback chain references the primary profile: ${validation.offending}`
  }
}

export const validateConfig = (input: unknown): ConfigValidation => {
  if (!isPlainObject(input)) {
    return {
      kind: "error",
      path: "",
      message: "config must be a TOML table",
    }
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_FIELD_SET.has(key)) {
      return {
        kind: "error",
        path: key,
        message: `unknown top-level key: ${key}`,
      }
    }
  }

  const defaultProfileRaw = input["default_profile"]
  const logDirRaw = input["log_dir"]
  const profilesRaw = input["profiles"]

  if (defaultProfileRaw === undefined) {
    return { kind: "error", path: "default_profile", message: "missing default_profile" }
  }
  if (typeof defaultProfileRaw !== "string") {
    return { kind: "error", path: "default_profile", message: "default_profile must be a string" }
  }
  const controlDefault = collectControlScalarIssues(defaultProfileRaw, "default_profile")
  if (controlDefault.length > 0) {
    return {
      kind: "error",
      path: "default_profile",
      message: `control character in default_profile (${controlDefault[0]?.reason ?? "unknown"})`,
    }
  }
  if (!isValidProfileName(defaultProfileRaw)) {
    return {
      kind: "error",
      path: "default_profile",
      message: "default_profile must match [A-Za-z0-9_-]+",
    }
  }

  if (logDirRaw === undefined) {
    return { kind: "error", path: "log_dir", message: "missing log_dir" }
  }
  if (typeof logDirRaw !== "string") {
    return { kind: "error", path: "log_dir", message: "log_dir must be a string" }
  }
  const controlLogDir = collectControlScalarIssues(logDirRaw, "log_dir")
  if (controlLogDir.length > 0) {
    return {
      kind: "error",
      path: "log_dir",
      message: `control character in log_dir (${controlLogDir[0]?.reason ?? "unknown"})`,
    }
  }
  if (logDirRaw.length === 0) {
    return { kind: "error", path: "log_dir", message: "log_dir must not be empty" }
  }

  if (!isPlainObject(profilesRaw)) {
    return { kind: "error", path: "profiles", message: "profiles must be a table" }
  }
  const profileKeys = Object.keys(profilesRaw)
  if (profileKeys.length === 0) {
    return { kind: "error", path: "profiles", message: "at least one profile is required" }
  }
  const validatedProfiles = new Map<string, ExecutionProfile>()
  for (const name of profileKeys) {
    const result = validateProfileTable(name, profilesRaw[name])
    if (result.kind === "error") {
      return { kind: "error", path: result.path, message: result.message }
    }
    validatedProfiles.set(name, result.profile)
  }

  if (!validatedProfiles.has(defaultProfileRaw)) {
    return {
      kind: "error",
      path: "default_profile",
      message: `default_profile refers to undeclared profile ${JSON.stringify(defaultProfileRaw)}`,
    }
  }

  const knownNames = new Set<string>(validatedProfiles.keys())
  for (const profile of validatedProfiles.values()) {
    const validation = validateFallbackChain(profile.name, profile.fallbacks, knownNames)
    if (validation.kind === "invalid") {
      return {
        kind: "error",
        path: joinPath("profiles", profile.name, "fallbacks"),
        message: describeFallback(validation),
      }
    }
  }

  const graph: Record<string, ReadonlyArray<string>> = {}
  for (const [name, profile] of validatedProfiles) {
    graph[name] = profile.fallbacks
  }
  const cycleEntry = detectCycle(graph as Readonly<Record<string, ReadonlyArray<string>>>)
  if (cycleEntry !== null) {
    return {
      kind: "error",
      path: joinPath("profiles", cycleEntry, "fallbacks"),
      message: `fallback chain forms a cycle at ${cycleEntry}`,
    }
  }

  const config: ValidatedConfig = {
    defaultProfile: defaultProfileRaw,
    logDir: logDirRaw,
    profiles: validatedProfiles,
  }
  return { kind: "ok", config }
}

export const toIssueKillerError = (validation: ConfigValidation): IssueKillerError => {
  if (validation.kind === "ok") {
    throw new Error("toIssueKillerError called on successful validation")
  }
  const code = validation.path.startsWith("default_profile")
    ? "invalid_execution_profile"
    : validation.path === "log_dir"
    ? "missing_field"
    : "invalid_execution_profile"
  return new IssueKillerError(code, validation.message, { path: validation.path })
}
