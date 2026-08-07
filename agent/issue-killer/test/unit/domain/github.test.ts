import { describe, expect, test } from "bun:test"
import {
  GITHUB_CLOSED_STATE,
  GITHUB_EPIC_LABEL,
  GITHUB_EPIC_TITLE_PREFIX,
  GITHUB_EPIC_TYPE_NAME,
  GITHUB_OPEN_STATE,
  GITHUB_READY_LABEL,
  completionLabel,
  eligibilityReasonLabel,
  evaluateGithubEligibility,
  issueHasEpicLabel,
  issueHasReadyForAgentLabel,
  issueIsClosed,
  issueIsEpicType,
  issueIsOpen,
  issueIsUnassigned,
  issueTitleStartsWithEpicPrefix,
  parseGithubIssue,
  parseGithubPullRequest,
  parseGithubPullRequestList,
  verifyGithubCompletion,
  type GithubIssue,
  type GithubPullRequest,
} from "../../../src/domain/github"

const baseIssue: GithubIssue = {
  number: 91,
  state: GITHUB_OPEN_STATE,
  title: "issue-killer V2: retire Bash V1",
  labels: [{ name: "enhancement" }, { name: GITHUB_READY_LABEL }],
  assignees: [],
  issueType: { name: "Feature" },
}

describe("GitHub eligibility helpers", () => {
  test("ready-for-agent label match is case-insensitive", () => {
    const issue: GithubIssue = {
      ...baseIssue,
      labels: [{ name: GITHUB_READY_LABEL.toUpperCase() }],
    }
    expect(issueHasReadyForAgentLabel(issue)).toBe(true)
  })

  test("epic label match is case-insensitive", () => {
    const issue: GithubIssue = {
      ...baseIssue,
      labels: [{ name: GITHUB_EPIC_LABEL.toUpperCase() }],
    }
    expect(issueHasEpicLabel(issue)).toBe(true)
  })

  test("isOpen tolerates missing state and recognizes OPEN/CLOSED", () => {
    expect(issueIsOpen({ ...baseIssue, state: GITHUB_OPEN_STATE })).toBe(true)
    expect(issueIsOpen({ ...baseIssue, state: GITHUB_CLOSED_STATE })).toBe(false)
    expect(issueIsOpen({ ...baseIssue, state: undefined })).toBe(false)
    expect(issueIsClosed({ ...baseIssue, state: GITHUB_CLOSED_STATE })).toBe(true)
  })

  test("unassigned treats missing array as unassigned and rejects non-empty arrays", () => {
    expect(issueIsUnassigned(baseIssue)).toBe(true)
    expect(issueIsUnassigned({ ...baseIssue, assignees: [{}] })).toBe(false)
    expect(issueIsUnassigned({ ...baseIssue, assignees: undefined })).toBe(true)
  })

  test("epic type and title-prefix checks target the documented shapes", () => {
    expect(issueIsEpicType({ ...baseIssue, issueType: { name: GITHUB_EPIC_TYPE_NAME } })).toBe(true)
    expect(issueIsEpicType({ ...baseIssue, issueType: null })).toBe(false)
    expect(issueIsEpicType({ ...baseIssue, issueType: undefined })).toBe(false)
    expect(issueTitleStartsWithEpicPrefix({ ...baseIssue, title: `${GITHUB_EPIC_TITLE_PREFIX} foo` })).toBe(true)
    expect(issueTitleStartsWithEpicPrefix({ ...baseIssue, title: "Issue" })).toBe(false)
  })
})

