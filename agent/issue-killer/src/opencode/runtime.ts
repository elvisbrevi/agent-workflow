import { realpath } from "node:fs/promises"
import {
  createOpencode,
  createOpencodeClient,
  type Config,
  type PermissionConfig,
} from "@opencode-ai/sdk/v2"
import type { OpenCodeRuntimePort, OpenCodeSessionScope } from "../domain/ports"
import { IssueKillerError } from "../domain/errors"
import { parseSessionId, type SessionId } from "../domain/session-id"

export const AUTONOMOUS_PERMISSION = {
  read: "allow",
  edit: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  bash: "allow",
  task: "allow",
  external_directory: "allow",
  todowrite: "allow",
  question: "allow",
  webfetch: "allow",
  websearch: "allow",
  lsp: "allow",
  skill: "allow",
} satisfies PermissionConfig

const OUTCOME_SCHEMA = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string" },
      issue: { type: "integer" },
      summary: { type: "string" },
    },
    required: ["status", "issue", "summary"],
    additionalProperties: false,
  },
  retryCount: 2,
} as const

export type OpenCodeRuntimeOptions = {
  readonly directory: string
  readonly autonomous?: boolean
  readonly config?: Config
  readonly supportedVersions?: ReadonlySet<string>
  readonly maxBindAttempts?: number
}

export type OpenCodeRuntime = OpenCodeRuntimePort & {
  readonly directory: string
}

const runtimeError = (message: string, details: Readonly<Record<string, unknown>> = {}): IssueKillerError =>
  new IssueKillerError("runtime_unavailable", message, details)

const assertSessionId = (sessionId: SessionId): SessionId => {
  const parsed = parseSessionId(sessionId)
  if (parsed === null) {
    throw new IssueKillerError("invalid_session_id", "OpenCode returned an invalid session id")
  }
  return parsed
}

const isAddressInUse = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const record = error as { readonly code?: unknown; readonly message?: unknown }
  return record.code === "EADDRINUSE" || (typeof record.message === "string" && record.message.includes("EADDRINUSE"))
}

const scopeMetadata = (scope: OpenCodeSessionScope): Readonly<Record<string, string | number>> => ({
  issue: scope.issue,
  branch: scope.branch,
  base_branch: scope.baseBranch,
  base_sha: scope.baseSha,
  profile: scope.profile,
})

const hasMatchingScope = (metadata: unknown, scope: OpenCodeSessionScope): boolean => {
  if (typeof metadata !== "object" || metadata === null) return false
  const stored = (metadata as { readonly issue_killer?: unknown }).issue_killer
  if (typeof stored !== "object" || stored === null) return false
  const values = stored as Record<string, unknown>
  const expected = scopeMetadata(scope)
  return Object.entries(expected).every(([key, value]) => values[key] === value)
}

