import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  CommandRunError,
  bunCommandRunner,
  bunSpawnCommand,
  type SpawnCommandInput,
  type SpawnCommandResult,
} from "../../../src/system/command"

const SCRIPT = `${import.meta.dir}/fixtures/command-stub.sh`

const baseInput: SpawnCommandInput = {
  program: SCRIPT,
  args: [],
  cwd: "/tmp",
  env: {},
}

describe("bunCommandRunner", () => {
  test("returns the port contract shape with spawn", () => {
    const port = bunCommandRunner({
      spawn: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
    })
    expect(typeof port.spawn).toBe("function")
  })

  test("uses the injected spawn function and forwards the result", async () => {
    let captured: SpawnCommandInput | undefined
    const port = bunCommandRunner({
      spawn: async (input): Promise<SpawnCommandResult> => {
        captured = input
        return { stdout: "hello", stderr: "", exitCode: 0 }
      },
    })
    const result = await port.spawn({
      program: "echo",
      args: ["hello"],
      cwd: "/tmp",
      env: {},
      signal: undefined,
      timeoutMs: undefined,
    })
    expect(result).toEqual({ stdout: "hello", stderr: "", exitCode: 0 })
    expect(captured).toBeDefined()
    expect(captured?.program).toBe("echo")
    expect(captured?.args).toEqual(["hello"])
  })
})

describe("bunSpawnCommand", () => {
  test("captures stdout, stderr, and exit code from a stub script", async () => {
    const result = await bunSpawnCommand({
      ...baseInput,
      args: ["--stdout=hi", "--stderr=bye", "--exit=0"],
    })
    expect(result.stdout).toBe("hi")
    expect(result.stderr).toBe("bye")
    expect(result.exitCode).toBe(0)
  })

  test("reports non-zero exit code without throwing", async () => {
    const result = await bunSpawnCommand({
      ...baseInput,
      args: ["--stdout=ok", "--exit=7"],
    })
    expect(result.exitCode).toBe(7)
    expect(result.stdout).toBe("ok")
  })

  test("rejects empty program with a spawn_failed error", async () => {
    await expect(bunSpawnCommand({ ...baseInput, program: "" })).rejects.toBeInstanceOf(
      CommandRunError,
    )
  })

  test("rejects arguments that contain NUL bytes", async () => {
    await expect(
      bunSpawnCommand({ ...baseInput, args: ["bad\0arg"] }),
    ).rejects.toBeInstanceOf(CommandRunError)
  })
})
