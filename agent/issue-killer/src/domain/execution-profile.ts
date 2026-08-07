import type { ProviderFailureCategory } from "./provider-failure"

export const EXECUTION_PROFILE_FIELD_KEYS = [
  "label",
  "cli",
  "command",
  "model",
  "options",
  "fallbacks",
] as const

export type ExecutionProfileFieldKey = (typeof EXECUTION_PROFILE_FIELD_KEYS)[number]

export const FALLBACK_VALIDATION_REASONS = [
  "unknown_reference",
  "duplicate_entry",
  "cycle",
  "empty_chain",
  "self_reference",
] as const

export type FallbackValidationReason = (typeof FALLBACK_VALIDATION_REASONS)[number]

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const CLI_ALLOWED: ReadonlySet<string> = new Set<string>(["opencode"])
const COMMAND_ALLOWED: ReadonlySet<string> = new Set<string>(["opencode"])

export type ProfileOptions = Readonly<Record<string, string | number | boolean>>

export type ExecutionProfile = {
  readonly name: string
  readonly label: string
  readonly cli: "opencode"
  readonly command: "opencode"
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly autoApprove: boolean
  readonly options: ProfileOptions
  readonly fallbacks: ReadonlyArray<string>
}

export const FALLBACK_REASON_LABEL: Readonly<Record<FallbackValidationReason, string>> = {
  unknown_reference: "fallback profile is not declared",
  duplicate_entry: "fallback chain contains duplicates",
  cycle: "fallback chain forms a cycle",
  empty_chain: "fallback chain is empty",
  self_reference: "fallback chain references the primary profile",
}

export type FallbackValidation =
  | { readonly kind: "ok"; readonly chain: ReadonlyArray<string> }
  | { readonly kind: "invalid"; readonly reason: FallbackValidationReason; readonly offending: string }

export const isValidProfileName = (value: string): boolean => PROFILE_NAME_PATTERN.test(value)

export type ProfileGraph = Readonly<Record<string, ReadonlyArray<string>>>

export const detectCycle = (graph: ProfileGraph): string | null => {
  const visited = new Set<string>()
  const onStack = new Set<string>()
  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) {
      const cycle = dfsCycle(graph, node, visited, onStack)
      if (cycle !== null) {
        return cycle
      }
    }
  }
  return null
}

const dfsCycle = (
  graph: ProfileGraph,
  node: string,
  visited: Set<string>,
  onStack: Set<string>,
): string | null => {
  visited.add(node)
  onStack.add(node)
  const edges = graph[node] ?? []
  for (const edge of edges) {
    if (!visited.has(edge)) {
      const nested = dfsCycle(graph, edge, visited, onStack)
      if (nested !== null) {
        return nested
      }
    } else if (onStack.has(edge)) {
      return edge
    }
  }
  onStack.delete(node)
  return null
}

export const validateFallbackChain = (
  primary: string,
  fallbacks: ReadonlyArray<string>,
  knownProfiles: ReadonlySet<string>,
): FallbackValidation => {
  if (fallbacks.length === 0) {
    return { kind: "ok", chain: [] as ReadonlyArray<string> }
  }
  for (const entry of fallbacks) {
    if (entry === primary) {
      return { kind: "invalid", reason: "self_reference", offending: entry }
    }
    if (!knownProfiles.has(entry)) {
      return { kind: "invalid", reason: "unknown_reference", offending: entry }
    }
  }
  const seen = new Set<string>()
  for (const entry of fallbacks) {
    if (seen.has(entry)) {
      return { kind: "invalid", reason: "duplicate_entry", offending: entry }
    }
    seen.add(entry)
  }
  const graph: Record<string, ReadonlyArray<string>> = {
    [primary]: fallbacks as ReadonlyArray<string>,
  }
  for (const fallback of fallbacks) {
    graph[fallback] = []
  }
  const cycle = detectCycle(graph as ProfileGraph)
  if (cycle !== null) {
    return { kind: "invalid", reason: "cycle", offending: cycle }
  }
  return { kind: "ok", chain: fallbacks }
}

export const validateExecutionProfile = (
  profile: ExecutionProfile,
  knownProfiles: ReadonlySet<string>,
): FallbackValidation => {
  if (!isValidProfileName(profile.name)) {
    return { kind: "invalid", reason: "unknown_reference", offending: profile.name }
  }
  if (!CLI_ALLOWED.has(profile.cli)) {
    return { kind: "invalid", reason: "unknown_reference", offending: profile.cli }
  }
  if (!COMMAND_ALLOWED.has(profile.command)) {
    return { kind: "invalid", reason: "unknown_reference", offending: profile.command }
  }
  if (profile.providerID.length === 0 || profile.modelID.length === 0) {
    return { kind: "invalid", reason: "unknown_reference", offending: "model" }
  }
  if (profile.fallbacks.includes(profile.name)) {
    return { kind: "invalid", reason: "self_reference", offending: profile.name }
  }
  return validateFallbackChain(profile.name, profile.fallbacks, knownProfiles)
}

export type FallbackPosition = {
  readonly chain: ReadonlyArray<string>
  readonly index: number
}

export const fallbackPosition = (
  primary: string,
  fallbackChain: ReadonlyArray<string>,
  fallbackRemaining: ReadonlyArray<string>,
): FallbackPosition => {
  const fullChain: ReadonlyArray<string> = [primary, ...fallbackChain]
  if (fallbackRemaining.length === 0) {
    return { chain: fullChain, index: 0 }
  }
  const remaining = fallbackRemaining[0]
  if (remaining === undefined) {
    return { chain: fullChain, index: 0 }
  }
  const absoluteIndex = fallbackChain.indexOf(remaining)
  if (absoluteIndex < 0) {
    return { chain: fullChain, index: 0 }
  }
  return { chain: fullChain, index: absoluteIndex + 1 }
}

export const advanceFallback = (
  fallbackChain: ReadonlyArray<string>,
  failedProfile: string,
  category: ProviderFailureCategory,
): { readonly next: string | undefined; readonly remaining: ReadonlyArray<string> } => {
  if (category === "none") {
    return { next: undefined, remaining: fallbackChain }
  }
  const failedIndex = fallbackChain.indexOf(failedProfile)
  if (failedIndex < 0) {
    return { next: undefined, remaining: fallbackChain }
  }
  const remaining = fallbackChain.slice(failedIndex + 1)
  const next = remaining[0]
  return { next, remaining }
}
