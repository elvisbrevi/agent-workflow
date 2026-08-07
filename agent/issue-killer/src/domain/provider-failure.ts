export const PROVIDER_FAILURE_CATEGORIES = [
  "none",
  "provider_quota",
  "provider_rate_limit",
  "provider_model_unavailable",
] as const

export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number]

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