describe("evaluateGithubEligibility", () => {
  test("returns eligible for a fully matching open issue", () => {
    const decision = evaluateGithubEligibility({ issue: baseIssue, blockedByCount: 0 })
    expect(decision.kind).toBe("eligible")
  })

  test("rejects assigned issues", () => {
    const decision = evaluateGithubEligibility({
      issue: { ...baseIssue, assignees: [{ login: "someone" }] },
      blockedByCount: 0,
    })
    expect(decision.kind).toBe("ineligible")
    if (decision.kind === "ineligible") {
      expect(decision.reasons).toContain("assigned_to_user")
    }
  })

  test("rejects issues missing the ready-for-agent label", () => {
    const decision = evaluateGithubEligibility({
      issue: { ...baseIssue, labels: [{ name: "enhancement" }] },
      blockedByCount: 0,
    })
    expect(decision.kind).toBe("ineligible")
    if (decision.kind === "ineligible") {
      expect(decision.reasons).toContain("missing_ready_for_agent_label")
    }
  })

  test("rejects epic-typed, epic-labeled, and [Epic]-titled issues", () => {
    const byType = evaluateGithubEligibility({
      issue: { ...baseIssue, issueType: { name: GITHUB_EPIC_TYPE_NAME } },
      blockedByCount: 0,
    })
    expect(byType.kind).toBe("ineligible")
    if (byType.kind === "ineligible") {
      expect(byType.reasons).toContain("epic_type")
    }

    const byLabel = evaluateGithubEligibility({
      issue: { ...baseIssue, labels: [...(baseIssue.labels ?? []), { name: GITHUB_EPIC_LABEL }] },
      blockedByCount: 0,
    })
    expect(byLabel.kind).toBe("ineligible")
    if (byLabel.kind === "ineligible") {
      expect(byLabel.reasons).toContain("epic_label_present")
    }

    const byTitle = evaluateGithubEligibility({
      issue: { ...baseIssue, title: `${GITHUB_EPIC_TITLE_PREFIX} epic` },
      blockedByCount: 0,
    })
    expect(byTitle.kind).toBe("ineligible")
    if (byTitle.kind === "ineligible") {
      expect(byTitle.reasons).toContain("epic_title_prefix")
    }
  })

  test("rejects closed issues", () => {
    const decision = evaluateGithubEligibility({
      issue: { ...baseIssue, state: GITHUB_CLOSED_STATE },
      blockedByCount: 0,
    })
    expect(decision.kind).toBe("ineligible")
    if (decision.kind === "ineligible") {
      expect(decision.reasons).toContain("state_not_open")
    }
  })

  test("rejects open blocker counts > 0", () => {
    const decision = evaluateGithubEligibility({
      issue: baseIssue,
      blockedByCount: 2,
    })
    expect(decision.kind).toBe("ineligible")
    if (decision.kind === "ineligible") {
      expect(decision.reasons).toContain("open_blocker_present")
    }
  })

  test("treats null blocked-by count as zero", () => {
    const decision = evaluateGithubEligibility({
      issue: baseIssue,
      blockedByCount: null,
    })
    expect(decision.kind).toBe("eligible")
  })

  test("rejects missing/invalid issue numbers before any other rule", () => {
    const decision = evaluateGithubEligibility({
      issue: { ...baseIssue, number: 0 },
      blockedByCount: 0,
    })
    expect(decision.kind).toBe("ineligible")
    if (decision.kind === "ineligible") {
      expect(decision.issueNumber).toBeNull()
      expect(decision.reasons).toContain("missing_issue_number")
    }
  })

  test("aggregates every disqualifying reason", () => {
    const decision = evaluateGithubEligibility({
      issue: {
        ...baseIssue,
        state: GITHUB_CLOSED_STATE,
        assignees: [{ login: "x" }],
        labels: [{ name: GITHUB_READY_LABEL }, { name: GITHUB_EPIC_LABEL }],
        issueType: { name: GITHUB_EPIC_TYPE_NAME },
        title: `${GITHUB_EPIC_TITLE_PREFIX} group`,
      },
      blockedByCount: 1,
    })
    expect(decision.kind).toBe("ineligible")
    if (decision.kind === "ineligible") {
      expect(decision.reasons).toEqual(
        expect.arrayContaining([
          "state_not_open",
          "assigned_to_user",
          "epic_label_present",
          "epic_type",
          "epic_title_prefix",
          "open_blocker_present",
        ]),
      )
    }
  })

  test("eligibilityReasonLabel covers every variant", () => {
    for (const reason of [
      "state_not_open",
      "missing_ready_for_agent_label",
      "assigned_to_user",
      "epic_label_present",
      "epic_type",
      "epic_title_prefix",
      "open_blocker_present",
      "missing_issue_number",
    ] as const) {
      expect(eligibilityReasonLabel(reason)).toBeTruthy()
    }
  })
})

