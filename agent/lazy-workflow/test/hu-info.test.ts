import { expect, test } from "bun:test";
import { AzureAutocodeService } from "../src/azure/autocode-service.ts";

const HU = 23796;

/** La HU tal como Azure la devuelve: las identidades son objetos, no textos. */
const huItem = {
  id: HU,
  fields: {
    "System.WorkItemType": "Bug",
    "System.Title": "Corregir el identificador",
    "System.TeamProject": "Cobro Pago y Tarifas",
    "System.IterationPath": "Cobro Pago y Tarifas\\Sprint 84 - Odisea",
    "System.AssignedTo": { uniqueName: "victoria@example.test", displayName: "Victoria" },
    "Custom.Desarrollador1": { uniqueName: "elvis.brevi@example.test", displayName: "Elvis" },
  },
  relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/o/_apis/wit/workItems/23001" }],
};

const service = () => new AzureAutocodeService(async () => JSON.stringify(huItem));

test("hu-info entrega la iteración de la HU", async () => {
  expect((await service().getHuInfo(HU)).iteration).toBe("Cobro Pago y Tarifas\\Sprint 84 - Odisea");
});

test("hu-info entrega el desarrollador 1 aunque Azure lo devuelva como identidad", async () => {
  const info = await service().getHuInfo(HU);

  expect(info.desarrollador).toEqual({ uniqueName: "elvis.brevi@example.test", displayName: "Elvis" });
});

test("hu-info entrega el tipo y el padre directo, que deciden si un Bug se planifica solo", async () => {
  const commands: string[][] = [];
  const info = await new AzureAutocodeService(async (args) => { commands.push(args); return JSON.stringify(huItem); }).getHuInfo(HU);

  expect({ type: info.type, parent: info.parent }).toEqual({ type: "Bug", parent: 23001 });
  expect(commands[0]).toContain("relations");
});

test("hu-info entrega la discusión completa de la HU, en orden y por páginas, y los pasos de un Bug", async () => {
  const commands: string[][] = [];
  const bug = { ...huItem, fields: { ...huItem.fields, "Microsoft.VSTS.TCM.ReproSteps": "<p>Dice Excenta</p>" } };
  const pages = [
    { comments: [{ text: "<p>Corrige también el texto del pie</p>", createdDate: "2026-10-10T12:00:00Z", createdBy: { displayName: "Victoria" } }, { text: " " }], continuationToken: "siguiente" },
    { comments: [{ text: "Gracias", createdDate: "2026-10-11T09:00:00Z", createdBy: { displayName: "Elvis" } }], continuationToken: null },
  ];
  const info = await new AzureAutocodeService(async (args) => {
    commands.push(args);
    return JSON.stringify(args.includes("rest") ? pages.shift() : bug);
  }).getHuInfo(HU);

  expect(info.reproSteps).toBe("<p>Dice Excenta</p>");
  expect(info.comments).toEqual([
    { author: "Victoria", date: "2026-10-10T12:00:00Z", text: "<p>Corrige también el texto del pie</p>" },
    { author: "Elvis", date: "2026-10-11T09:00:00Z", text: "Gracias" },
  ]);
  const uris = commands.filter((args) => args.includes("rest")).map((args) => args[args.indexOf("--uri") + 1]!);
  expect(uris[0]).toContain(`/Cobro%20Pago%20y%20Tarifas/_apis/wit/workItems/${HU}/comments?order=asc`);
  expect(uris[1]).toContain("continuationToken=siguiente");
});
