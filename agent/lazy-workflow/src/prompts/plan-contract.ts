/**
 * El plan que una sesión devuelve detrás de `PLAN_READY`: su forma, su lectura
 * y el orden en que se publica.
 *
 * La sesión decide las rebanadas — eso es criterio — y el coordinador las
 * publica en el tracker que corresponda (ADR-0022, ADR-0040). El contrato es
 * uno solo porque la decisión es la misma en los dos trackers; lo que cambia es
 * la primitiva que lo publica, y eso vive en el adaptador de cada uno.
 */

import { PLAN_READY_MARKER } from "./workflow-contract.ts";

/**
 * Lo que la sesion aporta por rebanada: titulo, descripcion y esfuerzo. Todo lo
 * demas de un item publicado es derivable, y por eso no es suyo (ADR-0040).
 *
 * El contrato es uno solo en los dos trackers aunque GitHub no tenga donde
 * poner `type` ni `estimate`: una sesion no elige su forma segun donde va a
 * publicarse el plan, y Azure si los necesita.
 */
export interface PlannedTicket {
  type: "Task" | "Bug";
  title: string;
  body: string;
  blockedBy: string[];
  estimate?: number;
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
