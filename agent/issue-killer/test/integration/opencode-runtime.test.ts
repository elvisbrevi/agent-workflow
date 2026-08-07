import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSessionId } from "../../src/domain/session-id"
import { createOpenCodeRuntime } from "../../src/opencode/runtime"

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
