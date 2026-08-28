import { expect, test } from "bun:test";
import { AzureAutocodeService } from "../src/azure/autocode-service.ts";

const HU = 23796;

/** La HU tal como Azure la devuelve: las identidades son objetos, no textos. */
const huItem = {
  id: HU,
  fields: {
    "System.Title": "Corregir el identificador",
    "System.TeamProject": "Cobro Pago y Tarifas",
    "System.IterationPath": "Cobro Pago y Tarifas\\Sprint 84 - Odisea",
    "System.AssignedTo": { uniqueName: "victoria@example.test", displayName: "Victoria" },
    "Custom.Desarrollador1": { uniqueName: "elvis.brevi@example.test", displayName: "Elvis" },
  },
};

const service = () => new AzureAutocodeService(async () => JSON.stringify(huItem));

test("hu-info entrega la iteración de la HU", async () => {
  expect((await service().getHuInfo(HU)).iteration).toBe("Cobro Pago y Tarifas\\Sprint 84 - Odisea");
});

test("hu-info entrega el desarrollador 1 aunque Azure lo devuelva como identidad", async () => {
  const info = await service().getHuInfo(HU);

  expect(info.desarrollador).toEqual({ uniqueName: "elvis.brevi@example.test", displayName: "Elvis" });
});
