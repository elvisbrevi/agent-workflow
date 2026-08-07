export const PROVIDER_FAILURE_CATEGORIES = [
  "none",
  "provider_quota",
  "provider_rate_limit",
  "provider_model_unavailable",
] as const

export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number]

type ErrorRecord = Readonly<Record<string, unknown>>

const PROVIDER_FAILURE_CATEGORY_SET: ReadonlySet<string> = new Set<string>(PROVIDER_FAILURE_CATEGORIES)

export const isProviderFailureCategory = (value: unknown): value is ProviderFailureCategory =>
  typeof value === "string" && PROVIDER_FAILURE_CATEGORY_SET.has(value)

export const isFallbackEligible = (category: ProviderFailureCategory): boolean => {
  switch (category) {
    case "provider_quota":
    case "provider_rate_limit":
    case "provider_model_unavailable":
      return true
    case "none":
      return false
    default: {
      const exhaustive: never = category
      throw new Error(`unhandled provider failure category: ${exhaustive as string}`)
    }
  }
}

const errorRecord = (error: unknown): ErrorRecord => {
  if (typeof error !== "object" || error === null) return {}
  return error as ErrorRecord
}

const nestedStatus = (error: ErrorRecord): number | undefined => {
  const response = errorRecord(error.response)
  const data = errorRecord(error.data)
  const candidates: unknown[] = [
    error.status,
    error.statusCode,
    response?.status,
    response?.statusCode,
    data?.status,
    data?.statusCode,
  ]
  return candidates.find((value): value is number => typeof value === "number" && Number.isInteger(value))
}

const diagnosticText = (error: unknown): string => {
  const record = errorRecord(error)
  const nested = [record.response, record.data]
    .map((value) => errorRecord(value))
    .flatMap((value) => [value.name, value.code, value.message, value.type])
  const parts = [record.name, record.code, record.message, record.type, ...nested]
  return parts.filter((value): value is string => typeof value === "string").join(" ").toLowerCase()
}

/** Classify provider failures using typed/status fields before diagnostics text. */
export const classifyProviderFailure = (error: unknown): ProviderFailureCategory => {
  const record = errorRecord(error)
  const status = nestedStatus(record)
  const code = typeof record.code === "string" ? record.code.toLowerCase() : ""
  const name = typeof record.name === "string" ? record.name.toLowerCase() : ""

  if (status === 429 || /rate.?limit|too.?many/.test(code) || /rate.?limit/.test(name)) {
    return "provider_rate_limit"
  }
  if (status === 402 || /quota|billing|credit/.test(code) || /quota|billing|credit/.test(name)) {
    return "provider_quota"
  }
  if (status === 404 || /model.?not|model.?unavailable|model.?missing/.test(code) || /model.?not|model.?unavailable/.test(name)) {
    return "provider_model_unavailable"
  }

  const text = diagnosticText(error)
  if (/rate.?limit|too many requests|http 429/.test(text)) return "provider_rate_limit"
  if (/quota|billing limit|insufficient credit|http 402/.test(text)) return "provider_quota"
  if (/model (?:is )?(?:unavailable|not found|missing)|model_not_found|http 404/.test(text)) {
    return "provider_model_unavailable"
  }
  return "none"
}

export const isTransportFailure = (error: unknown): boolean => {
  const record = errorRecord(error)
  const code = typeof record.code === "string" ? record.code.toUpperCase() : ""
  const name = typeof record.name === "string" ? record.name : ""
  const status = nestedStatus(record)
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return true
  return name === "FetchError" || name === "NetworkError" || /fetch failed|socket hang up|connection reset/i.test(diagnosticText(error))
}

export type ProviderFailureReason =
  | "transport_disconnect"
  | "invalid_status"
  | "client_error"
  | "authorization_missing"
  | "permission_prompted"
  | "structured_output_failed"
  | "session_error"

export const providerFailureFromReason = (reason: ProviderFailureReason): ProviderFailureCategory => {
  switch (reason) {
    case "transport_disconnect":
      return "none"
    case "invalid_status":
      return "none"
    case "client_error":
      return "none"
    case "authorization_missing":
      return "none"
    case "permission_prompted":
      return "none"
    case "structured_output_failed":
      return "none"
    case "session_error":
      return "none"
    default: {
      const exhaustive: never = reason
      throw new Error(`unhandled provider failure reason: ${exhaustive as string}`)
    }
  }
}

export const PROVIDER_FAILURE_CATEGORY_LABEL: Readonly<Record<ProviderFailureCategory, string>> = {
  none: "no provider failure",
  provider_quota: "exhausted provider quota",
  provider_rate_limit: "persistent provider rate limit",
  provider_model_unavailable: "model unavailable",
}
