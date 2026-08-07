import { describe, expect, test } from "bun:test"
import {
  validateConfig,
  validateProfileTable,
  KNOWN_PROFILE_FIELDS,
  KNOWN_OPTION_FIELDS,
  RESERVED_FORBIDDEN_FIELDS,
} from "../../../src/config/validation"

const goodProfile = () => ({
  label: "OpenCode main",
  cli: "opencode",
  command: "opencode",
  model: "provider/model",
  options: { auto_approve: true, variant: "high" },
  fallbacks: [],
})

describe("validateProfileTable", () => {
  test("accepts a minimal valid profile", () => {
    const result = validateProfileTable("opencode-main", goodProfile())
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.profile.name).toBe("opencode-main")
      expect(result.profile.providerID).toBe("provider")
      expect(result.profile.modelID).toBe("model")
      expect(result.profile.autoApprove).toBe(true)
      expect(result.profile.variant).toBe("high")
    }
  })

  test("rejects unknown top-level profile fields", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      secret_token: "ghp_xxx",
    })
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.path).toContain("profiles.opencode-main")
      expect(result.path).toContain("secret_token")
    }
  })

  test("rejects forbidden credential-like fields", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      token: "secret",
    })
    expect(result.kind).toBe("error")
  })

  test("rejects profile names that are not identifier-safe", () => {
    const result = validateProfileTable("opencode main", goodProfile())
    expect(result.kind).toBe("error")
  })

  test("rejects cli/command other than opencode", () => {
    const bad = validateProfileTable("opencode-main", {
      ...goodProfile(),
      cli: "claude",
    })
    expect(bad.kind).toBe("error")

    const bad2 = validateProfileTable("opencode-main", {
      ...goodProfile(),
      command: "claude-cli",
    })
    expect(bad2.kind).toBe("error")
  })

  test("rejects empty label", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      label: "",
    })
    expect(result.kind).toBe("error")
  })

  test("rejects non-string model", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      model: 42,
    })
    expect(result.kind).toBe("error")
  })

  test("rejects model with control character before split", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      model: "prov\nider/model",
    })
    expect(result.kind).toBe("error")
  })

  test("rejects malformed model strings", () => {
    const cases = [
      { model: "no-slash" },
      { model: "/model" },
      { model: "provider/" },
    ]
    for (const c of cases) {
      const r = validateProfileTable("opencode-main", { ...goodProfile(), ...c })
      expect(r.kind).toBe("error")
    }
  })

  test("rejects non-array fallbacks", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      fallbacks: "opencode-backup",
    })
    expect(result.kind).toBe("error")
  })

  test("rejects fallbacks array with non-string items", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      fallbacks: [42],
    })
    expect(result.kind).toBe("error")
  })

  test("rejects duplicate fallback entries within the profile", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      fallbacks: ["opencode-backup", "opencode-backup"],
    })
    expect(result.kind).toBe("error")
  })

  test("rejects unknown option fields", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      options: { auto_approve: true, retries: 99 },
    })
    expect(result.kind).toBe("error")
  })

  test("rejects non-boolean auto_approve", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      options: { auto_approve: "yes" },
    })
    expect(result.kind).toBe("error")
  })

  test("accepts auto_approve=false but the runtime will refuse non-interactive destructive", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      options: { auto_approve: false },
    })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.profile.autoApprove).toBe(false)
    }
  })

  test("accepts empty options table", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      options: {},
    })
    expect(result.kind).toBe("ok")
  })

  test("rejects strings that contain control characters", () => {
    const result = validateProfileTable("opencode-main", {
      ...goodProfile(),
      label: "opencode\nmain",
    })
    expect(result.kind).toBe("error")
  })

  test("exposes the closed enum of allowed profile and option fields", () => {
    expect(KNOWN_PROFILE_FIELDS.length).toBeGreaterThan(0)
    expect(KNOWN_OPTION_FIELDS.length).toBeGreaterThan(0)
    for (const name of KNOWN_PROFILE_FIELDS) {
      expect(typeof name).toBe("string")
    }
    expect(RESERVED_FORBIDDEN_FIELDS).toContain("token")
    expect(RESERVED_FORBIDDEN_FIELDS).toContain("api_key")
  })
})

