export const WORKER_STATUSES = [
  "ISSUE_COMPLETED",
  "QUEUE_EMPTY",
  "BLOCKED",
  "FAILED",
  "RECOVERY_REQUIRED",
] as const

export type WorkerStatus = (typeof WORKER_STATUSES)[number]

export type WorkerOutcome = {
  readonly status: WorkerStatus
  readonly issue: number
  readonly summary: string
}

const WORKER_STATUS_SET: ReadonlySet<string> = new Set<string>(WORKER_STATUSES)

export const isWorkerStatus = (value: unknown): value is WorkerStatus =>
  typeof value === "string" && WORKER_STATUS_SET.has(value)

export const workerStatusEquals = (left: WorkerStatus, right: WorkerStatus): boolean => left === right

export const parseWorkerOutcome = (input: unknown): WorkerOutcome | null => {
  if (typeof input !== "object" || input === null) {
    return null
  }
  const record = input as Record<string, unknown>
  const status = record["status"]
  const issue = record["issue"]
  const summary = record["summary"]
  if (!isWorkerStatus(status)) {
    return null
  }
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
    return null
  }
  if (typeof summary !== "string") {
    return null
  }
  return { status, issue, summary }
}

export const workerOutcomeSummary = (outcome: WorkerOutcome): string => {
  switch (outcome.status) {
    case "ISSUE_COMPLETED":
      return `completed issue ${outcome.issue}`
    case "QUEUE_EMPTY":
      return `queue empty at iteration issue ${outcome.issue}`
    case "BLOCKED":
      return `blocked on issue ${outcome.issue}`
    case "FAILED":
      return `failed on issue ${outcome.issue}`
    case "RECOVERY_REQUIRED":
      return `recovery required at issue ${outcome.issue}`
    default: {
      const exhaustive: never = outcome.status
      throw new Error(`unhandled worker status: ${exhaustive as string}`)
    }
  }
}

export const WORKER_STATUS_EXIT_CODE: Readonly<Record<WorkerStatus, number>> = {
  ISSUE_COMPLETED: 0,
  QUEUE_EMPTY: 0,
  BLOCKED: 2,
  FAILED: 1,
  RECOVERY_REQUIRED: 4,
}
