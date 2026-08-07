// Parses the issue-killer V2 CLI arguments without ever invoking a shell.
//
// Every supported flag is allowlisted; unknown flags, flags missing
// required values, and values that fail their own format checks produce
// a structured error carrying the offending flag name and a message the
// operator can read on stderr. The contract (issue #80) is explicit:
// missing-value flags must surface as clear errors, never as
// `set -u`-style unbound noise or `NaN`.

export const SUPPORTED_FLAGS = [
  "--config",
  "--base-branch",
  "--iteration-limit",
  "--assume-yes",
  "--no-assume-yes",
  "--yes",
  "--hu",
  "--adopt-issue",
  "--adopt",
] as const

export type SupportedFlag = (typeof SUPPORTED_FLAGS)[number]

export type CliArgs = {
  readonly configPath: string | null
  readonly baseBranch: string | null
  readonly assumeYes: boolean
  readonly iterationLimit: number | null
  readonly hu: number | null
  readonly adoptIssue: string | null
  readonly extras: ReadonlyArray<string>
}

export type CliParseError = {
  readonly kind: "error"
  readonly flag: string
  readonly message: string
}

export type CliParseResult =
  | { readonly kind: "ok"; readonly args: CliArgs }
  | CliParseError

const VALUE_FLAGS: ReadonlySet<string> = new Set<string>([
  "--config",
  "--base-branch",
  "--iteration-limit",
  "--hu",
  "--adopt-issue",
  "--adopt",
])

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set<string>(["--assume-yes", "--yes"])

const KNOWN_PREFIX_FLAGS: ReadonlySet<string> = new Set<string>(
  SUPPORTED_FLAGS.map((flag) => `${flag}=`),
)

const isKnownPrefixFlag = (token: string): boolean => {
  for (const prefix of KNOWN_PREFIX_FLAGS) {
    if (token.startsWith(prefix)) return true
  }
  return false
}

const isKnownToken = (token: string): boolean => {
  if (SUPPORTED_FLAGS.includes(token as SupportedFlag)) return true
  if (isKnownPrefixFlag(token)) return true
  return false
}

export const parsePositiveInteger = (value: string, flag: string): number | string => {
  if (!/^[0-9]+$/.test(value)) {
    return `${flag} expects a positive integer; received ${JSON.stringify(value)}`
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    return `${flag} expects a positive integer; received ${JSON.stringify(value)}`
  }
  return parsed
}

export const parseCliArgs = (argv: ReadonlyArray<string>): CliParseResult => {
  const tokens = argv.slice()
  let configPath: string | null = null
  let baseBranch: string | null = null
  let assumeYes = false
  let iterationLimit: number | null = null
  let hu: number | null = null
  let adoptIssue: string | null = null
  const extras: string[] = []

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ""
    if (token === "--no-assume-yes") {
      assumeYes = false
      index += 1
      continue
    }
    if (BOOLEAN_FLAGS.has(token)) {
      assumeYes = true
      index += 1
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      const next = tokens[index + 1]
      if (next === undefined) {
        return {
          kind: "error",
          flag: token,
          message: `${token} requires a value (e.g. ${token} <value>)`,
        }
      }
      const value = next
      index += 2
      switch (token) {
        case "--config":
          if (value.length === 0) {
            return {
              kind: "error",
              flag: token,
              message: `${token} requires a non-empty path`,
            }
          }
          configPath = value
          continue
        case "--base-branch":
          if (value.length === 0) {
            return {
              kind: "error",
              flag: token,
              message: `${token} requires a non-empty branch name`,
            }
          }
          baseBranch = value
          continue
        case "--iteration-limit": {
          const parsed = parsePositiveInteger(value, token)
          if (typeof parsed === "string") {
            return { kind: "error", flag: token, message: parsed }
          }
          iterationLimit = parsed
          continue
        }
        case "--hu": {
          const parsed = parsePositiveInteger(value, token)
          if (typeof parsed === "string") {
            return { kind: "error", flag: token, message: parsed }
          }
          hu = parsed
          continue
        }
        case "--adopt-issue":
        case "--adopt":
          if (value.length === 0) {
            return {
              kind: "error",
              flag: token,
              message: `${token} requires a non-empty identity`,
            }
          }
          adoptIssue = value
          continue
        default:
          return {
            kind: "error",
            flag: token,
            message: `${token} is not a recognized flag`,
          }
      }
    }
    if (token.startsWith("--") && token.includes("=")) {
      const equals = token.indexOf("=")
      const name = token.slice(0, equals)
      const value = token.slice(equals + 1)
      if (!SUPPORTED_FLAGS.includes(name as SupportedFlag)) {
        return {
          kind: "error",
          flag: name,
          message: `unknown flag: ${name}`,
        }
      }
      if (BOOLEAN_FLAGS.has(name)) {
        if (value !== "true" && value !== "false") {
          return {
            kind: "error",
            flag: name,
            message: `${name} does not take a value; use --no-${name.slice(2)} to clear`,
          }
        }
        assumeYes = value === "true"
        index += 1
        continue
      }
      if (VALUE_FLAGS.has(name)) {
        if (value.length === 0) {
          return {
            kind: "error",
            flag: name,
            message: `${name} requires a non-empty value`,
          }
        }
        switch (name) {
          case "--config":
            configPath = value
            break
          case "--base-branch":
            baseBranch = value
            break
          case "--iteration-limit": {
            const parsed = parsePositiveInteger(value, name)
            if (typeof parsed === "string") {
              return { kind: "error", flag: name, message: parsed }
            }
            iterationLimit = parsed
            break
          }
          case "--hu": {
            const parsed = parsePositiveInteger(value, name)
            if (typeof parsed === "string") {
              return { kind: "error", flag: name, message: parsed }
            }
            hu = parsed
            break
          }
          case "--adopt-issue":
          case "--adopt":
            adoptIssue = value
            break
          default:
            return {
              kind: "error",
              flag: name,
              message: `${name} is not a recognized flag`,
            }
        }
        index += 1
        continue
      }
    }
    if (token.startsWith("--")) {
      if (!isKnownToken(token)) {
        return {
          kind: "error",
          flag: token,
          message: `unknown flag: ${token}`,
        }
      }
      return {
        kind: "error",
        flag: token,
        message: `${token} is not yet implemented in V2`,
      }
    }
    extras.push(token)
    index += 1
  }

  return {
    kind: "ok",
    args: {
      configPath,
      baseBranch,
      assumeYes,
      iterationLimit,
      hu,
      adoptIssue,
      extras,
    },
  }
}
