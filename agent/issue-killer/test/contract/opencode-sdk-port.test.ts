import { expect, test } from "bun:test"
import { createOpencode } from "@opencode-ai/sdk/v2"

test("allocates distinct non-zero loopback ports concurrently", async () => {
  const instances = await Promise.all([
    createOpencode({ hostname: "127.0.0.1", port: 0 }),
    createOpencode({ hostname: "127.0.0.1", port: 0 }),
    createOpencode({ hostname: "127.0.0.1", port: 0 }),
  ])

  try {
    const urls = instances.map(({ server }) => new URL(server.url))
    const ports = urls.map((url) => Number(url.port))

    expect(new Set(urls.map((url) => url.toString())).size).toBe(3)
    expect(urls.every((url) => url.hostname === "127.0.0.1")).toBe(true)
    expect(ports.every((port) => Number.isInteger(port) && port > 0)).toBe(true)
  } finally {
    for (const { server } of instances) {
      server.close()
    }
  }
})
