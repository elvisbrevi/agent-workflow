// Reads and validates the issue-killer V2 configuration.
//
// The loader is the only module in this package that touches the
// filesystem. Three boundaries are kept explicit:
//   * argv + env parsing (`cli-args.ts`) — pure
//   * TOML parsing                              — uses `Bun.TOML.parse`
//   * filesystem checks (existence + writability) — injected via the
//     `LoadConfigEnvironment` seam so tests can run without a real disk
//
// Output is the loaded `LoadedConfig`, which extends the pure
// `ValidatedConfig` with the resolved path, the expanded `log_dir`,
// and the destructive-authorization decision for the run.

import { parseCliArgs, type CliArgs } from "./cli-args"
import {
  toIssueKillerError,
  validateConfig,
  type ValidatedConfig,
} from "./validation"

export type LoadConfigErrorCode =
  | "cli_error"
  | "toml_parse"
  | "file_missing"
  | "log_dir_unwritable"
  | "invalid_config"
  | "destructive_not_authorized"

export type LoadConfigError = {
  readonly kind: "error"
  readonly code: LoadConfigErrorCode
  readonly flag?: string
  readonly path?: string
  readonly message: string
}

export type LoadedConfig = ValidatedConfig & {
  readonly sourcePath: string
  readonly expandedLogDir: string
  readonly destructiveAuthorized: boolean
}

export type LoadConfigResult =
  | { readonly kind: "ok"; readonly config: LoadedConfig; readonly args: CliArgs }
  | LoadConfigError

export type LoadConfigFilesystem = {
  readonly mkdir: (path: string) => Promise<void>
  readonly writeFile: (path: string, body: string) => Promise<void>
}

export type LoadConfigEnvironment = {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly home: string
  readonly cwd: string
  readonly configPath: string
  readonly fileExists: (path: string) => Promise<boolean>
  readonly expandHome: (input: string) => string
  readonly fs: LoadConfigFilesystem
}

const TOML_PARSE_FAILURE = "issue-killer config: failed to parse TOML"

export const defaultConfigPath = (home: string): string =>
  `${home}/.config/issue-killer/config.toml`

export const expandHomePath = (input: string, home: string): string => {
  if (input === "~") return home
  if (input.startsWith("~/")) return `${home}/${input.slice(2)}`
  return input
}

const envFirst = (
  env: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string>,
): string | null => {
  for (const key of keys) {
    const value = env[key]
    if (value !== undefined && value !== "") return value
  }
  return null
}

export const resolveConfigPath = (input: {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly home: string
  readonly configPathOverride?: string
}): string => {
  const cli = parseCliArgs(input.argv)
  if (cli.kind === "error") {
    throw new Error(`resolveConfigPath called with bad args: ${cli.flag}`)
  }
  const fromCli = cli.args.configPath
  if (fromCli !== null) return fromCli
  if (input.configPathOverride !== undefined) return input.configPathOverride
  const envOverride = envFirst(input.env, ["ISSUE_KILLER_CONFIG_PATH", "ISSUE_RUNNER_CONFIG"])
  if (envOverride !== null) return envOverride
  return defaultConfigPath(input.home)
}

const parseTomlText = (text: string): unknown => {
  const parse = (globalThis as { Bun?: { TOML?: { parse: (input: string) => unknown } } }).Bun?.TOML
    ?.parse
  if (typeof parse !== "function") {
    throw new Error(`${TOML_PARSE_FAILURE}: Bun.TOML.parse is unavailable`)
  }
  return parse(text)
}

export const loadConfig = async (
  env: LoadConfigEnvironment,
): Promise<LoadConfigResult> => {
  const cliResult = parseCliArgs(env.argv)
  if (cliResult.kind === "error") {
    return {
      kind: "error",
      code: "cli_error",
      flag: cliResult.flag,
      message: cliResult.message,
    }
  }
  const args = cliResult.args

  const exists = await env.fileExists(env.configPath)
  if (!exists) {
    return {
      kind: "error",
      code: "file_missing",
      path: env.configPath,
      message: `config file not found: ${env.configPath}`,
    }
  }

  const text = await Bun.file(env.configPath).text()
  let parsed: unknown
  try {
    parsed = parseTomlText(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: "error",
      code: "toml_parse",
      path: env.configPath,
      message: `${TOML_PARSE_FAILURE}: ${message}`,
    }
  }

  const validation = validateConfig(parsed)
  if (validation.kind === "error") {
    const issue = toIssueKillerError(validation)
    return {
      kind: "error",
      code: "invalid_config",
      path: validation.path,
      message: `${validation.path}: ${validation.message}`,
    }
  }

  const expandedLogDir = env.expandHome(validation.config.logDir)
  const writable = await canWriteDirectory(expandedLogDir, env.fs)
  if (!writable) {
    return {
      kind: "error",
      code: "log_dir_unwritable",
      path: expandedLogDir,
      message: `log_dir is not writable: ${expandedLogDir}`,
    }
  }

  const assumeYes =
    args.assumeYes ||
    env.env["ISSUE_RUNNER_ASSUME_YES"] === "true" ||
    env.env["ISSUE_KILLER_ASSUME_YES"] === "true"

  const defaultProfile = validation.config.profiles.get(validation.config.defaultProfile)
  if (defaultProfile === undefined) {
    return {
      kind: "error",
      code: "invalid_config",
      path: "default_profile",
      message: `default_profile is not a declared profile: ${validation.config.defaultProfile}`,
    }
  }

  if (assumeYes && !defaultProfile.autoApprove) {
    return {
      kind: "error",
      code: "destructive_not_authorized",
      path: joinPath("profiles", defaultProfile.name, "options.auto_approve"),
      message:
        "non-interactive destructive mode requires auto_approve=true on the default profile",
    }
  }

  const destructiveAuthorized = assumeYes && defaultProfile.autoApprove

  const loaded: LoadedConfig = {
    defaultProfile: validation.config.defaultProfile,
    logDir: validation.config.logDir,
    profiles: validation.config.profiles,
    sourcePath: env.configPath,
    expandedLogDir,
    destructiveAuthorized,
  }

  return { kind: "ok", config: loaded, args }
}

const joinPath = (...segments: ReadonlyArray<string>): string =>
  segments.filter((s) => s.length > 0).join(".")

const canWriteDirectory = async (
  path: string,
  fs: LoadConfigFilesystem,
): Promise<boolean> => {
  try {
    await fs.mkdir(path)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== "EEXIST") {
      try {
        await fs.writeFile(`${path}/.issue-killer-write-probe`, "probe")
        return true
      } catch {
        return false
      }
    }
  }
  try {
    await fs.writeFile(`${path}/.issue-killer-write-probe`, "probe")
    return true
  } catch {
    return false
  }
}
