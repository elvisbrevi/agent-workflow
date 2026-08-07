import { describe, expect, test } from "bun:test"
import {
  WORKER_STATUSES,
  WORKER_STATUS_EXIT_CODE,
  WorkerOutcome,
  isWorkerStatus,
  parseWorkerOutcome,
  workerOutcomeSummary,
  workerStatusEquals,
} from "../../../src/domain/outcome"

describe("isWorkerStatus", () => {
  test("accepts the closed set of worker statuses", () => {
    for (const status of WORKER_STATUSES) {
      expect(isWorkerStatus(status)).toBe(true)
    }
  })

  test("rejects unknown statuses", () => {
    expect(isWorkerStatus("completed")).toBe(false)
    expect(isWorkerStatus("")).toBe(false)
    expect(isWorkerStatus(undefined)).toBe(false)
    expect(isWorkerStatus(null)).toBe(false)
    expect(isWorkerStatus(42)).toBe(false)
    expect(isWorkerStatus({ status: "ISSUE_COMPLETED" })).toBe(false)
  })
})

describe("parseWorkerOutcome", () => {
  test("parses a well-formed structured outcome", () => {
    const input: unknown = {
      status: "ISSUE_COMPLETED",
      issue: 79,
      summary: "issue-killer V2 scaffold landed",
    }
    const outcome = parseWorkerOutcome(input) as WorkerOutcome
    expect(outcome.status).toBe("ISSUE_COMPLETED")
    expect(outcome.issue).toBe(79)
    expect(outcome.summary).toBe("issue-killer V2 scaffold landed")
  })

  test("rejects non-object input", () => {
    expect(parseWorkerOutcome(null)).toBeNull()
    expect(parseWorkerOutcome("ISSUE_COMPLETED")).toBeNull()
    expect(parseWorkerOutcome(123)).toBeNull()
    expect(parseWorkerOutcome(undefined)).toBeNull()
  })

  test("rejects unknown statuses", () => {
    expect(parseWorkerOutcome({ status: "COMPLETED", issue: 1, summary: "" })).toBeNull()
  })

  test("rejects non-integer and non-positive issue numbers", () => {
    expect(parseWorkerOutcome({ status: "ISSUE_COMPLETED", issue: 1.5, summary: "" })).toBeNull()
    expect(parseWorkerOutcome({ status: "ISSUE_COMPLETED", issue: 0, summary: "" })).toBeNull()
    expect(parseWorkerOutcome({ status: "ISSUE_COMPLETED", issue: -3, summary: "" })).toBeNull()
    expect(parseWorkerOutcome({ status: "ISSUE_COMPLETED", issue: "1", summary: "" })).toBeNull()
  })

  test("rejects non-string summary", () => {
    expect(parseWorkerOutcome({ status: "ISSUE_COMPLETED", issue: 1, summary: 1 })).toBeNull()
    expect(parseWorkerOutcome({ status: "ISSUE_COMPLETED", issue: 1, summary: null })).toBeNull()
  })
})

describe("workerOutcomeSummary", () => {
  for (const status of WORKER_STATUSES) {
    test(`labels ${status} outcomes with the issue number`, () => {
      const outcome: WorkerOutcome = { status, issue: 41, summary: "" }
      const label = workerOutcomeSummary(outcome)
      expect(label).toContain("41")
      const normalized = status.replace(/_/g, " ").toLowerCase()
      const fragments = normalized.split(" ")
      for (const fragment of fragments) {
        expect(label.toLowerCase()).toContain(fragment)
      }
    })
  }
})

describe("WORKER_STATUS_EXIT_CODE", () => {
  test("encodes the canonical exit matrix for the closed status set", () => {
    expect(WORKER_STATUS_EXIT_CODE.ISSUE_COMPLETED).toBe(0)
    expect(WORKER_STATUS_EXIT_CODE.QUEUE_EMPTY).toBe(0)
    expect(WORKER_STATUS_EXIT_CODE.BLOCKED).toBe(2)
    expect(WORKER_STATUS_EXIT_CODE.FAILED).toBe(1)
    expect(WORKER_STATUS_EXIT_CODE.RECOVERY_REQUIRED).toBe(4)
  })

  test("covers exactly the closed status set", () => {
    expect(new Set(Object.keys(WORKER_STATUS_EXIT_CODE))).toEqual(new Set(WORKER_STATUSES))
  })
})

describe("workerStatusEquals", () => {
  test("compares statuses by value", () => {
    expect(workerStatusEquals("ISSUE_COMPLETED", "ISSUE_COMPLETED")).toBe(true)
    expect(workerStatusEquals("FAILED", "FAILED")).toBe(true)
    expect(workerStatusEquals("FAILED", "BLOCKED")).toBe(false)
  })
})
