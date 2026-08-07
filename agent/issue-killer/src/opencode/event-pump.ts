import type { HarnessLogPort } from "../domain/ports"
import { parseWorkerOutcome, type WorkerOutcome } from "../domain/outcome"
import { parseSessionId, type SessionId } from "../domain/session-id"
import { redactMultiline } from "../system/redaction"

type EventRecord = Readonly<Record<string, unknown>>

export type ObservedEvent = EventRecord & { readonly type: string }

export type EventPumpResult = {
  readonly eventsSeen: number
  readonly eventsIgnored: number
  readonly malformedEvents: number
  readonly capturedSessionId: SessionId | null
  readonly outcome: WorkerOutcome | null
  readonly malformedOutcome: boolean
  readonly missingOutcome: boolean
  readonly permissionStopped: boolean
}

export type EventPumpInput = {
  readonly events: AsyncIterable<unknown>
  readonly expectedSessionId?: SessionId
  readonly expectedIssue?: number
  readonly autonomous?: boolean
  readonly stopOnOutcome?: boolean
  readonly signal?: AbortSignal
  readonly harnessLog?: HarnessLogPort
  readonly runId?: string
  readonly onSessionCaptured?: (sessionId: SessionId) => Promise<void> | void
  readonly onEvent?: (event: ObservedEvent) => Promise<void> | void
}

type SessionField = { readonly present: boolean; readonly value?: unknown }

const recordOf = (value: unknown): EventRecord | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as EventRecord
}

const findSessionField = (value: unknown, depth = 0): SessionField => {
  const record = recordOf(value)
  if (record === null || depth > 4) return { present: false }
  for (const key of ["sessionID", "sessionId"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return { present: true, value: record[key] }
    }
  }
  for (const child of Object.values(record)) {
    const found = findSessionField(child, depth + 1)
    if (found.present) return found
  }
  return { present: false }
}

export const sessionIdFromEvent = (event: unknown): SessionId | null => {
  const field = findSessionField(event)
  if (!field.present || typeof field.value !== "string") return null
  return parseSessionId(field.value)
}

const eventType = (event: unknown): string | null => {
  const record = recordOf(event)
  return typeof record?.type === "string" ? record.type : null
}

const eventProperties = (event: ObservedEvent): EventRecord => recordOf(event.properties) ?? {}

const structuredCandidate = (event: ObservedEvent): unknown => {
  if (!event.type.includes("message.updated") && !event.type.includes("prompt.completed")) return undefined
  const properties = eventProperties(event)
  const info = recordOf(properties.info) ?? recordOf(event.info)
  if (info !== null && info.role !== "assistant") return undefined
  if (info !== null && Object.prototype.hasOwnProperty.call(info, "structured")) return info.structured
  if (Object.prototype.hasOwnProperty.call(properties, "structured")) return properties.structured
  return undefined
}

const textFromEvent = (event: ObservedEvent): string | null => {
  const properties = eventProperties(event)
  const part = recordOf(properties.part)
  if (typeof part?.text === "string") return part.text
  if (typeof properties.text === "string") return properties.text
  if (typeof properties.delta === "string") return properties.delta
  return null
}

const markerStatus = (text: string): WorkerOutcome["status"] | null => {
  const match = /(?:^|\n)ISSUE_KILLER_STATUS=(ISSUE_COMPLETED|QUEUE_EMPTY|BLOCKED|FAILED|RECOVERY_REQUIRED)(?:\s|$)/.exec(text)
  return match?.[1] as WorkerOutcome["status"] | undefined ?? null
}

const observedPayload = (event: ObservedEvent): Readonly<Record<string, unknown>> => {
  const properties = eventProperties(event)
  const payload: Record<string, unknown> = { type: event.type }
  const session = sessionIdFromEvent(event)
  if (session !== null) payload.session_id = session
  if (event.type === "file.watcher.updated" && typeof properties.event === "string") {
    payload.kind = "file_mutation"
    payload.file = properties.file
    payload.action = properties.event
  } else if (typeof properties.file === "string") {
    payload.kind = "file_edit"
    payload.file = properties.file
  } else if (event.type === "command.executed") {
    payload.kind = "command"
    payload.name = properties.name
    payload.argument_count = typeof properties.arguments === "string" && properties.arguments.length > 0
      ? properties.arguments.trim().split(/\s+/).length
      : 0
  } else if (typeof properties.command === "string") {
    payload.kind = "command"
    payload.command_name = properties.command.trim().split(/\s+/)[0] ?? ""
    payload.argument_count = properties.command.trim().split(/\s+/).slice(1).length
  } else if (event.type.includes("permission.") && typeof properties.action === "string") {
    payload.kind = "permission"
    payload.action = properties.action
  } else if (event.type.includes("tool.")) {
    payload.kind = "tool"
    payload.action = event.type.split(".").pop()
    payload.tool = properties.tool
  } else if (event.type === "session.error") {
    payload.kind = "error"
    const error = recordOf(properties.error)
    payload.error = error?.name
  } else {
    payload.kind = "progress"
  }
  return payload
}

