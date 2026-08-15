import { test, expect } from "bun:test";
import {
  AzurePlanPublicationService,
  PlanParseError,
  parsePlan,
  publicationOrder,
  type PlannedTicket,
} from "../src/azure/plan-publication-service.ts";

const ticket = (title: string, blockedBy: string[] = []): PlannedTicket => ({
  type: "Task",
  title,
  body: `body of ${title}`,
  blockedBy,
});

const plan = (tickets: unknown): string =>
  `narración previa\nPLAN_READY\n${JSON.stringify({ tickets })}`;

function boundary() {
  const created: Array<{ title: string; type: string; estimate?: number }> = [];
  const links: Array<{ blocker: number; blocked: number }> = [];
  const ids = new Map<string, number>();
  let next = 100;
  return {
    created,
    links,
    ids,
    createTicket: async (input: { hu: number; type: string; title: string; descriptionFile: string; estimate?: number }) => {
      const existing = ids.get(input.title);
      if (existing !== undefined) {
        return { hu: input.hu, ticket: existing, type: input.type, title: input.title, created: false };
      }
      const id = next++;
      ids.set(input.title, id);
      created.push({ title: input.title, type: input.type, estimate: input.estimate });
      return { hu: input.hu, ticket: id, type: input.type, title: input.title, created: true };
    },
    linkPredecessor: async (blocker: number, blocked: number) => {
      const already = links.some((link) => link.blocker === blocker && link.blocked === blocked);
      if (!already) links.push({ blocker, blocked });
      return { blocker, blocked, linked: !already };
    },
  };
}

const writeDescription = async (body: string): Promise<string> => `/tmp/${body.length}.html`;

test("parsePlan lee el JSON que sigue al marcador", () => {
  const tickets = parsePlan(plan([ticket("A"), ticket("B", ["A"])]));
  expect(tickets).toHaveLength(2);
  expect(tickets[1]?.blockedBy).toEqual(["A"]);
});

test("parsePlan acepta un plan vacio", () => {
  expect(parsePlan(plan([]))).toEqual([]);
});

test("parsePlan falla cerrado sin marcador, sin JSON o con JSON invalido", () => {
  expect(() => parsePlan("terminé el plan")).toThrow(PlanParseError);
  expect(() => parsePlan("PLAN_READY\nsin objeto")).toThrow(PlanParseError);
  expect(() => parsePlan("PLAN_READY\n{roto")).toThrow(PlanParseError);
  expect(() => parsePlan('PLAN_READY\n{"tickets":"no es arreglo"}')).toThrow(PlanParseError);
});

test("parsePlan rechaza tickets con forma incorrecta", () => {
  expect(() => parsePlan(plan([{ type: "Epic", title: "A", body: "b", blockedBy: [] }]))).toThrow(PlanParseError);
  expect(() => parsePlan(plan([{ type: "Task", title: "", body: "b", blockedBy: [] }]))).toThrow(PlanParseError);
  expect(() => parsePlan(plan([{ type: "Task", title: "A", body: "b" }]))).toThrow(PlanParseError);
});

test("parsePlan rechaza titulos repetidos y bloqueantes desconocidos", () => {
  expect(() => parsePlan(plan([ticket("A"), ticket("A")]))).toThrow(/repite el título/);
  expect(() => parsePlan(plan([ticket("A", ["Fantasma"])]))).toThrow(/bloqueante desconocido/);
  expect(() => parsePlan(plan([ticket("A", ["A"])]))).toThrow(/bloqueante de sí mismo/);
});

test("publicationOrder publica cada bloqueante antes de lo que desbloquea", () => {
  const ordered = publicationOrder([ticket("C", ["B"]), ticket("A"), ticket("B", ["A"])]);
  expect(ordered.map(({ title }) => title)).toEqual(["A", "B", "C"]);
});

test("publicationOrder falla cerrado ante un ciclo", () => {
  expect(() => publicationOrder([ticket("A", ["B"]), ticket("B", ["A"])])).toThrow(/ciclo de bloqueo/);
});

test("publish crea en orden de dependencia y luego enlaza los bloqueos", async () => {
  const azure = boundary();
  const service = new AzurePlanPublicationService(azure, writeDescription);

  const publication = await service.publish(23438, [ticket("B", ["A"]), ticket("A")]);

  expect(azure.created.map(({ title }) => title)).toEqual(["A", "B"]);
  expect(publication.tickets.map(({ title }) => title)).toEqual(["A", "B"]);
  expect(azure.links).toEqual([{ blocker: azure.ids.get("A")!, blocked: azure.ids.get("B")! }]);
  expect(publication.blockingLinks.every(({ linked }) => linked)).toBeTrue();
});

test("republicar el mismo plan reutiliza los work items en vez de duplicarlos", async () => {
  const azure = boundary();
  const service = new AzurePlanPublicationService(azure, writeDescription);
  const tickets = [ticket("A"), ticket("B", ["A"])];

  await service.publish(23438, tickets);
  const second = await service.publish(23438, tickets);

  expect(azure.created).toHaveLength(2);
  expect(second.tickets.every(({ created }) => !created)).toBeTrue();
  expect(azure.links).toHaveLength(1);
  expect(second.blockingLinks.every(({ linked }) => linked)).toBeFalse();
});

test("publish traslada la estimacion declarada", async () => {
  const azure = boundary();
  const service = new AzurePlanPublicationService(azure, writeDescription);

  await service.publish(23438, [{ ...ticket("A"), estimate: 8 }]);

  expect(azure.created[0]?.estimate).toBe(8);
});