describe("validateConfig", () => {
  const goodConfig = () => ({
    default_profile: "opencode-main",
    log_dir: "~/.local/state/issue-killer/logs",
    profiles: {
      "opencode-main": goodProfile(),
    },
  })

  test("accepts a minimal valid config", () => {
    const result = validateConfig(goodConfig())
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.config.defaultProfile).toBe("opencode-main")
      expect(result.config.profiles.size).toBe(1)
    }
  })

  test("rejects missing default_profile", () => {
    const cfg = goodConfig()
    delete (cfg as { default_profile?: string }).default_profile
    const result = validateConfig(cfg)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.path).toBe("default_profile")
    }
  })

  test("rejects unknown top-level keys", () => {
    const result = validateConfig({ ...goodConfig(), evil_key: 1 })
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.path).toContain("evil_key")
    }
  })

  test("rejects missing log_dir", () => {
    const cfg = goodConfig()
    delete (cfg as { log_dir?: string }).log_dir
    const result = validateConfig(cfg)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.path).toBe("log_dir")
    }
  })

  test("rejects empty log_dir", () => {
    const result = validateConfig({ ...goodConfig(), log_dir: "" })
    expect(result.kind).toBe("error")
  })

  test("rejects log_dir with control characters", () => {
    const result = validateConfig({ ...goodConfig(), log_dir: "/tmp/x\ny" })
    expect(result.kind).toBe("error")
  })

  test("rejects default_profile referencing unknown profile", () => {
    const result = validateConfig({
      ...goodConfig(),
      default_profile: "ghost",
    })
    expect(result.kind).toBe("error")
  })

  test("rejects empty profiles table", () => {
    const result = validateConfig({
      ...goodConfig(),
      profiles: {},
    })
    expect(result.kind).toBe("error")
  })

  test("rejects cyclic fallback chains across profiles", () => {
    const result = validateConfig({
      ...goodConfig(),
      profiles: {
        a: { ...goodProfile(), fallbacks: ["b"] },
        b: { ...goodProfile(), fallbacks: ["a"] },
      },
      default_profile: "a",
    })
    expect(result.kind).toBe("error")
  })

  test("rejects fallback referencing unknown profile", () => {
    const result = validateConfig({
      ...goodConfig(),
      profiles: {
        "opencode-main": { ...goodProfile(), fallbacks: ["opencode-missing"] },
      },
    })
    expect(result.kind).toBe("error")
  })

  test("rejects profiles that is not a table", () => {
    const result = validateConfig({
      ...goodConfig(),
      profiles: [],
    })
    expect(result.kind).toBe("error")
  })

  test("rejects duplicate fallbacks", () => {
    const result = validateConfig({
      ...goodConfig(),
      profiles: {
        "opencode-main": { ...goodProfile(), fallbacks: ["backup", "backup"] },
        backup: goodProfile(),
      },
      default_profile: "opencode-main",
    })
    expect(result.kind).toBe("error")
  })

  test("rejects config that is not an object", () => {
    expect(validateConfig(null).kind).toBe("error")
    expect(validateConfig(42).kind).toBe("error")
    expect(validateConfig("string").kind).toBe("error")
    expect(validateConfig([]).kind).toBe("error")
  })

  test("rejects default_profile that is not a string", () => {
    const result = validateConfig({ ...goodConfig(), default_profile: 5 })
    expect(result.kind).toBe("error")
  })

  test("rejects default_profile with control chars", () => {
    const result = validateConfig({ ...goodConfig(), default_profile: "bad\nname" })
    expect(result.kind).toBe("error")
  })
})