const sameOutcome = (left: WorkerOutcome, right: WorkerOutcome): boolean =>
  left.status === right.status &&
  left.issue === right.issue &&
  (left.summary === right.summary || left.summary === "worker status marker" || right.summary === "worker status marker")

const redactEvent = (event: ObservedEvent): ObservedEvent => {
  const redact = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return redactMultiline(value).text
    if (value === null || typeof value !== "object") return value
    if (seen.has(value)) return "<redacted:circular>"
    seen.add(value)
    if (Array.isArray(value)) return value.map((entry) => redact(entry, seen))
    const record: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) record[key] = redact(entry, seen)
    return record
  }
  return redact(event, new WeakSet<object>()) as ObservedEvent
}

export const drainSessionEvents = async (input: EventPumpInput): Promise<EventPumpResult> => {
  let eventsSeen = 0
  let eventsIgnored = 0
  let malformedEvents = 0
  let capturedSessionId = input.expectedSessionId ?? null
  let outcome: WorkerOutcome | null = null
  let malformedOutcome = false
  let permissionStopped = false
  let markerBuffer = ""

  for await (const rawEvent of input.events) {
    if (input.signal?.aborted) break
    const type = eventType(rawEvent)
    if (type === null) {
      malformedEvents += 1
      continue
    }
    const event = rawEvent as ObservedEvent
    const sessionField = findSessionField(event)
    if (sessionField.present) {
      if (typeof sessionField.value !== "string" || parseSessionId(sessionField.value) === null) {
        malformedEvents += 1
        continue
      }
      const eventSessionId = parseSessionId(sessionField.value)
      if (capturedSessionId !== null && eventSessionId !== capturedSessionId) {
        eventsIgnored += 1
        continue
      }
      if (capturedSessionId === null && eventSessionId !== null) {
        capturedSessionId = eventSessionId
        await input.onSessionCaptured?.(eventSessionId)
      }
    }

    eventsSeen += 1
    if (input.harnessLog !== undefined && input.runId !== undefined) {
      await input.harnessLog.appendEvent({ runId: input.runId, payload: observedPayload(event) })
    }
    await input.onEvent?.(redactEvent(event))

    if (input.autonomous === true && /(^|\.)permission\.(?:v2\.)?asked$/.test(type)) {
      permissionStopped = true
      break
    }

    const candidate = structuredCandidate(event)
    if (candidate !== undefined) {
      const parsed = parseWorkerOutcome(candidate)
      if (parsed === null || (input.expectedIssue !== undefined && parsed.issue !== input.expectedIssue)) {
        malformedOutcome = true
        outcome = null
      } else if (outcome === null) {
        outcome = parsed
      } else if (!sameOutcome(outcome, parsed)) {
        malformedOutcome = true
        outcome = null
      } else if (outcome.summary === "worker status marker") {
        outcome = parsed
      }
      continue
    }

    const text = textFromEvent(event)
    if (text !== null) {
      markerBuffer = `${markerBuffer}${text}`.slice(-256)
      const status = markerStatus(markerBuffer)
      if (status !== null && input.expectedIssue !== undefined) {
        const markerOutcome: WorkerOutcome = {
          status,
          issue: input.expectedIssue,
          summary: "worker status marker",
        }
        if (outcome === null) outcome = markerOutcome
        else if (outcome.status !== markerOutcome.status) {
          malformedOutcome = true
          outcome = null
        }
      }
    }

    if (input.stopOnOutcome === true && outcome !== null && event.type === "session.idle") break
  }

  return {
    eventsSeen,
    eventsIgnored,
    malformedEvents,
    capturedSessionId,
    outcome,
    malformedOutcome,
    missingOutcome: outcome === null && !malformedOutcome && !permissionStopped,
    permissionStopped,
  }
}
