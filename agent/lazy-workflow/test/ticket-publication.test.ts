import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { AzureTicketInfoService } from "../src/azure/ticket-info-service.ts";

const HU = 23438;
const ORG = "https://dev.azure.com/SubdepartamentoSolucionesTI";

interface Item {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
}

/** An in-memory Azure Boards that answers reads, patches, and creations. */
function azure(children: Item[] = []) {
  const items = new Map<number, Item>();
  items.set(HU, {
    id: HU,
    rev: 7,
    fields: { "System.WorkItemType": "User Story", "System.Title": "HU", "System.TeamProject": "Team" },
    relations: children.map((child) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `${ORG}/_apis/wit/workItems/${child.id}` })),
  });
  for (const child of children) items.set(child.id, child);
  const commands: string[][] = [];
  let nextId = 900;

  const run = async (args: string[]): Promise<string> => {
    commands.push(args);
    const uriIndex = args.indexOf("--uri");
    const uri = uriIndex >= 0 ? args[uriIndex + 1]! : "";

    if (args[0] === "boards" && args[1] === "work-item" && args[2] === "show") {
      const id = Number(args[args.indexOf("--id") + 1]);
      const item = items.get(id);
      if (!item) throw new Error(`work item ${id} inexistente`);
      return JSON.stringify(item);
    }

    if (args.includes("post")) {
      const type = decodeURIComponent(uri.match(/workitems\/\$([^?]+)/)?.[1] ?? "");
      const patch = JSON.parse(args[args.indexOf("--body") + 1]!) as Array<{ path: string; value: unknown }>;
      const id = nextId++;
      const created: Item = {
        id,
        rev: 1,
        fields: { "System.WorkItemType": type, "System.TeamProject": "Team" },
        relations: [],
      };
      for (const { path, value } of patch) {
        if (path.startsWith("/fields/")) created.fields[path.slice("/fields/".length)] = value;
        if (path === "/relations/-") {
          const relation = value as { rel: string; url: string };
          created.relations.push(relation);
          const parentId = Number(relation.url.split("/").pop());
          const parent = items.get(parentId);
          if (parent) parent.relations.push({ rel: "System.LinkTypes.Hierarchy-Forward", url: `${ORG}/_apis/wit/workItems/${id}` });
        }
      }
      items.set(id, created);
      return JSON.stringify({ id });
    }

    if (args.includes("patch")) {
      const id = Number(uri.match(/workitems\/(\d+)/)?.[1]);
      const item = items.get(id)!;
      const patch = JSON.parse(args[args.indexOf("--body") + 1]!) as Array<{ op: string; path: string; value: unknown }>;
      for (const { op, path, value } of patch) {
        if (op === "test" && path === "/rev" && value !== item.rev) throw new Error("rev conflict");
        if (path === "/relations/-") item.relations.push(value as { rel: string; url: string });
        if (path.startsWith("/fields/")) item.fields[path.slice("/fields/".length)] = value;
      }
      item.rev += 1;
      return JSON.stringify(item);
    }

    if (args[0] === "rest" && args.includes("get")) {
      const id = Number(uri.match(/workitems\/(\d+)/)?.[1]);
      return JSON.stringify(items.get(id));
    }
    throw new Error(`comando az no soportado: ${args.join(" ")}`);
  };

  return { run, items, commands };
}

