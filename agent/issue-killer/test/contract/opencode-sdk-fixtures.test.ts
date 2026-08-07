import { expect, test } from "bun:test"
import {
  apiError,
  autonomousPermission,
  model,
  permissionAskedEvent,
  promptInput,
  promptRequest,
  sessionErrorEvent,
  sessionPermissionRules,
  structuredAssistantFields,
  structuredOutput,
  structuredOutputError,
} from "../fixtures/opencode-sdk-contract"

test("pins the SDK prompt, output, model, permission, error, and event fields", async () => {
  const events = await Bun.file(new URL("../fixtures/opencode-sdk-events.json", import.meta.url)).json() as Array<{
    type: string
    properties?: { sessionID?: string }
  }>

  expect(promptInput.text).toContain("host-pinned")
  expect(promptRequest.body?.format).toEqual(structuredOutput)
  expect(promptRequest.body?.model).toEqual({ providerID: model.providerID, modelID: model.id })
  expect(promptRequest.body?.variant).toBe(model.variant)
  expect(autonomousPermission.edit).toBe("allow")
  expect(sessionPermissionRules[0]?.action).toBe("allow")
  expect(structuredAssistantFields.structured).toEqual({
    status: "ISSUE_COMPLETED",
    issue: 123,
    summary: "validated",
  })
  expect(structuredOutputError.data.retries).toBe(2)
  expect(apiError.data.isRetryable).toBe(true)
  expect(sessionErrorEvent.properties.error).toEqual(apiError)
  expect(permissionAskedEvent.properties.source?.type).toBe("tool")
  expect(events).toHaveLength(3)
  expect(events.map((event) => event.type)).toEqual([
    "server.connected",
    "session.created",
    "session.error",
  ])
  expect(events[1]?.properties?.sessionID).toBe("ses_contract_fixture")
})
