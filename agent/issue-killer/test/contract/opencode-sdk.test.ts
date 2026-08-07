import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2"

test("serves a directory-scoped client on an ephemeral loopback port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-killer-sdk-"))
  const { server } = await createOpencode({ hostname: "127.0.0.1", port: 0 })

  try {
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory,
      throwOnError: true,
    })
    const health = await client.global.health({ throwOnError: true })

    expect(new URL(server.url).hostname).toBe("127.0.0.1")
    expect(new URL(server.url).port).not.toBe("")
    expect(health.data.healthy).toBe(true)
    expect(typeof health.data.version).toBe("string")
    expect(health.data.version.length).toBeGreaterThan(0)
  } finally {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("releases the loopback port after server.close and allows a new instance to bind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-killer-sdk-close-"))

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const { server } = await createOpencode({ hostname: "127.0.0.1", port: 0 })
    const firstClient = createOpencodeClient({
      baseUrl: server.url,
      directory,
      throwOnError: true,
    })
    const health = await firstClient.global.health({ throwOnError: true })

    expect(health.data.healthy).toBe(true)
    expect(typeof health.data.version).toBe("string")
    expect(new URL(server.url).hostname).toBe("127.0.0.1")
    server.close()
  }

  await rm(directory, { recursive: true, force: true })
})
