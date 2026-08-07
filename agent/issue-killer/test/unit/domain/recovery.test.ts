import { describe, expect, test } from "bun:test"
import {
  AdoptionParse,
  RecoveryDecision,
  decideRecovery,
  isResumable,
  parseAdoptionValue,
  recoveryDecisionLabel,
  resumeCheckLabel,
  resumeModeFromCheck,
  summarizeDrift,
} from "../../../src/domain/recovery"
import { asHuNumber, asIssueNumber, asTicketNumber } from "../../../src/domain/checkpoint"
import { parseSessionId } from "../../../src/domain/session-id"
import { TrackerIdentity } from "../../../src/domain/tracker"

const githubIdentity = (number: number): TrackerIdentity => {
  const value = asIssueNumber(number)
  if (value === null) throw new Error("expected valid github identity")
  return { kind: "github", number: value }
}

const azureIdentity = (hu: number, ticket: number): TrackerIdentity => {
  const huValue = asHuNumber(hu)
  const ticketValue = asTicketNumber(ticket)
  if (huValue === null || ticketValue === null) throw new Error("expected valid azure identity")
  return { kind: "azure_ticket", hu: huValue, ticket: ticketValue }
}

describe("parseAdoptionValue", () => {
  test("rejects undefined and empty values", () => {
    const missing: AdoptionParse = parseAdoptionValue(undefined)
    expect(missing).toEqual({ kind: "missing_value", variable: "ISSUE_RUNNER_ADOPT_ISSUE" })
    expect(parseAdoptionValue("")).toEqual({ kind: "empty" })
    expect(parseAdoptionValue("   ")).toEqual({ kind: "empty" })
  })

  test("rejects payloads that contain disallowed characters", () => {
    expect(parseAdoptionValue("a b").kind).toBe("malformed")
    expect(parseAdoptionValue("../etc/passwd").kind).toBe("malformed")
    expect(parseAdoptionValue("1;rm -rf /").kind).toBe("malformed")
    expect(parseAdoptionValue("1\n2").kind).toBe("malformed")
  })

  test("parses GitHub issue numbers", () => {
    const parsed = parseAdoptionValue("79")
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") {
      expect(parsed.identity).toEqual(githubIdentity(79))
    }
  })

  test("rejects zero, negative, and non-integer GitHub values", () => {
    expect(parseAdoptionValue("0").kind).toBe("malformed")
    expect(parseAdoptionValue("-1").kind).toBe("malformed")
    expect(parseAdoptionValue("1.5").kind).toBe("malformed")
  })

  test("parses Azure HU/TICKET pairs", () => {
    const parsed = parseAdoptionValue("1234/56")
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") {
      expect(parsed.identity).toEqual(azureIdentity(1234, 56))
    }
  })

  test("rejects malformed Azure adoption values", () => {
    expect(parseAdoptionValue("1234/56/78").kind).toBe("malformed")
    expect(parseAdoptionValue("1234/abc").kind).toBe("malformed")
    expect(parseAdoptionValue("abc/1").kind).toBe("malformed")
    expect(parseAdoptionValue("0/1").kind).toBe("malformed")
    expect(parseAdoptionValue("1/0").kind).toBe("malformed")
  })
})

describe("decideRecovery", () => {
  const context = {
    currentState: "starting" as const,
    identity: githubIdentity(91),
    branch: "feature/79-ts-scaffold-domain-ports",
    baseBranch: "main",
    baseSha: "0123456789abcdef",
    fallbackChain: ["opencode-backup"],
  }

  test("returns a fresh worker decision when no session id is present", () => {
    const decision = decideRecovery(context, undefined)
    expect(decision.kind).toBe("fresh_worker_constrained")
  })

  test("returns a resume decision when a session id is present", () => {
    const session = parseSessionId("ses_recover_ABC")
    if (session === null) throw new Error("expected valid session id")
    const decision = decideRecovery(context, session)
    expect(decision).toEqual({ kind: "resume", sessionId: session })
  })
})

describe("isResumable and resumeModeFromCheck", () => {
  const session = parseSessionId("ses_resume_AAA")
  if (session === null) throw new Error("expected valid session id")

  test("classify the discriminator variants", () => {
    const identity = githubIdentity(91)
    const resumable = {
      kind: "resumable" as const,
      sessionId: session,
      identity,
      directory: "/repo",
      branch: "main",
      baseSha: "0123456789abcdef",
      profileName: "opencode-main",
      runtime: "opencode" as const,
    }
    expect(isResumable(resumable)).toBe(true)
    expect(resumeModeFromCheck(resumable)).toEqual({ kind: "resume", sessionId: session })

    expect(
      resumeModeFromCheck({ kind: "directory_mismatch", expected: "a", actual: "b" }),
    ).toEqual({
      kind: "drift_detected",
      reasons: ["directory_mismatch: expected a; got b"],
    })
    expect(resumeModeFromCheck({ kind: "missing", identity })).toEqual({ kind: "fresh_worker" })
  })
})

describe("resumeCheckLabel", () => {
  test("covers every discriminator variant without falling through", () => {
    const identity = githubIdentity(91)
    expect(
      resumeCheckLabel({
        kind: "resumable",
        sessionId: parseSessionId("ses_AAA") ?? (() => {
          throw new Error("invalid session id")
        })(),
        identity,
        directory: "/",
        branch: "main",
        baseSha: "0",
        profileName: "opencode-main",
        runtime: "opencode",
      }),
    ).toBe("session is resumable")
    expect(
      resumeCheckLabel({ kind: "directory_mismatch", expected: "a", actual: "b" }),
    ).toBe("directory mismatch (expected a; got b)")
    expect(
      resumeCheckLabel({ kind: "branch_drift", expected: "main", actual: "feature/91" }),
    ).toBe("branch drift (expected main; got feature/91)")
    expect(
      resumeCheckLabel({ kind: "wrong_runtime", expected: "opencode", actual: "codex" }),
    ).toBe("runtime drift (expected opencode; got codex)")
    expect(
      resumeCheckLabel({ kind: "missing", identity }),
    ).toBe("session missing for github issue 91")
  })
})

describe("recoveryDecisionLabel", () => {
  test("labels every decision variant without falling through", () => {
    const identity = githubIdentity(91)
    const decisions: RecoveryDecision[] = [
      { kind: "fresh_worker_constrained" },
      { kind: "adopt", identity },
      { kind: "drift_recovery_required", reasons: ["branch mismatch"] },
      { kind: "blocked", reason: "operator confirmation missing" },
      {
        kind: "fallback_consume",
        category: "provider_quota",
        nextProfile: "opencode-backup",
        fromProfile: "opencode-main",
      },
    ]
    for (const decision of decisions) {
      const label = recoveryDecisionLabel(decision)
      expect(label.length).toBeGreaterThan(0)
    }
  })
})

describe("summarizeDrift", () => {
  test("joins reasons with a separator", () => {
    expect(summarizeDrift({ reasons: ["a", "b", "c"] })).toBe("a; b; c")
    expect(summarizeDrift({ reasons: [] })).toBe("")
  })
})
