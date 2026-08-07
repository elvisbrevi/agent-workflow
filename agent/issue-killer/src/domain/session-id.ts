export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export const SESSION_ID_MAX_LENGTH = 128

export type SessionId = string & { readonly __brand: "SessionId" }

export const parseSessionId = (value: string): SessionId | null => {
  if (typeof value !== "string") {
    return null
  }
  if (value.length === 0 || value.length > SESSION_ID_MAX_LENGTH) {
    return null
  }
  if (!SESSION_ID_PATTERN.test(value)) {
    return null
  }
  return value as SessionId
}

export const isSessionId = (value: unknown): value is SessionId =>
  typeof value === "string" && parseSessionId(value) !== null

export const sessionIdEquals = (left: SessionId, right: SessionId): boolean => left === right

export const sessionIdPrefix = (value: SessionId, max = 8): string => {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}
