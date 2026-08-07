import { expect, test } from "bun:test"
import type { OpenCodeRuntimePort } from "../../src/domain/ports"
import { runOpenCodeWorkerSession } from "../../src/opencode/runtime"
import { parseSessionId } from "../../src/domain/session-id"

const scope = {
  issue: 86,
  branch: "issue-86",
  baseBranch: "main",
  baseSha: "base-sha",
  profile: "opencode-backup",
}

const session = (value: string) => {
  const parsed = parseSessionId(value)
  if (parsed === null) throw new Error("invalid fixture session")
  return parsed
}

const runtimeFixture = (calls: string[], resumable: boolean): OpenCodeRuntimePort => {
  const resumed = session("ses_previous")
  const fresh = session("ses_fresh")
  return {
    host: "127.0.0.1",
    ephemeralPort: true,
    health: async () => ({ version: "1.18.14" }),
    createSession: async () => {
      calls.push("create")
      return { sessionId: fresh, directory: "/repo" }
    },
    getSession: async ({ sessionId, allowProfileChange }) => {
      calls.push(`get:${sessionId}:${allowProfileChange === true ? "profile-change" : "strict"}`)
      if (!resumable) throw new Error("session not found")
      return { sessionId: resumed, directory: "/repo", title: "previous" }
    },
    abortSession: async () => undefined,
    deleteSession: async () => undefined,
    sendPrompt: async ({ sessionId }) => {
      calls.push(`prompt:${sessionId}`)
      return { runId: "run" }
    },
    subscribeEvents: ({ sessionId }) => (async function* () {
      yield {
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: { role: "assistant", structured: { status: "ISSUE_COMPLETED", issue: 86, summary: "done" } },
        },
      }
    })(),
    close: async () => undefined,
  }
}

test("confirms a resumable session before changing only its model", async () => {
  const calls: string[] = []
  const result = await runOpenCodeWorkerSession({
    runtime: runtimeFixture(calls, true),
    directory: "/repo",
    scope,
    expectedIssue: 86,
    resumeSessionId: session("ses_previous"),
    model: { providerID: "provider", modelID: "backup-model" },
    promptText: "continue the pinned issue",
  })

  expect(result.sessionId).toBe(session("ses_previous"))
  expect(calls).toEqual(["get:ses_previous:profile-change", "prompt:ses_previous"])
})

test("degrades an unresumable session to a fresh constrained session", async () => {
  const calls: string[] = []
  const result = await runOpenCodeWorkerSession({
    runtime: runtimeFixture(calls, false),
    directory: "/repo",
    scope,
    expectedIssue: 86,
    resumeSessionId: session("ses_previous"),
    model: { providerID: "provider", modelID: "backup-model" },
    promptText: "continue the pinned issue",
  })

  expect(result.sessionId).toBe(session("ses_fresh"))
  expect(calls).toEqual(["get:ses_previous:profile-change", "create", "prompt:ses_fresh"])
})
