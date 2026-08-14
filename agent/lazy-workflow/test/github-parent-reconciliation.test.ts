import { expect, test } from "bun:test";
import { GitHubParentReconciliationService, type GitHubNativeIssueRelation } from "../src/github/github-parent-reconciliation-service.ts";

function page(data: unknown): string {
  return JSON.stringify([{ data }]);
}

function issue(number: number, state: string, parent: number | null, subIssues: GitHubNativeIssueRelation[] = []): GitHubNativeIssueRelation {
  return { number, title: `issue ${number}`, state, parent: parent ? { number: parent } : null, subIssues, blockedBy: [] };
}

function issueData(value: GitHubNativeIssueRelation): object {
  return {
    number: value.number,
    title: value.title,
    state: value.state,
    parent: value.parent,
    subIssues: { nodes: value.subIssues, pageInfo: { hasNextPage: false } },
  };
}

function runnerFor(replies: Map<string, string[]>, calls: string[][]): (args: string[], workingDirectory: string) => Promise<string> {
  return async (args) => {
    calls.push(args);
    if (args[0] === "issue" && (args[1] === "comment" || args[1] === "close")) return "";
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    const number = args.find((arg) => arg.startsWith("number="))?.slice("number=".length) ?? "";
    const key = query.includes("subIssues")
      ? `issue:${number}`
      : query.includes("blockedBy")
        ? `blocked:${number}`
        : query.includes("comments")
          ? `comments:${number}`
          : query.includes("issues(states:OPEN")
            ? "open"
            : args[0] === "repo" ? "repo" : args.slice(0, 3).join(" ");
    const response = replies.get(key)?.shift();
    if (response === undefined) throw new Error(`unexpected gh args: ${args.join(" ")}`);
    return response;
  };
}

test("reconciles a closed child through its native parent and verifies the closure", async () => {
  const calls: string[][] = [];
  const children = [issue(176, "CLOSED", 175), issue(177, "CLOSED", 175)];
  const replies = new Map<string, string[]>([
    ["repo", [JSON.stringify({ nameWithOwner: "owner/repo" })]],
    ["issue:180", [page({ repository: { issue: issueData(issue(180, "OPEN", 175)) } })]],
    ["issue:175", [page({ repository: { issue: issueData(issue(175, "OPEN", null, children)) } }), page({ repository: { issue: issueData(issue(175, "CLOSED", null, children)) } })]],
    ["blocked:180", [page({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
    ["blocked:175", [page({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } }), page({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
    ["comments:175", [page({ repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
  ]);
  const service = new GitHubParentReconciliationService(runnerFor(replies, calls));

  await service.reconcileParents(180, "/repo");

  expect(calls.some((args) => args[0] === "issue" && args[1] === "comment" && args[2] === "175")).toBeTrue();
  expect(calls.some((args) => args[0] === "issue" && args[1] === "close" && args[2] === "175")).toBeTrue();
  expect(calls.some((args) => args.includes("--paginate") && args.includes("--slurp"))).toBeTrue();
});

test("leaves a parent open when a native child relation conflicts", async () => {
  const calls: string[][] = [];
  const replies = new Map<string, string[]>([
    ["repo", [JSON.stringify({ nameWithOwner: "owner/repo" })]],
    ["issue:180", [page({ repository: { issue: issueData(issue(180, "OPEN", 175)) } })]],
    ["issue:175", [page({ repository: { issue: issueData(issue(175, "OPEN", null, [issue(176, "CLOSED", 999)])) } })]],
    ["blocked:180", [page({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
    ["blocked:175", [page({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
  ]);
  const service = new GitHubParentReconciliationService(runnerFor(replies, calls));

  await expect(service.reconcileParents(180, "/repo")).rejects.toThrow("ambigua");
  expect(calls.some((args) => args[0] === "issue" && args[1] === "close")).toBeFalse();
});
