import type { Subprocess } from "bun"
import type { CommandRunnerPort } from "../domain/ports"

export type CommandRunFailure =
  | { readonly kind: "spawn_failed"; readonly program: string; readonly error: string }
  | { readonly kind: "timed_out"; readonly program: string; readonly timeoutMs: number }
  | { readonly kind: "aborted"; readonly program: string }
  | { readonly kind: "non_zero_exit"; readonly program: string; readonly exitCode: number }

export class CommandRunError extends Error {
  readonly failure: CommandRunFailure

  constructor(failure: CommandRunFailure) {
    super(CommandRunError.describe(failure))
    this.name = "CommandRunError"
    this.failure = failure
  }

  static describe(failure: CommandRunFailure): string {
    switch (failure.kind) {
      case "spawn_failed":
        return `spawn failed for ${failure.program}: ${failure.error}`
      case "timed_out":
        return `command ${failure.program} timed out after ${failure.timeoutMs}ms`
      case "aborted":
        return `command ${failure.program} aborted`
      case "non_zero_exit":
        return `command ${failure.program} exited with code ${failure.exitCode}`
      default: {
        const exhaustive: never = failure
        throw new Error(`unhandled command run failure: ${(exhaustive as { kind: string }).kind}`)
      }
    }
  }
}

export type SpawnCommandResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type SpawnCommandInput = {
  readonly program: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type SpawnCommandFn = (input: SpawnCommandInput) => Promise<SpawnCommandResult>

const decodeStream = async (
  stream: ReadableStream<Uint8Array<ArrayBufferLike>> | undefined,
): Promise<string> => {
  if (stream === undefined) {
    return ""
  }
  const response = new Response(stream as unknown as ReadableStream<Uint8Array>)
  return response.text()
}

const mergeEnv = (
  base: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const merged: Record<string, string> = {}
  const source = process.env as Readonly<Record<string, string | undefined>>
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      merged[key] = value
    }
  }
  for (const [key, value] of Object.entries(base)) {
    merged[key] = value
  }
  return merged
}

export const bunSpawnCommand = async (input: SpawnCommandInput): Promise<SpawnCommandResult> => {
  if (input.program.length === 0) {
    throw new CommandRunError({
      kind: "spawn_failed",
      program: input.program,
      error: "program name is empty",
    })
  }
  for (const arg of input.args) {
    if (arg.includes("\u0000")) {
      throw new CommandRunError({
        kind: "spawn_failed",
        program: input.program,
        error: "argument contains NUL byte",
      })
    }
  }

  const env = mergeEnv(input.env)
  let subprocess: Subprocess
  try {
    subprocess = Bun.spawn({
      cmd: [input.program, ...input.args],
      cwd: input.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CommandRunError({
      kind: "spawn_failed",
      program: input.program,
      error: message,
    })
  }

  const timeoutMs = input.timeoutMs
  const signal = input.signal

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let timeoutReject: ((error: CommandRunError) => void) | undefined
  const timeoutPromise = new Promise<SpawnCommandResult>((_resolve, reject) => {
    if (timeoutMs === undefined) {
      return
    }
    timeoutReject = (error: CommandRunError): void => reject(error)
    timeoutHandle = setTimeout(() => {
      try {
        subprocess.kill("SIGKILL")
      } catch {
        // subprocess already exited
      }
      reject(
        new CommandRunError({
          kind: "timed_out",
          program: input.program,
          timeoutMs,
        }),
      )
    }, timeoutMs)
    if (typeof timeoutHandle.unref === "function") {
      timeoutHandle.unref()
    }
  })

  let abortHandler: (() => void) | undefined
  const abortPromise =
    signal === undefined
      ? new Promise<never>(() => undefined)
      : new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            try {
              subprocess.kill("SIGTERM")
            } catch {
              // ignore
            }
            reject(
              new CommandRunError({
                kind: "aborted",
                program: input.program,
              }),
            )
            return
          }
          abortHandler = (): void => {
            try {
              subprocess.kill("SIGTERM")
            } catch {
              // ignore
            }
            reject(
              new CommandRunError({
                kind: "aborted",
                program: input.program,
              }),
            )
          }
          signal.addEventListener("abort", abortHandler, { once: true })
        })

  const exitPromise = (async (): Promise<SpawnCommandResult> => {
    const stdoutStream = subprocess.stdout as unknown as
      | ReadableStream<Uint8Array<ArrayBufferLike>>
      | undefined
    const stderrStream = subprocess.stderr as unknown as
      | ReadableStream<Uint8Array<ArrayBufferLike>>
      | undefined
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      decodeStream(stdoutStream),
      decodeStream(stderrStream),
      subprocess.exited,
    ])
    return { stdout: stdoutText, stderr: stderrText, exitCode }
  })()

  try {
    const result = await Promise.race([exitPromise, timeoutPromise, abortPromise])
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler)
    }
    return result
  } catch (error) {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (signal !== undefined && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler)
    }
    try {
      subprocess.kill("SIGKILL")
    } catch {
      // ignore
    }
    await exitPromise.catch(() => undefined)
    throw error
  }
}

export type BunCommandRunnerOptions = {
  readonly spawn?: SpawnCommandFn
}

export const bunCommandRunner = (options: BunCommandRunnerOptions = {}): CommandRunnerPort => {
  const spawn = options.spawn ?? bunSpawnCommand
  return {
    spawn: async (input): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> => {
      const result = await spawn({
        program: input.program,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      })
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }
    },
  }
}
