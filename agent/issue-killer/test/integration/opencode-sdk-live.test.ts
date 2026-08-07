import { realpath } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { expect, test } from "bun:test"
import { createOpencode } from "@opencode-ai/sdk/v2"
import { autonomousPermission } from "../fixtures/opencode-sdk-contract"

const liveEnabled = process.env.ISSUE_KILLER_OPENCODE_LIVE === "1"

test.skipIf(!liveEnabled)("runs the opt-in structured-output model smoke in an external sandbox", async () => {
  if (process.env.ISSUE_KILLER_OPENCODE_SANDBOX !== "1") {
    throw new Error("ISSUE_KILLER_OPENCODE_SANDBOX=1 is required for live smoke")
  }

  const directoryValue = process.env.ISSUE_KILLER_OPENCODE_SANDBOX_DIR
  const modelValue = process.env.ISSUE_KILLER_OPENCODE_MODEL
  if (!directoryValue || !modelValue) {
    throw new Error("ISSUE_KILLER_OPENCODE_SANDBOX_DIR and ISSUE_KILLER_OPENCODE_MODEL are required")
  }

  const directory = await realpath(directoryValue)
  const repositoryRoot = resolve(dirname(import.meta.dir), "../..")
  if (directory === repositoryRoot || directory.startsWith(`${repositoryRoot}/`)) {
    throw new Error("live smoke directory must be outside the repository")
  }
  if (basename(directory).length === 0) {
    throw new Error("live smoke directory must be a named sandbox")
  }

  const separator = modelValue.indexOf("/")
  if (separator <= 0 || separator === modelValue.length - 1 || modelValue.indexOf("/", separator + 1) !== -1) {
    throw new Error("ISSUE_KILLER_OPENCODE_MODEL must use provider/model")
  }
  const providerID = modelValue.slice(0, separator)
  const modelID = modelValue.slice(separator + 1)
  const variant = process.env.ISSUE_KILLER_OPENCODE_VARIANT
  const { server } = await createOpencode({
    hostname: "127.0.0.1",
    port: 0,
    config: {
      permission: autonomousPermission,
    },
  })
  const client = (await import("@opencode-ai/sdk/v2")).createOpencodeClient({
    baseUrl: server.url,
    directory,
    throwOnError: true,
  })
  let sessionID: string | undefined

  try {
    const created = await client.session.create({ directory }, { throwOnError: true })
    sessionID = created.data.id
    const prompted = await client.session.prompt({
      sessionID,
      directory,
      model: { providerID, modelID },
      variant,
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            status: { type: "string" },
            issue: { type: "integer" },
            summary: { type: "string" },
          },
          required: ["status", "issue", "summary"],
        },
      },
      parts: [{ type: "text", text: "Return status ISSUE_COMPLETED, issue 1, and summary live smoke." }],
    }, { throwOnError: true })

    expect(prompted.data.info.role).toBe("assistant")
    expect(prompted.data.info.structured).toBeDefined()
  } finally {
    if (sessionID) {
      await client.session.abort({ sessionID, directory }, { throwOnError: true }).catch(() => undefined)
      await client.session.delete({ sessionID, directory }, { throwOnError: true }).catch(() => undefined)
    }
    server.close()
  }
})
