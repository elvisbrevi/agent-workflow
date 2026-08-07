export type RedactionReason =
  | "authorization_header"
  | "bearer_token"
  | "credential_pair"
  | "provider_token"
  | "private_key_block"

const AUTHORIZATION_PATTERN = /(authorization)([\s:;,=]+)([A-Za-z0-9._~+/-]+)/gi

const BEARER_PATTERN = /\b(bearer)([\s:;,=]+)([A-Za-z0-9._~+/-]{6,})/gi

const CREDENTIAL_KEY_PATTERN =
  /\b(api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)([\s:;,=]+)(['"]?[A-Za-z0-9._~+/-]+['"]?)/gi

const PROVIDER_TOKEN_PATTERN = /\b(ghp_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|ghr_[A-Za-z0-9]+)\b/g

const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z ]+PRIVATE KEY-----/
const PRIVATE_KEY_END_PATTERN = /-----END [A-Z ]+PRIVATE KEY-----/

export const REDACTED_AUTHORIZATION = "<redacted:authorization>"
export const REDACTED_BEARER = "<redacted:bearer>"
export const REDACTED_CREDENTIAL = "<redacted:credential>"
export const REDACTED_PROVIDER_TOKEN = "<redacted:credential>"
export const REDACTED_PRIVATE_KEY = "<redacted:private-key>"

export type LineRedaction = {
  readonly text: string
  readonly reasons: ReadonlyArray<RedactionReason>
}

const replaceLineMatches = (
  text: string,
  pattern: RegExp,
  replacement: (match: string, ...groups: ReadonlyArray<string>) => string,
  reason: RedactionReason,
): { readonly text: string; readonly reasons: RedactionReason[] } => {
  const reasons: RedactionReason[] = []
  const next = text.replace(pattern, (match: string, ...groups: ReadonlyArray<string | undefined>) => {
    reasons.push(reason)
    const typed = groups.slice(0, groups.length - 2) as ReadonlyArray<string>
    return replacement(match, ...typed)
  })
  return { text: next, reasons }
}

export const redactLine = (input: string): LineRedaction => {
  let working = input
  const reasons: RedactionReason[] = []

  const authorization = replaceLineMatches(
    working,
    AUTHORIZATION_PATTERN,
    () => `${REDACTED_AUTHORIZATION}`,
    "authorization_header",
  )
  working = authorization.text
  reasons.push(...authorization.reasons)

  const bearer = replaceLineMatches(
    working,
    BEARER_PATTERN,
    () => `${REDACTED_BEARER}`,
    "bearer_token",
  )
  working = bearer.text
  reasons.push(...bearer.reasons)

  const credential = replaceLineMatches(
    working,
    CREDENTIAL_KEY_PATTERN,
    (_match: string, key: string) => `${key}=<redacted>`,
    "credential_pair",
  )
  working = credential.text
  reasons.push(...credential.reasons)

  const providerToken = replaceLineMatches(
    working,
    PROVIDER_TOKEN_PATTERN,
    () => `${REDACTED_PROVIDER_TOKEN}`,
    "provider_token",
  )
  working = providerToken.text
  reasons.push(...providerToken.reasons)

  return { text: working, reasons }
}

export type MultilineRedaction = {
  readonly text: string
  readonly reasons: ReadonlyArray<RedactionReason>
}

export const redactMultiline = (input: string): MultilineRedaction => {
  if (input.length === 0) {
    return { text: "", reasons: [] }
  }
  const lines = input.split("\n")
  const reasons: RedactionReason[] = []
  const out: string[] = []
  let inPrivateKey = false

  for (const line of lines) {
    if (inPrivateKey) {
      if (PRIVATE_KEY_END_PATTERN.test(line)) {
        inPrivateKey = false
        out.push(REDACTED_PRIVATE_KEY)
        reasons.push("private_key_block")
      } else {
        out.push("")
      }
      continue
    }
    if (PRIVATE_KEY_BEGIN_PATTERN.test(line)) {
      if (PRIVATE_KEY_END_PATTERN.test(line)) {
        out.push(REDACTED_PRIVATE_KEY)
        reasons.push("private_key_block")
      } else {
        inPrivateKey = true
        out.push(REDACTED_PRIVATE_KEY)
        reasons.push("private_key_block")
      }
      continue
    }
    const { text, reasons: lineReasons } = redactLine(line)
    out.push(text)
    reasons.push(...lineReasons)
  }

  return { text: out.join("\n"), reasons }
}

export const REDACTED_PLACEHOLDER_PATTERN = /<redacted:(authorization|bearer|credential|private-key)>/g

export const containsRedactionPlaceholder = (input: string): boolean =>
  REDACTED_PLACEHOLDER_PATTERN.test(input)