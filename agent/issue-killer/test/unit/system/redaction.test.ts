import { describe, expect, test } from "bun:test"
import {
  REDACTED_AUTHORIZATION,
  REDACTED_BEARER,
  REDACTED_PRIVATE_KEY,
  REDACTED_PROVIDER_TOKEN,
  containsRedactionPlaceholder,
  redactLine,
  redactMultiline,
} from "../../../src/system/redaction"

describe("redactLine", () => {
  test("redacts authorization headers with various separators", () => {
    const cases = [
      { input: "Authorization: Bearer abc123XYZ", expected: "<redacted:authorization>" },
      { input: "authorization=token_value_123", expected: "<redacted:authorization>" },
      { input: "AUTHORIZATION:abc.def-ghi", expected: "<redacted:authorization>" },
    ]
    for (const { input, expected } of cases) {
      const { text, reasons } = redactLine(input)
      expect(text).toContain(expected)
      expect(reasons).toContain("authorization_header")
    }
  })

  test("redacts bearer tokens", () => {
    const cases = [
      { input: "Bearer abc123XYZ", expected: "<redacted:bearer>" },
      { input: "bearer: abcdef.ghijkl", expected: "<redacted:bearer>" },
    ]
    for (const { input, expected } of cases) {
      const { text, reasons } = redactLine(input)
      expect(text).toContain(expected)
      expect(reasons).toContain("bearer_token")
    }
  })

  test("redacts credential pairs with surrounding punctuation", () => {
    const cases = [
      { input: "api_key=abc123XYZ", mustContain: "api_key=<redacted>" },
      { input: "PASSWORD: hunter2hunter2", mustContain: "PASSWORD=<redacted>" },
      { input: "secret = 'topsecret'", mustContain: "secret=<redacted>" },
      { input: "access-token: abc123XYZ", mustContain: "access-token=<redacted>" },
      { input: "auth_token=abcdef123456", mustContain: "auth_token=<redacted>" },
    ]
    for (const { input, mustContain } of cases) {
      const { text, reasons } = redactLine(input)
      expect(text).toContain(mustContain)
      expect(reasons).toContain("credential_pair")
    }
  })

  test("redacts credentials embedded in URLs", () => {
    const { text, reasons } = redactLine("https://operator:super-secret@example.test/path")
    expect(text).toBe("https://<redacted:credential>@example.test/path")
    expect(text.includes("super-secret")).toBe(false)
    expect(reasons).toContain("credential_pair")
  })

  test("redacts GitHub provider tokens of every shape", () => {
    const tokens = ["ghp_abc123XYZ", "ghs_def456ABC", "gho_ghi789JKL", "ghu_mno012PQR", "ghr_stu345VWX"]
    for (const token of tokens) {
      const { text, reasons } = redactLine(`token=${token} extra`)
      expect(text).toContain(REDACTED_PROVIDER_TOKEN)
      expect(text.includes(token)).toBe(false)
      expect(reasons).toContain("provider_token")
    }
  })

  test("leaves plain text untouched", () => {
    const { text, reasons } = redactLine("echo hello world")
    expect(text).toBe("echo hello world")
    expect(reasons).toEqual([])
  })
})

describe("redactMultiline", () => {
  test("redacts multi-line PEM private keys block (V2-SEC-07)", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBALR9vQyqQHj4f4b3k5p9z2c2iYXbXj2nOm2oC",
      "VyX0y8mCgZqQ9lpXbWaQ1r5q8W0S3B8S6l2k0lVTcCAwEAAQJ",
      "AYm5o+5w7y8z9Xj/3TpQ4f6J8w9wYx8Qv+u+slQ==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n")
    const { text, reasons } = redactMultiline(pem)
    expect(text).toContain(REDACTED_PRIVATE_KEY)
    expect(text.includes("MIIBOgIBAAJBALR9vQy")).toBe(false)
    expect(text.includes("AYm5o+5w7y8z9Xj/3TpQ4f6J8w9wYx8Qv+u+slQ==")).toBe(false)
    expect(reasons).toContain("private_key_block")
    expect(containsRedactionPlaceholder(text)).toBe(true)
  })

  test("redacts single-line BEGIN/END blocks without leaking the body", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----MHcCAQE=\n-----END EC PRIVATE KEY-----"
    const { text } = redactMultiline(pem)
    expect(text.includes("MHcCAQE=")).toBe(false)
    expect(text).toContain(REDACTED_PRIVATE_KEY)
  })

  test("preserves lines outside the private key block", () => {
    const input = [
      "command: ssh-keygen",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB",
      "-----END OPENSSH PRIVATE KEY-----",
      "status: ok",
    ].join("\n")
    const { text, reasons } = redactMultiline(input)
    expect(text.includes("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB")).toBe(false)
    expect(text).toContain("command: ssh-keygen")
    expect(text).toContain("status: ok")
    expect(reasons).toContain("private_key_block")
  })

  test("redacts bearer tokens inside otherwise normal multi-line text", () => {
    const input = ["line one", "Bearer abcdef123", "line three"].join("\n")
    const { text } = redactMultiline(input)
    expect(text).toContain(REDACTED_BEARER)
    expect(text.includes("abcdef123")).toBe(false)
  })
})
