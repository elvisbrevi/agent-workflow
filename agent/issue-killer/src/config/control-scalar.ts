// Validation for control-character injection inside TOML scalars.
//
// `Bun.TOML.parse` will happily accept strings that embed `\n`, `\r`, or
// `NUL`. The issue-killer V2 contract requires those scalars to be
// rejected at load time so a malicious config cannot inject newlines
// into logs, status files, checkpoint lines, or shell-rendered error
// messages. See issue #80 and the migration plan §10 code-review
// "newline injection / trailing junk" cases.

export const CONTROL_SCALAR_REASONS = ["newline", "carriage_return", "nul", "not_string"] as const

export type ControlScalarReason = (typeof CONTROL_SCALAR_REASONS)[number]

export type ControlScalarIssue = {
  readonly path: string
  readonly reason: ControlScalarReason
  readonly value: string
}

const formatControlChar = (char: string): string => {
  const code = char.charCodeAt(0)
  if (code === 0x0a) return "\\x0a"
  if (code === 0x0d) return "\\x0d"
  if (code === 0x00) return "\\x00"
  return `\\x${code.toString(16).padStart(2, "0")}`
}

const detectControlChar = (value: string): ControlScalarReason | null => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0x0a) return "newline"
    if (code === 0x0d) return "carriage_return"
    if (code === 0x00) return "nul"
  }
  return null
}

export const validateScalarString = (
  input: unknown,
  path: string,
): ControlScalarIssue | null => {
  if (typeof input !== "string") {
    return { path, reason: "not_string", value: formatControlChar("\u0000") }
  }
  const reason = detectControlChar(input)
  if (reason === null) return null
  const culprit: Record<ControlScalarReason, string> = {
    newline: formatControlChar("\n"),
    carriage_return: formatControlChar("\r"),
    nul: formatControlChar("\u0000"),
    not_string: formatControlChar("\u0000"),
  }
  return { path, reason, value: culprit[reason] }
}

export const collectControlScalarIssues = (
  value: unknown,
  path: string,
): ReadonlyArray<ControlScalarIssue> => {
  const issue = validateScalarString(value, path)
  return issue === null ? [] : [issue]
}
