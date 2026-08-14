import type { GitHubManagedQueueAdapter, ManagedQueueOutcome, SelectedManagedIssue } from "../../src/github/managed-queue-service.ts";

export function fakeSelectedIssue(number: number, title = `feat(lazy-workflow): issue #${number}`): SelectedManagedIssue {
  return {
    number,
    title,
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    assignees: [{ login: "elvis" }],
    createdAt: "2024-01-01T00:00:00Z",
    blockedBy: { nodes: [] },
    body: `body of #${number}`,
    comments: [],
  };
}

export function fakeSelectedOutcome(number: number, nameWithOwner = "owner/repo"): ManagedQueueOutcome {
  return { kind: "selected", issue: fakeSelectedIssue(number), repository: { nameWithOwner } };
}

export function queueAdapter(outcomes: ManagedQueueOutcome[]): GitHubManagedQueueAdapter {
  return { selectAndClaimEligibleIssue: async () => outcomes.shift() ?? { kind: "empty" } };
}