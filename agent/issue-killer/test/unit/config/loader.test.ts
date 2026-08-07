import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultConfigPath,
  expandHomePath,
  loadConfig,
  type LoadConfigEnvironment,
} from "../../../src/config/loader"

const writeText = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, body, "utf8")
}

const goodToml = (): string => `
default_profile = "opencode-main"
log_dir = "/tmp/issue-killer/logs"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"

[profiles.opencode-main.options]
auto_approve = true
variant = "high"

[profiles.opencode-backup]
label = "OpenCode backup"
cli = "opencode"
command = "opencode"
model = "provider/backup-model"
`

const buildEnv = async (
  overrides: Partial<LoadConfigEnvironment> = {},
): Promise<LoadConfigEnvironment> => {
  const dir = await mkdtemp(join(tmpdir(), "issue-killer-cfg-"))
  const home = dir
  const logDir = join(dir, "logs")
  await mkdir(logDir, { recursive: true })
  const configPath = join(dir, "config.toml")
  const defaultFs: LoadConfigEnvironment["fs"] = {
    mkdir: async (path: string) => {
      await mkdir(path, { recursive: true })
    },
    writeFile: async (path: string, body: string) => {
      await writeText(path, body)
    },
  }
  const defaults: LoadConfigEnvironment = {
    argv: [],
    env: {},
    home: dir,
    cwd: dir,
    configPath,
    fileExists: async (path: string) => Bun.file(path).size >= 0,
    expandHome: (input: string) => expandHomePath(input, home),
    fs: defaultFs,
  }
  return {
    ...defaults,
    ...overrides,
    env: { ...defaults.env, ...(overrides.env ?? {}) },
    argv: overrides.argv ?? defaults.argv,
    fs: { ...defaults.fs, ...(overrides.fs ?? {}) },
  }
}

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "issue-killer-loader-"))
})
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("defaultConfigPath", () => {
  test("returns ~/.config/issue-killer/config.toml", () => {
    expect(defaultConfigPath("/home/user")).toBe("/home/user/.config/issue-killer/config.toml")
  })
})

describe("expandHomePath", () => {
  test("expands a leading tilde", () => {
    expect(expandHomePath("~/logs", "/home/u")).toBe("/home/u/logs")
    expect(expandHomePath("~", "/home/u")).toBe("/home/u")
  })
  test("leaves absolute paths untouched", () => {
    expect(expandHomePath("/etc/x", "/home/u")).toBe("/etc/x")
  })
  test("expands mid-string tildes only at the leading ~/", () => {
    expect(expandHomePath("/var/~trap", "/home/u")).toBe("/var/~trap")
  })
})

