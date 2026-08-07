import { appendFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import type { HarnessLogPort } from "../domain/ports"
import type { LifecycleState } from "../domain/lifecycle"
import { redactMultiline } from "../system/redaction"

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/

const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") return redactMultiline(value).text
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "<redacted:circular>"
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen))
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = redactValue(entry, seen)
  }
  return output
}

const assertRunId = (runId: string): void => {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid harness run id: ${runId}`)
  }
}

export type HarnessLogOptions = {
  readonly logDir: string
  readonly clock?: () => string
}

export const createHarnessLog = (options: HarnessLogOptions): HarnessLogPort => {
  const logDir = resolve(options.logDir)
  const clock = options.clock ?? (() => new Date().toISOString())

  const pathFor = (runId: string): string => {
    assertRunId(runId)
    return `${logDir}/${runId}.jsonl`
  }

  const append = async (runId: string, record: Readonly<Record<string, unknown>>): Promise<void> => {
    await mkdir(logDir, { recursive: true })
    const safe = redactValue(record, new WeakSet<object>())
    await appendFile(pathFor(runId), `${JSON.stringify(safe)}\n`, "utf8")
  }

  return {
    startRun: async ({ runId, repository }) => {
      await append(runId, { at: clock(), event: "run_started", run_id: runId, repository })
    },
    appendEvent: async ({ runId, payload }) => {
      await append(runId, { at: clock(), event: "observed", run_id: runId, payload })
    },
    endRun: async ({ runId, status }: { readonly runId: string; readonly status: LifecycleState }) => {
      await append(runId, { at: clock(), event: "run_finished", run_id: runId, status })
    },
    readRunPath: ({ runId }) => pathFor(runId),
  }
}
