export type IssueKillerErrorCode =
  | "malformed_outcome"
  | "invalid_session_id"
  | "invalid_checkpoint"
  | "invalid_execution_profile"
  | "invalid_fallback_chain"
  | "lock_contention"
  | "missing_field"
  | "unknown_status"
  | "tracker_unavailable"
  | "runtime_unavailable"
  | "command_failed"
  | "permission_denied"
  | "drift_detected"
  | "resume_failed"

export class IssueKillerError extends Error {
  readonly code: IssueKillerErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: IssueKillerErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = "IssueKillerError"
    this.code = code
    this.details = details
  }

  withDetail(key: string, value: unknown): IssueKillerError {
    return new IssueKillerError(this.code, this.message, { ...this.details, [key]: value })
  }
}

const format = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export const issueKillerErrorMessage = (code: IssueKillerErrorCode, context: Readonly<Record<string, unknown>>): string => {
  const parts: string[] = [`issue-killer: ${code}`]
  for (const [key, value] of Object.entries(context)) {
    parts.push(`${key}=${format(value)}`)
  }
  return parts.join(" ")
}