describe("loadConfig", () => {
  test("rejects with explicit error when --config has no value", async () => {
    const env = await buildEnv({ argv: ["--config"] })
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--config")
    }
  })

  test("rejects with explicit error when --iteration-limit is non-integer", async () => {
    const env = await buildEnv({ argv: ["--iteration-limit", "abc"] })
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--iteration-limit")
    }
  })

  test("returns file_missing when config file is absent", async () => {
    const env = await buildEnv({ fileExists: async () => false })
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.code).toBe("file_missing")
    }
  })

  test("loads a valid TOML config and resolves defaultProfile + profiles", async () => {
    const env = await buildEnv()
    await writeFile(env.configPath, goodToml(), "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.config.defaultProfile).toBe("opencode-main")
      expect(result.config.logDir).toBe("/tmp/issue-killer/logs")
      expect(result.config.profiles.size).toBe(2)
      const main = result.config.profiles.get("opencode-main")
      expect(main?.providerID).toBe("provider")
      expect(main?.modelID).toBe("model")
      expect(main?.variant).toBe("high")
      expect(main?.autoApprove).toBe(true)
      expect(result.args.assumeYes).toBe(false)
    }
  })

  test("returns structured validation error for unknown top-level keys", async () => {
    const env = await buildEnv()
    await writeFile(
      env.configPath,
      `${goodToml()}\nbogus_key = 1\n`,
      "utf8",
    )
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.code).toBe("invalid_config")
      expect(result.path).toContain("bogus_key")
    }
  })

  test("returns structured validation error for fallback cycles", async () => {
    const env = await buildEnv()
    const body = `
default_profile = "a"
log_dir = "/tmp/issue-killer/logs"

[profiles.a]
label = "a"
cli = "opencode"
command = "opencode"
model = "provider/a"
fallbacks = ["b"]

[profiles.b]
label = "b"
cli = "opencode"
command = "opencode"
model = "provider/b"
fallbacks = ["a"]
`
    await writeFile(env.configPath, body, "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.code).toBe("invalid_config")
    }
  })

  test("rejects non-opencode cli", async () => {
    const env = await buildEnv()
    await writeFile(
      env.configPath,
      goodToml().replace('cli = "opencode"', 'cli = "claude"'),
      "utf8",
    )
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.message).toContain("cli")
    }
  })

  test("rejects control-character injection in label", async () => {
    const env = await buildEnv()
    const body = `
default_profile = "opencode-main"
log_dir = "/tmp/issue-killer/logs"

[profiles.opencode-main]
label = "opencode\\nmain"
cli = "opencode"
command = "opencode"
model = "provider/model"
`
    await writeFile(env.configPath, body, "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.message).toContain("control")
    }
  })

  test("rejects log_dir that is not writable", async () => {
    const env = await buildEnv()
    await writeFile(env.configPath, goodToml().replace("/tmp/issue-killer/logs", "/no/such/path"), "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.code).toBe("log_dir_unwritable")
    }
  })

  test("accepts an env-provided config path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "issue-killer-loader-home-"))
    try {
      const logsPath = join(dir, "logs")
      await mkdir(logsPath, { recursive: true })
      const alternateDir = join(dir, "alternate")
      await mkdir(alternateDir, { recursive: true })
      const alternatePath = join(alternateDir, "config.toml")
      const toml = `
default_profile = "opencode-main"
log_dir = "${logsPath}"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"

[profiles.opencode-backup]
label = "OpenCode backup"
cli = "opencode"
command = "opencode"
model = "provider/backup-model"
`
      await writeFile(alternatePath, toml, "utf8")
      const env: LoadConfigEnvironment = {
        argv: [],
        env: {},
        home: dir,
        cwd: dir,
        configPath: alternatePath,
        fileExists: async (path: string) => Bun.file(path).size >= 0,
        expandHome: (input: string) => expandHomePath(input, dir),
        fs: {
          mkdir: async (path: string) => {
            await mkdir(path, { recursive: true })
          },
          writeFile: async (path: string, body: string) => {
            await writeFile(path, body, "utf8")
          },
        },
      }
      const result = await loadConfig(env)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.config.sourcePath).toBe(alternatePath)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects credential-like top-level config token", async () => {
    const env = await buildEnv()
    const body = `
default_profile = "opencode-main"
log_dir = "/tmp/issue-killer/logs"
token = "ghp_xxx"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"
`
    await writeFile(env.configPath, body, "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.message).toContain("token")
    }
  })

  test("returns toml_parse error for trailing junk after a value", async () => {
    const env = await buildEnv()
    const body = `
default_profile = "opencode-main"junk
log_dir = "/tmp/issue-killer/logs"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"
`
    await writeFile(env.configPath, body, "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.code).toBe("toml_parse")
    }
  })

  test("fails non-interactive destructive when default profile lacks auto_approve", async () => {
    const env = await buildEnv({ argv: ["--assume-yes"] })
    const body = `
default_profile = "opencode-main"
log_dir = "/tmp/issue-killer/logs"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"

[profiles.opencode-main.options]
auto_approve = false
`
    await writeFile(env.configPath, body, "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.code).toBe("destructive_not_authorized")
    }
  })

  test("accepts auto_approve=true on the default profile when destructive is enabled", async () => {
    const env = await buildEnv({ argv: ["--assume-yes"] })
    await writeFile(env.configPath, goodToml(), "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.config.destructiveAuthorized).toBe(true)
    }
  })

  test("interactive (no --assume-yes) does not require auto_approve=true", async () => {
    const env = await buildEnv({ argv: [] })
    const body = `
default_profile = "opencode-main"
log_dir = "/tmp/issue-killer/logs"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"

[profiles.opencode-main.options]
auto_approve = false
`
    await writeFile(env.configPath, body, "utf8")
    const result = await loadConfig(env)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.config.destructiveAuthorized).toBe(false)
    }
  })
})
