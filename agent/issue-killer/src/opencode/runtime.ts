import { realpath } from "node:fs/promises"
import {
  createOpencode,
  createOpencodeClient,
  type Config,
  type PermissionConfig,
} from "@opencode-ai/sdk/v2"
import type { HarnessLogPort, OpenCodeRuntimePort, OpenCodeSessionScope } from "../domain/ports"
import { IssueKillerError } from "../domain/errors"
import type { EventPumpResult, ObservedEvent } from "./event-pump"
import { drainSessionEvents } from "./event-pump"
import { parseSessionId, type SessionId } from "../domain/session-id"
import type { LifecycleState } from "../domain/lifecycle"

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
  doom_loop: "allow",
} satisfies PermissionConfig

export const SUPPORTED_OPENCODE_VERSIONS = new Set(["1.18.14", "1.18.15"])

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

export type OpenCodeWorkerSessionInput = {
  readonly runtime: OpenCodeRuntimePort
  readonly directory: string
  readonly scope?: OpenCodeSessionScope
  readonly expectedIssue?: number
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly variant?: string
  readonly promptText: string
  readonly autonomous?: boolean
  readonly signal?: AbortSignal
  readonly harnessLog?: HarnessLogPort
  readonly runId?: string
  readonly harnessLifecycle?: boolean
  readonly onSessionCaptured?: (sessionId: SessionId) => Promise<void> | void
  readonly onEvent?: (event: ObservedEvent) => Promise<void> | void
}

export type OpenCodeWorkerSessionResult = {
  readonly sessionId: SessionId
  readonly runId: string
  readonly events: EventPumpResult
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

const lifecycleForOutcome = (status: string): LifecycleState => {
  switch (status) {
    case "ISSUE_COMPLETED": return "issue_completed"
    case "QUEUE_EMPTY": return "queue_empty"
    case "BLOCKED": return "blocked"
    case "RECOVERY_REQUIRED": return "recovery_required"
    case "FAILED": return "failed"
    default: return "failed"
  }
}

const primeEventStream = async (stream: AsyncIterable<unknown>): Promise<AsyncIterable<unknown>> => {
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  return (async function* () {
    if (!first.done) yield first.value
    while (true) {
      const next = await iterator.next()
      if (next.done) return
      yield next.value
    }
  })()
}

export const createOpenCodeRuntime = async (options: OpenCodeRuntimeOptions): Promise<OpenCodeRuntime> => {
  const directory = await realpath(options.directory)
  const maxBindAttempts = Math.max(1, options.maxBindAttempts ?? 3)
  const supportedVersions = options.supportedVersions ?? SUPPORTED_OPENCODE_VERSIONS
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
    if (!supportedVersions.has(version)) {
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

export const runOpenCodeWorkerSession = async (
  input: OpenCodeWorkerSessionInput,
): Promise<OpenCodeWorkerSessionResult> => {
  if (input.signal?.aborted) throw new Error("OpenCode worker was cancelled before session creation")

  const harnessEnabled = input.harnessLog !== undefined && input.runId !== undefined
  const harnessStarted = harnessEnabled && input.harnessLifecycle !== false
  if (harnessStarted && input.harnessLog !== undefined && input.runId !== undefined) {
    await input.harnessLog.startRun({ runId: input.runId, repository: input.directory })
  }
  const session = await input.runtime.createSession({ directory: input.directory, scope: input.scope })
  if (input.signal?.aborted) {
    await input.runtime.abortSession({ sessionId: session.sessionId, directory: input.directory }).catch(() => undefined)
    await input.runtime.close().catch(() => undefined)
    throw new Error("OpenCode worker was cancelled")
  }
  const controller = new AbortController()
  let abortPromise: Promise<void> | undefined
  let closePromise: Promise<void> | undefined
  const abortSession = (): void => {
    controller.abort()
    abortPromise ??= input.runtime.abortSession({ sessionId: session.sessionId, directory: input.directory })
      .catch(() => undefined)
    closePromise ??= (abortPromise ?? Promise.resolve()).then(
      () => input.runtime.close(),
      () => input.runtime.close(),
    ).catch(() => undefined)
  }
  const signalHandler = (): void => abortSession()
  input.signal?.addEventListener("abort", signalHandler, { once: true })

  try {
    await input.onSessionCaptured?.(session.sessionId)
    const subscription = input.runtime.subscribeEvents({
      directory: input.directory,
      sessionId: session.sessionId,
    })
    const cancellation = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error("OpenCode worker was cancelled"))
        return
      }
      controller.signal.addEventListener("abort", () => reject(new Error("OpenCode worker was cancelled")), { once: true })
    })
    const eventStream = await Promise.race([primeEventStream(subscription), cancellation])
    const eventResultPromise = drainSessionEvents({
      events: eventStream,
      expectedSessionId: session.sessionId,
      expectedIssue: input.expectedIssue,
      autonomous: input.autonomous,
      stopOnOutcome: true,
      signal: controller.signal,
      harnessLog: input.harnessLog,
      runId: input.runId,
      onSessionCaptured: input.onSessionCaptured,
      onEvent: input.onEvent,
    })
    const promptPromise = input.runtime.sendPrompt({
      sessionId: session.sessionId,
      directory: input.directory,
      model: input.model,
      variant: input.variant,
      promptText: input.promptText,
    })
    const firstResult = await Promise.race([
      promptPromise.then((value) => ({ kind: "prompt" as const, value })),
      eventResultPromise.then((value) => ({ kind: "events" as const, value })),
      cancellation,
    ])
    if (firstResult.kind === "events" && firstResult.value.permissionStopped) {
      abortSession()
      await abortPromise
      await promptPromise.catch(() => undefined)
      throw new IssueKillerError("permission_denied", "OpenCode requested permission during autonomous execution")
    }
    if (controller.signal.aborted) {
      await promptPromise.catch(() => undefined)
      throw new Error("OpenCode worker was cancelled")
    }
    const promptResult = firstResult.kind === "prompt" ? firstResult.value : await promptPromise
    const events = firstResult.kind === "events" ? firstResult.value : await eventResultPromise
    if (events.permissionStopped) {
      throw new IssueKillerError("permission_denied", "OpenCode requested permission during autonomous execution")
    }
    if (events.malformedOutcome || events.missingOutcome) {
      throw new IssueKillerError("malformed_outcome", "OpenCode emitted an invalid or contradictory worker outcome")
    }
    if (harnessStarted && input.harnessLog !== undefined && input.runId !== undefined && events.outcome !== null) {
      await input.harnessLog.endRun({ runId: input.runId, status: lifecycleForOutcome(events.outcome.status) })
    }
    return { sessionId: session.sessionId, runId: promptResult.runId, events }
  } catch (error) {
    abortSession()
    await abortPromise
    if (harnessStarted && input.harnessLog !== undefined && input.runId !== undefined) {
      await input.harnessLog.endRun({ runId: input.runId, status: "failed" })
    }
    throw error
  } finally {
    input.signal?.removeEventListener("abort", signalHandler)
    await closePromise
  }
}
