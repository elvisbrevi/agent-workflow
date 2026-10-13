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
  const children = [issue(176, "CLOSED", 175), issue(177, "CLOSED", 175), issue(180, "CLOSED", 175)];
  const replies = new Map<string, string[]>([
    ["repo", [JSON.stringify({ nameWithOwner: "owner/repo" })]],
    ["issue:180", [page({ repository: { issue: issueData(issue(180, "CLOSED", 175)) } })]],
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
    ["issue:175", [page({ repository: { issue: issueData(issue(175, "OPEN", null, [issue(176, "CLOSED", 175)])) } })]],
    ["blocked:180", [page({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
    ["blocked:175", [page({ repository: { issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
  ]);
  const service = new GitHubParentReconciliationService(runnerFor(replies, calls));

  await expect(service.reconcileParents(180, "/repo")).rejects.toThrow("ambigua");
  expect(calls.some((args) => args[0] === "issue" && args[1] === "close")).toBeFalse();
});

test("closes an epic in another repository once its sub-issues there and here are closed (ADR-0049)", async () => {
  const calls: string[][] = [];
  const empty = (connection: string) => page({ repository: { issue: { [connection]: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  const node = (number: number, repository: string, state: string) =>
    ({ number, title: `issue ${number}`, state, repository: { nameWithOwner: repository }, parent: { number: 40, repository: { nameWithOwner: "owner/plans" } } });
  const epic = (state: string) => page({ repository: { issue: {
    number: 40, title: "[Epic] Portal", state, parent: null,
    subIssues: { nodes: [node(12, "owner/work", "CLOSED"), node(13, "owner/work", "CLOSED")], pageInfo: { hasNextPage: false } },
  } } });
  const replies = new Map<string, string[]>([
    ["owner/work#12", [page({ repository: { issue: { number: 12, title: "uno", state: "CLOSED", parent: { number: 40, repository: { nameWithOwner: "owner/plans" } }, subIssues: { nodes: [], pageInfo: { hasNextPage: false } } } } })]],
    ["owner/plans#40", [epic("OPEN"), epic("CLOSED")]],
  ]);
  const service = new GitHubParentReconciliationService(async (args) => {
    calls.push(args);
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/work" });
    if (args[0] === "issue") return "";
    const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))!.slice(name.length + 1);
    const query = value("query");
    if (query.includes("blockedBy")) return empty("blockedBy");
    if (query.includes("comments")) return empty("comments");
    const reply = replies.get(`${value("owner")}/${value("name")}#${value("number")}`)?.shift();
    if (!reply) throw new Error(`unexpected gh args: ${args.join(" ")}`);
    return reply;
  });

  await service.reconcileParents(12, "/work");

  // The epic is read, commented and closed where it lives, not by its number in the work repository.
  expect(calls.find((args) => args[0] === "issue" && args[1] === "comment")).toEqual(["issue", "comment", "40", "-R", "owner/plans", "--body", "lazy-workflow: verified direct sub-issues for parent #40: owner/work#12, owner/work#13"]);
  expect(calls.find((args) => args[0] === "issue" && args[1] === "close")).toEqual(["issue", "close", "40", "-R", "owner/plans"]);
});