export const createOpenCodeRuntime = async (options: OpenCodeRuntimeOptions): Promise<OpenCodeRuntime> => {
  const directory = await realpath(options.directory)
  const maxBindAttempts = Math.max(1, options.maxBindAttempts ?? 3)
  const permission = options.autonomous === true ? AUTONOMOUS_PERMISSION : "ask"
  const config: Config = { ...options.config, permission }

  let server: { readonly url: string; close(): void } | null = null
  for (let attempt = 1; attempt <= maxBindAttempts; attempt += 1) {
    try {
      const started = await createOpencode({ hostname: "127.0.0.1", port: 0, config })
      server = started.server
      const address = new URL(server.url)
      if (address.hostname !== "127.0.0.1" || address.port.length === 0) {
        server.close()
        throw runtimeError("OpenCode server did not bind to a loopback ephemeral port", {
          hostname: address.hostname,
          port: address.port,
        })
      }
      break
    } catch (error) {
      if (server !== null) {
        server.close()
        server = null
      }
      if (!isAddressInUse(error) || attempt === maxBindAttempts) {
        throw runtimeError("unable to start the loopback OpenCode server", { attempt, maxBindAttempts })
      }
    }
  }
  if (server === null) throw runtimeError("OpenCode server did not start")

  const client = createOpencodeClient({ baseUrl: server.url, directory, throwOnError: true })
  let closed = false
  let healthChecked = false
  const scopedDirectory = (value: string): string => {
    if (value !== directory) {
      throw new IssueKillerError("drift_detected", "OpenCode operation used a different directory", {
        expected: directory,
        actual: value,
      })
    }
    return directory
  }

  const checkHealth = async (): Promise<{ readonly version: string }> => {
    const response = await client.global.health({ throwOnError: true })
    const version = response.data.version
    if (!response.data.healthy || typeof version !== "string" || version.length === 0) {
      throw runtimeError("OpenCode health check failed")
    }
    if (options.supportedVersions !== undefined && !options.supportedVersions.has(version)) {
      throw runtimeError("unsupported OpenCode version", { version })
    }
    healthChecked = true
    return { version }
  }

  const runtime: OpenCodeRuntime = {
    host: "127.0.0.1",
    ephemeralPort: true,
    directory,
    health: checkHealth,
    createSession: async ({ directory: requestedDirectory, scope }) => {
      const response = await client.session.create({
        directory: scopedDirectory(requestedDirectory),
        ...(scope === undefined ? {} : { metadata: { issue_killer: scopeMetadata(scope) } }),
      }, { throwOnError: true })
      const sessionId = assertSessionId(response.data.id as SessionId)
      if (response.data.directory !== directory) {
        throw new IssueKillerError("drift_detected", "OpenCode created a session in a different directory", {
          expected: directory,
          actual: response.data.directory,
        })
      }
      return { sessionId, directory: response.data.directory }
    },
    getSession: async ({ sessionId, directory: requestedDirectory, scope }) => {
      const validSessionId = assertSessionId(sessionId)
      const response = await client.session.get(
        { sessionID: validSessionId, directory: scopedDirectory(requestedDirectory) },
        { throwOnError: true },
      )
      const returnedSessionId = assertSessionId(response.data.id as SessionId)
      if (
        returnedSessionId !== validSessionId ||
        response.data.directory !== directory ||
        (scope !== undefined && !hasMatchingScope(response.data.metadata, scope))
      ) {
        throw new IssueKillerError("drift_detected", "OpenCode session identity does not match the pinned scope")
      }
      return { sessionId: returnedSessionId, directory: response.data.directory, title: response.data.title }
    },
    abortSession: async ({ sessionId, directory: requestedDirectory }) => {
      await client.session.abort(
        { sessionID: assertSessionId(sessionId), directory: scopedDirectory(requestedDirectory) },
        { throwOnError: true },
      )
    },
    deleteSession: async ({ sessionId, directory: requestedDirectory }) => {
      await client.session.delete(
        { sessionID: assertSessionId(sessionId), directory: scopedDirectory(requestedDirectory) },
        { throwOnError: true },
      )
    },
    sendPrompt: async ({ sessionId, directory: requestedDirectory, model, variant, promptText }) => {
      if (!healthChecked) await checkHealth()
      const response = await client.session.prompt(
        {
          sessionID: assertSessionId(sessionId),
          directory: scopedDirectory(requestedDirectory),
          model: { providerID: model.providerID, modelID: model.modelID },
          variant,
          format: OUTCOME_SCHEMA,
          parts: [{ type: "text", text: promptText }],
        },
        { throwOnError: true },
      )
      return { runId: response.data.info.id }
    },
    subscribeEvents: ({ directory: requestedDirectory, sessionId }) => (async function* () {
      assertSessionId(sessionId)
      const response = await client.event.subscribe(
        { directory: scopedDirectory(requestedDirectory) },
        { throwOnError: true },
      )
      yield* response.stream
    })(),
    close: async () => {
      if (closed) return
      closed = true
      server?.close()
    },
  }

  return runtime
}