describe("verifyGithubCompletion", () => {
  const closedIssue: GithubIssue = { ...baseIssue, state: GITHUB_CLOSED_STATE }

  const singleMergedPr: GithubPullRequest = {
    number: 12,
    state: "MERGED",
    mergedAt: "2026-08-06T10:00:00Z",
    baseRefName: "main",
    headRefName: "issue-91",
  }

  test("returns verified for closed issue + one merged PR into the base branch", () => {
    const result = verifyGithubCompletion({
      issue: closedIssue,
      baseBranch: "main",
      pullRequests: [singleMergedPr],
    })
    expect(result.kind).toBe("verified")
    if (result.kind === "verified") {
      expect(result.prNumber).toBe(12)
      expect(result.baseRef).toBe("main")
    }
  })

  test("returns issue_still_open when the issue is open", () => {
    const result = verifyGithubCompletion({
      issue: baseIssue,
      baseBranch: "main",
      pullRequests: [singleMergedPr],
    })
    expect(result.kind).toBe("issue_still_open")
  })

  test("returns no_attributable_pr when no PR has a mergedAt timestamp", () => {
    const result = verifyGithubCompletion({
      issue: closedIssue,
      baseBranch: "main",
      pullRequests: [
        { number: 12, state: "OPEN", baseRefName: "main", mergedAt: null },
        { number: 13, state: "MERGED", baseRefName: "main", mergedAt: undefined },
      ],
    })
    expect(result.kind).toBe("no_attributable_pr")
  })

  test("returns multiple_prs when more than one PR has mergedAt", () => {
    const result = verifyGithubCompletion({
      issue: closedIssue,
      baseBranch: "main",
      pullRequests: [
        { number: 12, mergedAt: "2026-08-01T00:00:00Z", baseRefName: "main" },
        { number: 13, mergedAt: "2026-08-02T00:00:00Z", baseRefName: "main" },
      ],
    })
    expect(result.kind).toBe("multiple_prs")
    if (result.kind === "multiple_prs") {
      expect(result.count).toBe(2)
    }
  })

  test("returns pr_unmerged for an open PR (no mergedAt)", () => {
    const result = verifyGithubCompletion({
      issue: closedIssue,
      baseBranch: "main",
      pullRequests: [{ number: 12, state: "OPEN", baseRefName: "main" }],
    })
    expect(result.kind).toBe("no_attributable_pr")
  })

  test("returns wrong_base_branch when baseRefName does not match", () => {
    const result = verifyGithubCompletion({
      issue: closedIssue,
      baseBranch: "main",
      pullRequests: [
        {
          number: 12,
          mergedAt: "2026-08-06T10:00:00Z",
          baseRefName: "develop",
        },
      ],
    })
    expect(result.kind).toBe("wrong_base_branch")
    if (result.kind === "wrong_base_branch") {
      expect(result.expected).toBe("main")
      expect(result.actual).toBe("develop")
    }
  })

  test("returns malformed when base branch is empty", () => {
    const result = verifyGithubCompletion({
      issue: closedIssue,
      baseBranch: "   ",
      pullRequests: [singleMergedPr],
    })
    expect(result.kind).toBe("malformed")
  })

  test("returns missing_issue_number when the issue has no valid number", () => {
    const result = verifyGithubCompletion({
      issue: { ...closedIssue, number: 0 },
      baseBranch: "main",
      pullRequests: [singleMergedPr],
    })
    expect(result.kind).toBe("missing_issue_number")
  })

  test("returns malformed when the single merged PR lacks a number", () => {
    const result = verifyGithubCompletion({
      issue: closedIssue,
      baseBranch: "main",
      pullRequests: [
        {
          state: "MERGED",
          mergedAt: "2026-08-06T10:00:00Z",
          baseRefName: "main",
        },
      ],
    })
    expect(result.kind).toBe("malformed")
  })

  test("completionLabel covers every variant", () => {
    const variants = [
      verifyGithubCompletion({
        issue: closedIssue,
        baseBranch: "main",
        pullRequests: [singleMergedPr],
      }),
      verifyGithubCompletion({
        issue: baseIssue,
        baseBranch: "main",
        pullRequests: [singleMergedPr],
      }),
      verifyGithubCompletion({
        issue: closedIssue,
        baseBranch: "main",
        pullRequests: [],
      }),
      verifyGithubCompletion({
        issue: closedIssue,
        baseBranch: "main",
        pullRequests: [
          { number: 1, mergedAt: "x", baseRefName: "main" },
          { number: 2, mergedAt: "y", baseRefName: "main" },
        ],
      }),
      verifyGithubCompletion({
        issue: closedIssue,
        baseBranch: "main",
        pullRequests: [{ number: 7, mergedAt: "x", baseRefName: "other" }],
      }),
      verifyGithubCompletion({
        issue: closedIssue,
        baseBranch: "",
        pullRequests: [singleMergedPr],
      }),
      verifyGithubCompletion({
        issue: { ...closedIssue, number: 0 },
        baseBranch: "main",
        pullRequests: [singleMergedPr],
      }),
    ]
    for (const variant of variants) {
      expect(completionLabel(variant).length).toBeGreaterThan(0)
    }
  })
})

describe("GitHub JSON parsers", () => {
  test("parseGithubIssue tolerates missing optional fields", () => {
    const issue = parseGithubIssue({ number: 5 })
    expect(issue).not.toBeNull()
    if (issue !== null) {
      expect(issue.number).toBe(5)
      expect(issue.state).toBeUndefined()
    }
  })

  test("parseGithubIssue rejects non-objects", () => {
    expect(parseGithubIssue(null)).toBeNull()
    expect(parseGithubIssue(7)).toBeNull()
    expect(parseGithubIssue("issue")).toBeNull()
  })

  test("parseGithubIssue rejects non-integer numbers", () => {
    expect(parseGithubIssue({ number: 1.5 })).toBeNull()
    expect(parseGithubIssue({})).toBeNull()
  })

  test("parseGithubPullRequest preserves mergedAt null and string variants", () => {
    expect(parseGithubPullRequest({ number: 1, mergedAt: null })?.mergedAt).toBeNull()
    expect(parseGithubPullRequest({ number: 1, mergedAt: "x" })?.mergedAt).toBe("x")
    expect(parseGithubPullRequest({ number: 1 })?.mergedAt).toBeUndefined()
  })

  test("parseGithubPullRequest rejects malformed entries", () => {
    expect(parseGithubPullRequest({ mergedAt: "x" })).toBeNull()
  })

  test("parseGithubPullRequestList returns null on any malformed entry", () => {
    expect(parseGithubPullRequestList([{ number: 1 }, null])).toBeNull()
  })
})