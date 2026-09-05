/**
 * Azure plan publication: the deterministic half of the Azure planning run.
 *
 * The planning session decides how to slice a User Story — that is judgment —
 * and returns the slices behind the `PLAN_READY` marker. Creating the work
 * items, wiring the parent links, and recording the blocking relations is
 * mechanical, so the coordinator does it with the same typed, idempotent,
 * verified primitives the delivery commands use.
 */

import { publicationOrder, type PlannedTicket } from "../prompts/plan-contract.ts";

export interface PublishedTicket {
  title: string;
  ticket: number;
  type: string;
  created: boolean;
}

export interface PlanPublication {
  hu: number;
  tickets: PublishedTicket[];
  blockingLinks: Array<{ blocker: number; blocked: number; linked: boolean }>;
}

/** The Azure primitives publication needs; the same ones the ticket-* commands expose. */
export interface PlanPublicationBoundary {
  createTicket(input: {
    hu: number;
    type: string;
    title: string;
    descriptionFile: string;
    estimate?: number;
  }): Promise<{ hu: number; ticket: number; type: string; title: string; created: boolean }>;
  linkPredecessor(blocker: number, blocked: number): Promise<{ blocker: number; blocked: number; linked: boolean }>;
}

/**
 * Publish an approved plan: every work item first, then the blocking relations,
 * so each relation can name real ids. Both steps are idempotent, so republishing
 * the same plan reuses what already exists instead of duplicating it.
 */
export class AzurePlanPublicationService {
  constructor(
    private readonly boundary: PlanPublicationBoundary,
    private readonly writeDescription: (body: string) => Promise<string>,
  ) {}

  async publish(hu: number, tickets: PlannedTicket[]): Promise<PlanPublication> {
    const ordered = publicationOrder(tickets);
    const published = new Map<string, PublishedTicket>();

    for (const ticket of ordered) {
      const descriptionFile = await this.writeDescription(ticket.body);
      const created = await this.boundary.createTicket({
        hu,
        type: ticket.type,
        title: ticket.title,
        descriptionFile,
        ...(ticket.estimate !== undefined ? { estimate: ticket.estimate } : {}),
      });
      published.set(ticket.title.trim(), {
        title: ticket.title,
        ticket: created.ticket,
        type: created.type,
        created: created.created,
      });
    }

    const blockingLinks: PlanPublication["blockingLinks"] = [];
    for (const ticket of ordered) {
      const blocked = published.get(ticket.title.trim())!;
      for (const blockerTitle of ticket.blockedBy) {
        const blocker = published.get(blockerTitle.trim())!;
        blockingLinks.push(await this.boundary.linkPredecessor(blocker.ticket, blocked.ticket));
      }
    }

    return { hu, tickets: [...published.values()], blockingLinks };
  }
}
