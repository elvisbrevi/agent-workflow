export const LIFECYCLE_STATES = [
  "starting",
  "issue_selected",
  "mutating",
  "branch_pushed",
  "pr_created",
  "pr_merged",
  "issue_closed",
  "verified",
  "issue_completed",
  "queue_empty",
  "blocked",
  "failed",
  "recovery_required",
  "fallback_in_progress",
] as const

export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

const LIFECYCLE_STATE_SET: ReadonlySet<string> = new Set<string>(LIFECYCLE_STATES)

export const isLifecycleState = (value: unknown): value is LifecycleState =>
  typeof value === "string" && LIFECYCLE_STATE_SET.has(value)

export const isTerminalLifecycleState = (state: LifecycleState): boolean => {
  switch (state) {
    case "issue_completed":
    case "queue_empty":
    case "blocked":
    case "failed":
    case "recovery_required":
      return true
    case "starting":
    case "issue_selected":
    case "mutating":
    case "branch_pushed":
    case "pr_created":
    case "pr_merged":
    case "issue_closed":
    case "verified":
    case "fallback_in_progress":
      return false
    default: {
      const exhaustive: never = state
      throw new Error(`unhandled lifecycle state: ${exhaustive as string}`)
    }
  }
}

export const isProgressedLifecycleState = (state: LifecycleState): boolean => {
  switch (state) {
    case "starting":
      return false
    case "issue_selected":
    case "mutating":
    case "branch_pushed":
    case "pr_created":
    case "pr_merged":
    case "issue_closed":
    case "verified":
    case "issue_completed":
    case "queue_empty":
    case "blocked":
    case "failed":
    case "recovery_required":
    case "fallback_in_progress":
      return true
    default: {
      const exhaustive: never = state
      throw new Error(`unhandled lifecycle state: ${exhaustive as string}`)
    }
  }
}

export const mostProgressedLifecycleState = (
  current: LifecycleState,
  terminal: LifecycleState,
): LifecycleState => {
  if (!isProgressedLifecycleState(current)) {
    return terminal
  }
  return current
}
