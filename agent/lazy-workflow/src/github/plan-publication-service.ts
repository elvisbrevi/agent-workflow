/**
 * GitHub plan publication: the deterministic half of a GitHub planning run.
 *
 * The session decides the slices and returns them behind `PLAN_READY`; creating
 * the issues and wiring the blocking edges is mechanical, and it belongs to the
 * coordinator (ADR-0040). Publishing here is what removed the numbering
 * watermark: an issue is the plan's because this code created it, not because
 * its number happened to land above a mark somebody else could cross.
 */

import { publicationOrder, type PlannedTicket } from "../prompts/plan-contract.ts";

export interface PublishedIssue {
  title: string;
  issue: number;
}

export interface GitHubPlanPublication {
  issues: PublishedIssue[];
  blockingLinks: Array<{ blocker: number; blocked: number; linked: boolean }>;
}

/** The GitHub primitives publication needs; both live on the managed-queue adapter. */
export interface GitHubPlanPublicationBoundary {
  /** Creates the issue already carrying its triage role, and answers its number and its id. */
  createReadyIssue(
    input: { title: string; body: string },
    workingDirectory: string,
  ): Promise<{ number: number; id: number }>;
  /** Records `blocked` as blocked by the issue whose id is `blockerId`. */
  linkBlockedBy(blocked: number, blockerId: number, workingDirectory: string): Promise<{ linked: boolean }>;
}

/**
 * Publish an approved plan: every issue first, in dependency order, then the
 * blocking edges, so each edge can name real issues. GitHub's dependency
 * relation addresses the blocker by id, which is why creation answers both.
 */
export async function publishPlanIssues(
  boundary: GitHubPlanPublicationBoundary,
  tickets: PlannedTicket[],
  workingDirectory: string,
): Promise<GitHubPlanPublication> {
  const ordered = publicationOrder(tickets);
  const published = new Map<string, { issue: number; id: number }>();

  for (const ticket of ordered) {
    const created = await boundary.createReadyIssue(
      { title: ticket.title, body: ticket.body },
      workingDirectory,
    );
    published.set(ticket.title.trim(), { issue: created.number, id: created.id });
  }

  const blockingLinks: GitHubPlanPublication["blockingLinks"] = [];
  for (const ticket of ordered) {
    const blocked = published.get(ticket.title.trim())!;
    for (const blockerTitle of ticket.blockedBy) {
      const blocker = published.get(blockerTitle.trim())!;
      const { linked } = await boundary.linkBlockedBy(blocked.issue, blocker.id, workingDirectory);
      blockingLinks.push({ blocker: blocker.issue, blocked: blocked.issue, linked });
    }
  }

  return {
    issues: ordered.map((ticket) => ({ title: ticket.title, issue: published.get(ticket.title.trim())!.issue })),
    blockingLinks,
  };
}
