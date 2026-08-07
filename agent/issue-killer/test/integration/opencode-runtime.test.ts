import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSessionId } from "../../src/domain/session-id"
import type { OpenCodeRuntimePort } from "../../src/domain/ports"
import { createOpenCodeRuntime, runOpenCodeWorkerSession } from "../../src/opencode/runtime"

async function nextWithTimeout<T>(stream: AsyncIterator<T>, timeoutMs: number): Promise<IteratorResult<T>> {
  return await Promise.race([
    stream.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("event stream timeout")), timeoutMs)),
  ])
}

test("wraps one loopback OpenCode server with directory-scoped session operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-killer-runtime-"))
  const canonicalDirectory = await realpath(directory)
  const runtime = await createOpenCodeRuntime({
    directory,
    supportedVersions: new Set(["1.18.14"]),
  })
  let events: AsyncIterable<unknown> | undefined

  try {
    const health = await runtime.health()
    expect(health.version).toBe("1.18.14")
    const sessionId = parseSessionId("ses_runtime_test")
    if (sessionId === null) throw new Error("test session id is invalid")
    events = runtime.subscribeEvents({ directory: canonicalDirectory, sessionId })
    const iterator = events[Symbol.asyncIterator]()
    const connected = await nextWithTimeout(iterator, 5_000)
    expect((connected.value as { type?: string }).type).toBe("server.connected")

    const scope = {
      issue: 84,
      branch: "issue-84-opencode-runtime",
      baseBranch: "main",
      baseSha: "abc123",
      profile: "main",
    }
    const created = await runtime.createSession({ directory: canonicalDirectory, scope })
    const loaded = await runtime.getSession({ sessionId: created.sessionId, directory: canonicalDirectory, scope })
    expect(created.directory).toBe(canonicalDirectory)
    expect(loaded.sessionId).toBe(created.sessionId)
    expect(loaded.directory).toBe(canonicalDirectory)

    await runtime.abortSession({ sessionId: created.sessionId, directory: canonicalDirectory })
    await runtime.deleteSession({ sessionId: created.sessionId, directory: canonicalDirectory })
    await iterator.return?.()
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects an unsupported server version at the health gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-killer-runtime-version-"))
  const runtime = await createOpenCodeRuntime({ directory, supportedVersions: new Set(["not-supported"]) })

  try {
    await expect(runtime.health()).rejects.toThrow("unsupported OpenCode version")
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("subscribes before prompting through the worker session coordinator", async () => {
  const sessionId = parseSessionId("ses_ordered")
  if (sessionId === null) throw new Error("test session id is invalid")
  const calls: string[] = []
  const runtime: OpenCodeRuntimePort = {
    host: "127.0.0.1",
    ephemeralPort: true,
    health: async () => ({ version: "1.18.14" }),
    createSession: async () => {
      calls.push("create")
      return { sessionId, directory: "/repo" }
    },
    getSession: async () => ({ sessionId, directory: "/repo", title: "test" }),
    abortSession: async () => { calls.push("abort") },
    deleteSession: async () => undefined,
    sendPrompt: async () => {
      calls.push("prompt")
      return { runId: "run_ordered" }
    },
    subscribeEvents: () => {
      calls.push("subscribe")
      return (async function* () {
        yield { type: "message.updated", properties: {
          sessionID: "ses_ordered",
          info: { role: "assistant", structured: { status: "ISSUE_COMPLETED", issue: 84, summary: "done" } },
        } }
      })()
    },
    close: async () => { calls.push("close") },
  }

  const result = await runOpenCodeWorkerSession({
    runtime,
    directory: "/repo",
    expectedIssue: 84,
    model: { providerID: "provider", modelID: "model" },
    promptText: "work on the pinned issue",
  })

  expect(calls.slice(0, 3)).toEqual(["create", "subscribe", "prompt"])
  expect(result.events.outcome?.status).toBe("ISSUE_COMPLETED")
})
