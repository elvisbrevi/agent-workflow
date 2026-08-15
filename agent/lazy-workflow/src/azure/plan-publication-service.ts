/**
 * Azure plan publication: the deterministic half of the Azure planning run.
 *
 * OpenCode decides how to slice a User Story — that is judgment — and returns the
 * slices behind the `PLAN_READY` marker. Creating the work items, wiring the
 * parent links, and recording the blocking relations is mechanical, so the
 * coordinator does it with the same typed, idempotent, verified primitives the
 * delivery commands use.
 */

import { PLAN_READY_MARKER } from "../prompts/workflow-contract.ts";

export interface PlannedTicket {
  type: "Task" | "Bug";
  title: string;
  body: string;
  blockedBy: string[];
  estimate?: number;
}

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

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

function isPlannedTicket(value: unknown): value is PlannedTicket {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.type === "Task" || candidate.type === "Bug")
    && typeof candidate.title === "string" && candidate.title.trim().length > 0
    && typeof candidate.body === "string" && candidate.body.trim().length > 0
    && Array.isArray(candidate.blockedBy)
    && candidate.blockedBy.every((entry) => typeof entry === "string")
    && (candidate.estimate === undefined || (typeof candidate.estimate === "number" && candidate.estimate >= 0));
}

/**
 * Read the plan that follows the `PLAN_READY` marker. Anything malformed fails
 * closed rather than publishing a partially understood plan.
 */
export function parsePlan(text: string): PlannedTicket[] {
  const marker = text.lastIndexOf(PLAN_READY_MARKER);
  if (marker < 0) throw new PlanParseError(`La sesión no emitió ${PLAN_READY_MARKER}`);
  const tail = text.slice(marker + PLAN_READY_MARKER.length);
  const start = tail.indexOf("{");
  if (start < 0) throw new PlanParseError(`${PLAN_READY_MARKER} no va seguido de un objeto JSON`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(tail.slice(start).replace(/```[\s\S]*$/, "").trim());
  } catch (error) {
    throw new PlanParseError(`El plan tras ${PLAN_READY_MARKER} no es JSON válido: ${error instanceof Error ? error.message : String(error)}`);
  }

  const tickets = (parsed as { tickets?: unknown })?.tickets;
  if (!Array.isArray(tickets)) throw new PlanParseError("El plan no contiene un arreglo \"tickets\"");
  const invalid = tickets.findIndex((ticket) => !isPlannedTicket(ticket));
  if (invalid >= 0) throw new PlanParseError(`El ticket ${invalid + 1} del plan no tiene la forma esperada`);

  const planned = tickets as PlannedTicket[];
  const titles = planned.map(({ title }) => title.trim());
  const duplicate = titles.find((title, index) => titles.indexOf(title) !== index);
  if (duplicate) throw new PlanParseError(`El plan repite el título "${duplicate}"`);
  for (const ticket of planned) {
    for (const blocker of ticket.blockedBy) {
      if (!titles.includes(blocker.trim())) {
        throw new PlanParseError(`El ticket "${ticket.title}" declara el bloqueante desconocido "${blocker}"`);
      }
    }
    if (ticket.blockedBy.some((blocker) => blocker.trim() === ticket.title.trim())) {
      throw new PlanParseError(`El ticket "${ticket.title}" se declara bloqueante de sí mismo`);
    }
  }
  return planned;
}

/**
 * Order tickets so every blocker is published before what it unlocks, which is
 * what lets the blocking relations reference real ids in a second pass. A cycle
 * has no such order and fails closed.
 */
export function publicationOrder(tickets: PlannedTicket[]): PlannedTicket[] {
  const remaining = new Map(tickets.map((ticket) => [ticket.title.trim(), ticket]));
  const ordered: PlannedTicket[] = [];
  const published = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((ticket) =>
      ticket.blockedBy.every((blocker) => published.has(blocker.trim())),
    );
    if (ready.length === 0) {
      throw new PlanParseError(`El plan tiene un ciclo de bloqueo entre: ${[...remaining.keys()].join(", ")}`);
    }
    for (const ticket of ready) {
      ordered.push(ticket);
      published.add(ticket.title.trim());
      remaining.delete(ticket.title.trim());
    }
  }
  return ordered;
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
