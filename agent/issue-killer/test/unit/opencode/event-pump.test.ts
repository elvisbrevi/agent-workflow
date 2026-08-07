import { expect, test } from "bun:test"
import { parseSessionId } from "../../../src/domain/session-id"
import { drainSessionEvents } from "../../../src/opencode/event-pump"

async function* fromEvents(events: ReadonlyArray<unknown>): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

test("drains every matching event, ignores foreign sessions, and captures a session id from any event shape", async () => {
  const seen: string[] = []
  const captured: string[] = []
  const result = await drainSessionEvents({
    events: fromEvents([
      { type: "server.connected", properties: {} },
      { type: "text", sessionID: "ses_from_text" },
      { type: "session.next.tool.called", properties: { sessionID: "ses_foreign", tool: "read" } },
      { type: "session.next.tool.called", properties: { sessionID: "ses_from_text", tool: "read" } },
      { type: "session.next.tool.success", properties: { sessionID: "ses_from_text", tool: "read" } },
      { type: "message.updated", properties: {
        sessionID: "ses_from_text",
        info: { role: "assistant", structured: { status: "ISSUE_COMPLETED", issue: 84, summary: "complete" } },
      } },
    ]),
    expectedIssue: 84,
    onSessionCaptured: (sessionId) => { captured.push(sessionId) },
    onEvent: (event) => { seen.push(event.type) },
  })

  expect(result.capturedSessionId).toBe(parseSessionId("ses_from_text"))
  expect(captured).toEqual(["ses_from_text"])
  expect(result.eventsSeen).toBe(5)
  expect(result.eventsIgnored).toBe(1)
  expect(seen).toEqual([
    "server.connected",
    "text",
    "session.next.tool.called",
    "session.next.tool.success",
    "message.updated",
  ])
  expect(result.outcome).toEqual({ status: "ISSUE_COMPLETED", issue: 84, summary: "complete" })
})

test("does not fail the stream on malformed events and stops on an unexpected permission request", async () => {
  const result = await drainSessionEvents({
    events: fromEvents([
      null,
      { type: "permission.v2.asked", properties: { sessionID: "ses_permission", action: "edit" } },
      { type: "message.updated", properties: { sessionID: "ses_permission", info: { role: "assistant" } } },
    ]),
    expectedSessionId: parseSessionId("ses_permission") ?? undefined,
    expectedIssue: 84,
    autonomous: true,
  })

  expect(result.malformedEvents).toBe(1)
  expect(result.permissionStopped).toBe(true)
  expect(result.eventsSeen).toBe(1)
  expect(result.outcome).toBeNull()
})

test("rejects contradictory structured outcomes", async () => {
  const result = await drainSessionEvents({
    events: fromEvents([
      { type: "message.updated", properties: {
        sessionID: "ses_outcome",
        info: { role: "assistant", structured: { status: "ISSUE_COMPLETED", issue: 84, summary: "one" } },
      } },
      { type: "message.updated", properties: {
        sessionID: "ses_outcome",
        info: { role: "assistant", structured: { status: "FAILED", issue: 84, summary: "two" } },
      } },
    ]),
    expectedSessionId: parseSessionId("ses_outcome") ?? undefined,
    expectedIssue: 84,
  })

  expect(result.malformedOutcome).toBe(true)
  expect(result.outcome).toBeNull()
})

test("accepts a compatibility marker split across text events", async () => {
  const result = await drainSessionEvents({
    events: fromEvents([
      { type: "message.part.updated", properties: {
        sessionID: "ses_marker",
        part: { type: "text", text: "ISSUE_KILLER_STATUS=ISSUE_" },
      } },
      { type: "message.part.updated", properties: {
        sessionID: "ses_marker",
        part: { type: "text", text: "COMPLETED" },
      } },
    ]),
    expectedSessionId: parseSessionId("ses_marker") ?? undefined,
    expectedIssue: 84,
  })

  expect(result.outcome?.status).toBe("ISSUE_COMPLETED")
  expect(result.missingOutcome).toBe(false)
})
