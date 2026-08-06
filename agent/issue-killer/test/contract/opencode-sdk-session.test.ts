import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2"

async function nextWithTimeout<T>(stream: AsyncGenerator<T>, timeoutMs: number): Promise<IteratorResult<T>> {
  return await Promise.race([
    stream.next(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`stream did not emit within ${timeoutMs}ms`)), timeoutMs)
    }),
  ])
}

test("creates, reads, aborts, and deletes a session while receiving events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-killer-sdk-session-"))
  const canonicalDirectory = await realpath(directory)
  const { server } = await createOpencode({ hostname: "127.0.0.1", port: 0 })
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory,
    throwOnError: true,
  })
  const events = await client.event.subscribe({ directory }, { throwOnError: true })
  const connected = await nextWithTimeout(events.stream, 5_000)

  try {
    const eventPromise = nextWithTimeout(events.stream, 5_000)
    const created = await client.session.create({ directory }, { throwOnError: true })
    const sessionID = created.data.id
    const received = await eventPromise
    const loaded = await client.session.get({ sessionID, directory }, { throwOnError: true })
    const aborted = await client.session.abort({ sessionID, directory }, { throwOnError: true })
    const deleted = await client.session.delete({ sessionID, directory }, { throwOnError: true })

    expect(created.data.directory).toBe(canonicalDirectory)
    expect(loaded.data.id).toBe(sessionID)
    expect(connected.value?.type).toBe("server.connected")
    expect(received.value?.type).toBe("session.created")
    expect(received.value?.properties.sessionID).toBe(sessionID)
    expect(aborted.response.status).toBe(200)
    expect(deleted.response.status).toBe(200)
  } finally {
    await events.stream.return()
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