const deliveryChild = (id: number, title: string, type = "Task"): Item => ({
  id,
  rev: 3,
  fields: { "System.WorkItemType": type, "System.Title": title, "System.State": "New", "System.TeamProject": "Team" },
  relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${ORG}/_apis/wit/workItems/${HU}` }],
});

async function descriptionFile(body: string): Promise<string> {
  const path = `/tmp/lazy-workflow-test-${body.length}-${Math.random().toString(36).slice(2)}.html`;
  await Bun.write(path, body);
  return path;
}

test("createTicket crea el Task como hijo directo de su HU", async () => {
  const boards = azure();
  const service = new AzureTicketInfoService(boards.run);
  const file = await descriptionFile("<p>hacer algo</p>");
  try {
    const result = await service.createTicket({ hu: HU, type: "Task", title: "Slice uno", descriptionFile: file });

    expect(result.created).toBeTrue();
    expect(result.type).toBe("Task");
    const created = boards.items.get(result.ticket)!;
    expect(created.fields["System.Title"]).toBe("Slice uno");
    expect(created.fields["System.Description"]).toBe("<p>hacer algo</p>");
    expect(created.relations.some(({ rel }) => rel === "System.LinkTypes.Hierarchy-Reverse")).toBeTrue();
  } finally {
    await unlink(file);
  }
});

test("createTicket reutiliza un hijo existente con el mismo tipo y titulo", async () => {
  const boards = azure([deliveryChild(51, "Slice uno")]);
  const service = new AzureTicketInfoService(boards.run);
  const file = await descriptionFile("<p>otra redacción</p>");
  try {
    const result = await service.createTicket({ hu: HU, type: "Task", title: "Slice uno", descriptionFile: file });

    expect(result).toEqual({ hu: HU, ticket: 51, type: "Task", title: "Slice uno", created: false });
    expect(boards.commands.some((args) => args.includes("post"))).toBeFalse();
  } finally {
    await unlink(file);
  }
});

test("createTicket falla cerrado ante hijos duplicados con el mismo titulo", async () => {
  const boards = azure([deliveryChild(51, "Slice uno"), deliveryChild(52, "Slice uno")]);
  const service = new AzureTicketInfoService(boards.run);
  const file = await descriptionFile("<p>x</p>");
  try {
    await expect(service.createTicket({ hu: HU, type: "Task", title: "Slice uno", descriptionFile: file }))
      .rejects.toThrow(/ya tiene 2 hijos Task/);
  } finally {
    await unlink(file);
  }
});

test("createTicket rechaza tipos que no son de entrega", async () => {
  const service = new AzureTicketInfoService(azure().run);
  const file = await descriptionFile("<p>x</p>");
  try {
    await expect(service.createTicket({ hu: HU, type: "Epic", title: "T", descriptionFile: file }))
      .rejects.toThrow(/no es un tipo de entrega/);
  } finally {
    await unlink(file);
  }
});

test("createTicket rechaza reference names invalidos en vez de adivinar el campo", async () => {
  const service = new AzureTicketInfoService(azure().run);
  const file = await descriptionFile("<p>x</p>");
  try {
    await expect(service.createTicket({
      hu: HU,
      type: "Task",
      title: "T",
      descriptionFile: file,
      fields: [{ referenceName: "Mes", value: "enero" }],
    })).rejects.toThrow(/no es un reference name/);
  } finally {
    await unlink(file);
  }
});

test("linkParent es idempotente y rechaza un padre distinto", async () => {
  const boards = azure([deliveryChild(51, "Slice uno")]);
  const service = new AzureTicketInfoService(boards.run);

  expect(await service.linkParent(HU, 51)).toEqual({ parent: HU, child: 51, linked: false });
  await expect(service.linkParent(999, 51)).rejects.toThrow(/ya tiene el padre/);
});

test("linkPredecessor registra el bloqueo una sola vez", async () => {
  const boards = azure([deliveryChild(51, "A"), deliveryChild(52, "B")]);
  const service = new AzureTicketInfoService(boards.run);

  expect(await service.linkPredecessor(51, 52)).toEqual({ blocker: 51, blocked: 52, linked: true });
  expect(boards.items.get(51)!.relations.some(
    ({ rel, url }) => rel === "System.LinkTypes.Dependency-Forward" && url.endsWith("/52"),
  )).toBeTrue();

  expect(await service.linkPredecessor(51, 52)).toEqual({ blocker: 51, blocked: 52, linked: false });
});

test("una relacion no puede apuntarse a si misma", async () => {
  const service = new AzureTicketInfoService(azure().run);
  await expect(service.linkParent(51, 51)).rejects.toThrow(/su propio padre/);
  await expect(service.linkPredecessor(51, 51)).rejects.toThrow(/bloquearse a sí mismo/);
});
