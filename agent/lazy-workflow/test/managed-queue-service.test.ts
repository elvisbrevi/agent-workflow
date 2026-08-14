import { describe, expect, test } from "bun:test";
import {
  classifyQueueIssues,
  GitHubManagedQueueService,
  isEligibleManagedIssue,
  orderEligibleManagedIssues,
  type GhRunner,
  type ManagedIssue,
  type ManagedQueueOutcome,
} from "../src/github/managed-queue-service.ts";

function issue(overrides: Partial<ManagedIssue>): ManagedIssue {
  return {
    number: 1,
    title: "feat(lazy-workflow): default",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    blockedBy: { nodes: [] },
    ...overrides,
  };
}

function ghRunner(responses: Map<string, string>): GhRunner {
  return async (args) => {
    const key = args.join(" ");
    if (responses.has(key)) return responses.get(key)!;
    throw new Error(`unexpected gh args: ${key}`);
  };
}

describe("classifyQueueIssues", () => {
  test("excludes pull requests, epics and specifications by title and label", () => {
    const classification = classifyQueueIssues([
      issue({ number: 1, title: "[Epic] Authoring platform" }),
      issue({ number: 2, title: "[Spec] Authoring platform" }),
      issue({ number: 3, title: "feat(lazy-workflow): select and claim one GitHub issue deterministically", labels: [{ name: "epic" }] }),
      issue({ number: 4, title: "feat(lazy-workflow): select and claim one GitHub issue deterministically", labels: [{ name: "ready-for-agent" }] }),
    ]);

    expect(classification.managed.map(({ number }) => number)).toEqual([1, 2, 3, 4]);
    expect(classification.eligible.map(({ number }) => number)).toEqual([4]);
    expect(classification.blocked.find(({ number }) => number === 1)?.reasons).toContain("epic-or-spec");
    expect(classification.blocked.find(({ number }) => number === 2)?.reasons).toContain("epic-or-spec");
    expect(classification.blocked.find(({ number }) => number === 3)?.reasons).toContain("epic-or-spec");
  });

  test("excludes closed issues, assigned issues, wrong label, and open blockers", () => {
    const classification = classifyQueueIssues([
      issue({ number: 10, title: "feat(lazy-workflow): closed", state: "CLOSED" }),
      issue({ number: 11, title: "feat(lazy-workflow): assigned", assignees: [{ login: "reviewer" }] }),
      issue({ number: 12, title: "feat(lazy-workflow): wrong label", labels: [{ name: "needs-triage" }] }),
      issue({
        number: 13,
        title: "feat(lazy-workflow): blocked",
        blockedBy: { nodes: [{ number: 99, state: "OPEN" }] },
      }),
      issue({
        number: 14,
        title: "feat(lazy-workflow): closed blocker",
        blockedBy: { nodes: [{ number: 99, state: "CLOSED" }] },
      }),
      issue({ number: 15, title: "feat(lazy-workflow): eligible" }),
    ]);

    expect(classification.managed.map(({ number }) => number)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(classification.eligible.map(({ number }) => number)).toEqual([14, 15]);
    const blockers = new Map(classification.blocked.map((entry) => [entry.number, entry.reasons]));
    expect(blockers.get(10)).toContain("closed");
    expect(blockers.get(11)).toContain("assigned");
    expect(blockers.get(12)).toContain("wrong-label");
    expect(blockers.get(13)).toContain("has-blocker");
  });
});

describe("orderEligibleManagedIssues", () => {
  test("orders by createdAt ascending then by issue number ascending", () => {
    const ordered = orderEligibleManagedIssues([
      issue({ number: 200, createdAt: "2024-03-01T00:00:00Z" }),
      issue({ number: 150, createdAt: "2024-01-01T00:00:00Z" }),
      issue({ number: 175, createdAt: "2024-01-01T00:00:00Z" }),
      issue({ number: 100, createdAt: "2023-12-01T00:00:00Z" }),
    ]);

    expect(ordered.map(({ number }) => number)).toEqual([100, 150, 175, 200]);
  });
});

describe("isEligibleManagedIssue", () => {
  test("returns false for the same managed issue unless it satisfies every rule", () => {
    const base = issue({});
    expect(isEligibleManagedIssue(base)).toBeTrue();
    expect(isEligibleManagedIssue({ ...base, state: "CLOSED" })).toBeFalse();
    expect(isEligibleManagedIssue({ ...base, assignees: [{ login: "x" }] })).toBeFalse();
    expect(isEligibleManagedIssue({ ...base, labels: [] })).toBeFalse();
    expect(isEligibleManagedIssue({
      ...base,
      blockedBy: { nodes: [{ number: 1, state: "OPEN" }] },
    })).toBeFalse();
  });
});

describe("GitHubManagedQueueService", () => {
  test("verifies authentication and repository before any issue mutation", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "elvis" });
      if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ nameWithOwner: "elvisbrevi/agent-workflow" });
      if (args[0] === "issue" && args[1] === "list") return JSON.stringify([]);
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const service = new GitHubManagedQueueService(runner);

    const outcome = await service.selectAndClaimEligibleIssue("/repo");

    expect(outcome).toEqual<ManagedQueueOutcome>({ kind: "empty" });
    expect(calls.map((args) => args[0])).toEqual(["api", "repo", "issue"]);
  });

  test("returns empty when the managed queue has no managed issues", async () => {
    const runner = ghRunner(new Map([
      ["api user", JSON.stringify({ login: "elvis" })],
      ["repo view --json nameWithOwner", JSON.stringify({ nameWithOwner: "owner/repo" })],
      ["issue list --state open --label ready-for-agent --limit 100 --json number,title,state,labels,assignees,createdAt,blockedBy", JSON.stringify([])],
    ]));
    const outcome = await new GitHubManagedQueueService(runner).selectAndClaimEligibleIssue("/repo");
    expect(outcome).toEqual<ManagedQueueOutcome>({ kind: "empty" });
  });

  test("returns blocked with normalized reasons when every managed issue is ineligible", async () => {
    const runner = ghRunner(new Map([
      ["api user", JSON.stringify({ login: "elvis" })],
      ["repo view --json nameWithOwner", JSON.stringify({ nameWithOwner: "owner/repo" })],
      [
        "issue list --state open --label ready-for-agent --limit 100 --json number,title,state,labels,assignees,createdAt,blockedBy",
        JSON.stringify([
          issue({ number: 100, title: "feat(lazy-workflow): assigned", assignees: [{ login: "reviewer" }] }),
          issue({ number: 101, title: "[Spec] Planning note", state: "OPEN" }),
        ]),
      ],
    ]));

    const outcome = await new GitHubManagedQueueService(runner).selectAndClaimEligibleIssue("/repo");
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") return;
    const ids = outcome.reasons.map(({ number }) => number);
    expect(ids.sort()).toEqual([100, 101]);
    expect(outcome.reasons.find(({ number }) => number === 100)?.reasons).toContain("assigned");
    expect(outcome.reasons.find(({ number }) => number === 101)?.reasons).toContain("epic-or-spec");
  });

  test("selects the oldest eligible issue, claims it, rereads the claim and returns the repository", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "elvis" });
      if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ nameWithOwner: "owner/repo" });
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          issue({ number: 200, title: "feat(lazy-workflow): newer", createdAt: "2024-06-01T00:00:00Z" }),
          issue({ number: 175, title: "feat(lazy-workflow): oldest eligible", createdAt: "2024-01-01T00:00:00Z" }),
          issue({ number: 180, title: "feat(lazy-workflow): same created", createdAt: "2024-01-01T00:00:00Z" }),
        ]);
      }
      if (args[0] === "issue" && args[1] === "edit") {
        expect(args).toContain("175");
        expect(args).toContain("--add-assignee");
        expect(args).toContain("@me");
        return "";
      }
      if (args[0] === "issue" && args[1] === "view") {
        expect(args[2]).toBe("175");
        return JSON.stringify({
          number: 175,
          title: "feat(lazy-workflow): oldest eligible",
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "elvis" }],
          createdAt: "2024-01-01T00:00:00Z",
          body: "Issue body",
          comments: [],
          blockedBy: { nodes: [] },
        });
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const service = new GitHubManagedQueueService(runner);

    const outcome = await service.selectAndClaimEligibleIssue("/repo");

    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") return;
    expect(outcome.issue.number).toBe(175);
    expect(outcome.issue.title).toBe("feat(lazy-workflow): oldest eligible");
    expect(outcome.issue.body).toBe("Issue body");
    expect(outcome.repository).toEqual({ nameWithOwner: "owner/repo" });
    expect(calls.some((args) => args[0] === "issue" && args[1] === "edit")).toBeTrue();
    expect(calls.some((args) => args[0] === "issue" && args[1] === "view" && args[2] === "175")).toBeTrue();
  });

  test("rejects the candidate when the reread shows the issue is no longer open", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "elvis" });
      if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ nameWithOwner: "owner/repo" });
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          issue({ number: 175, title: "feat(lazy-workflow): oldest eligible", createdAt: "2024-01-01T00:00:00Z" }),
          issue({ number: 180, title: "feat(lazy-workflow): newer", createdAt: "2024-06-01T00:00:00Z" }),
        ]);
      }
      if (args[0] === "issue" && args[1] === "edit") return "";
      if (args[0] === "issue" && args[1] === "view" && args.includes("175")) {
        return JSON.stringify({
          number: 175,
          title: "feat(lazy-workflow): oldest eligible",
          state: "CLOSED",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "elvis" }],
          createdAt: "2024-01-01T00:00:00Z",
          body: "",
          comments: [],
          blockedBy: { nodes: [] },
        });
      }
      if (args[0] === "issue" && args[1] === "view" && args.includes("180")) {
        return JSON.stringify({
          number: 180,
          title: "feat(lazy-workflow): newer",
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "elvis" }],
          createdAt: "2024-06-01T00:00:00Z",
          body: "newer body",
          comments: [],
          blockedBy: { nodes: [] },
        });
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const outcome = await new GitHubManagedQueueService(runner).selectAndClaimEligibleIssue("/repo");
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") return;
    expect(outcome.issue.number).toBe(180);
  });

  test("refreshes selection safely when the claim is lost to another identity", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "elvis" });
      if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ nameWithOwner: "owner/repo" });
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          issue({ number: 175, title: "feat(lazy-workflow): oldest eligible", createdAt: "2024-01-01T00:00:00Z" }),
          issue({ number: 180, title: "feat(lazy-workflow): newer", createdAt: "2024-06-01T00:00:00Z" }),
        ]);
      }
      if (args[0] === "issue" && args[1] === "edit" && args.includes("175")) return "";
      if (args[0] === "issue" && args[1] === "view" && args.includes("175")) {
        return JSON.stringify({
          number: 175,
          title: "feat(lazy-workflow): oldest eligible",
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "other-reviewer" }],
          createdAt: "2024-01-01T00:00:00Z",
          body: "",
          comments: [],
          blockedBy: { nodes: [] },
        });
      }
      if (args[0] === "issue" && args[1] === "view" && args.includes("180")) {
        return JSON.stringify({
          number: 180,
          title: "feat(lazy-workflow): newer",
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "elvis" }],
          createdAt: "2024-06-01T00:00:00Z",
          body: "newer body",
          comments: [],
          blockedBy: { nodes: [] },
        });
      }
      if (args[0] === "issue" && args[1] === "edit" && args.includes("180")) return "";
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const service = new GitHubManagedQueueService(runner);

    const outcome = await service.selectAndClaimEligibleIssue("/repo");

    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") return;
    expect(outcome.issue.number).toBe(180);
    const otherClaimReleased = calls.some((args) => args[0] === "issue" && args[1] === "edit" && args.includes("--remove-assignee") && args.includes("other-reviewer"));
    expect(otherClaimReleased).toBeFalse();
  });

  test("releases the runner's own claim when @me ends up alongside another identity", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "elvis" });
      if (args[0] === "repo" && args[1] === "view") return JSON.stringify({ nameWithOwner: "owner/repo" });
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          issue({ number: 175, title: "feat(lazy-workflow): oldest eligible", createdAt: "2024-01-01T00:00:00Z" }),
          issue({ number: 180, title: "feat(lazy-workflow): newer", createdAt: "2024-06-01T00:00:00Z" }),
        ]);
      }
      if (args[0] === "issue" && args[1] === "view" && args.includes("175")) {
        return JSON.stringify({
          number: 175,
          title: "feat(lazy-workflow): oldest eligible",
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "other-reviewer" }, { login: "elvis" }],
          createdAt: "2024-01-01T00:00:00Z",
          body: "",
          comments: [],
          blockedBy: { nodes: [] },
        });
      }
      if (args[0] === "issue" && args[1] === "view" && args.includes("180")) {
        return JSON.stringify({
          number: 180,
          title: "feat(lazy-workflow): newer",
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }],
          assignees: [{ login: "elvis" }],
          createdAt: "2024-06-01T00:00:00Z",
          body: "newer body",
          comments: [],
          blockedBy: { nodes: [] },
        });
      }
      return "";
    };
    const outcome = await new GitHubManagedQueueService(runner).selectAndClaimEligibleIssue("/repo");
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") return;
    expect(outcome.issue.number).toBe(180);
    const ownReleased = calls.some((args) => args[0] === "issue" && args[1] === "edit" && args.includes("175") && args.includes("--remove-assignee") && args.includes("elvis"));
    expect(ownReleased).toBeTrue();
  });
});
