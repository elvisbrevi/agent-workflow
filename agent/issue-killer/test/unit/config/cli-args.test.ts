import { describe, expect, test } from "bun:test"
import { parseCliArgs, SUPPORTED_FLAGS } from "../../../src/config/cli-args"

describe("parseCliArgs", () => {
  test("returns defaults for an empty argv", () => {
    const result = parseCliArgs([])
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.args.configPath).toBeNull()
      expect(result.args.baseBranch).toBeNull()
      expect(result.args.assumeYes).toBe(false)
      expect(result.args.iterationLimit).toBeNull()
      expect(result.args.hu).toBeNull()
      expect(result.args.adoptIssue).toBeNull()
      expect(result.args.extras).toEqual([])
    }
  })

  test("parses --config with separate value", () => {
    const result = parseCliArgs(["--config", "/etc/issue-killer/config.toml"])
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.args.configPath).toBe("/etc/issue-killer/config.toml")
    }
  })

  test("parses --config=value with single argument", () => {
    const result = parseCliArgs(["--config=./c.toml"])
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.args.configPath).toBe("./c.toml")
    }
  })

  test("errors on --config without a value", () => {
    const result = parseCliArgs(["--config"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--config")
      expect(result.message).toContain("--config")
      expect(result.message).toContain("value")
    }
  })

  test("errors on --config= with empty value", () => {
    const result = parseCliArgs(["--config="])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--config")
    }
  })

  test("parses --base-branch and --iteration-limit", () => {
    const result = parseCliArgs(["--base-branch", "develop", "--iteration-limit", "7"])
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.args.baseBranch).toBe("develop")
      expect(result.args.iterationLimit).toBe(7)
    }
  })

  test("errors on --iteration-limit with non-integer", () => {
    const result = parseCliArgs(["--iteration-limit", "abc"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--iteration-limit")
    }
  })

  test("errors on --iteration-limit=0", () => {
    const result = parseCliArgs(["--iteration-limit", "0"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--iteration-limit")
    }
  })

  test("errors on --iteration-limit=-3", () => {
    const result = parseCliArgs(["--iteration-limit", "-3"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--iteration-limit")
    }
  })

  test("errors on --iteration-limit without a value", () => {
    const result = parseCliArgs(["--iteration-limit"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--iteration-limit")
    }
  })

  test("parses --assume-yes and --yes as booleans", () => {
    expect(parseCliArgs(["--assume-yes"]).kind).toBe("ok")
    expect(parseCliArgs(["--yes"]).kind).toBe("ok")
    const yes = parseCliArgs(["--assume-yes"])
    if (yes.kind === "ok") expect(yes.args.assumeYes).toBe(true)
    const y = parseCliArgs(["--yes"])
    if (y.kind === "ok") expect(y.args.assumeYes).toBe(true)
  })

  test("--no-assume-yes clears the flag", () => {
    const result = parseCliArgs(["--assume-yes", "--no-assume-yes"])
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.args.assumeYes).toBe(false)
    }
  })

  test("parses --hu with positive integer", () => {
    const result = parseCliArgs(["--hu", "42"])
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.args.hu).toBe(42)
    }
  })

  test("errors on --hu with non-integer", () => {
    const result = parseCliArgs(["--hu", "abc"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--hu")
    }
  })

  test("errors on --hu=0", () => {
    const result = parseCliArgs(["--hu", "0"])
    expect(result.kind).toBe("error")
  })

  test("errors on --hu without value", () => {
    const result = parseCliArgs(["--hu"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--hu")
    }
  })

  test("parses --adopt-issue and --adopt", () => {
    const a = parseCliArgs(["--adopt-issue", "81"])
    expect(a.kind).toBe("ok")
    if (a.kind === "ok") {
      expect(a.args.adoptIssue).toBe("81")
    }
    const b = parseCliArgs(["--adopt", "81/22"])
    expect(b.kind).toBe("ok")
    if (b.kind === "ok") {
      expect(b.args.adoptIssue).toBe("81/22")
    }
  })

  test("errors on --adopt with empty value", () => {
    const result = parseCliArgs(["--adopt", ""])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--adopt")
    }
  })

  test("preserves unknown positional args as extras", () => {
    const result = parseCliArgs(["--assume-yes", "tail", "extra"])
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.args.extras).toEqual(["tail", "extra"])
    }
  })

  test("rejects unknown flags", () => {
    const result = parseCliArgs(["--unknown-flag"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--unknown-flag")
    }
  })

  test("rejects unknown --flag=value", () => {
    const result = parseCliArgs(["--bogus=1"])
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.flag).toBe("--bogus")
    }
  })

  test("is idempotent across SUPPORTED_FLAGS", () => {
    expect(SUPPORTED_FLAGS.length).toBeGreaterThan(0)
    for (const flag of SUPPORTED_FLAGS) {
      expect(typeof flag).toBe("string")
      expect(flag.startsWith("--")).toBe(true)
    }
  })
})
