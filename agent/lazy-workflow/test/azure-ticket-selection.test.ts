import { expect, test } from "bun:test";
import { AzureAutocodeService } from "../src/azure/autocode-service.ts";

/**
 * Qué task de la HU se elige, y sobre todo cuál no.
 *
 * El proceso Scrum SAG nombra sus estados en español —`En espera`, `En progreso`,
 * `En revisión`, `Done`, `Removido`— y el filtro de completados solo conocía los
 * ingleses. Una task que el equipo removió seguía siendo elegible, así que el
 * drenaje la tomaba y le abría una entrega.
 */
const workItem = (id: number, fields: Record<string, unknown>, relations: unknown[] = []) =>
  JSON.stringify({ id, fields, relations });

function serviceFor(children: Array<{ id: number; state: string }>) {
  const hu = 23438;
  return new AzureAutocodeService(async (args) => {
    const id = Number(args[args.indexOf("--id") + 1]);
    if (id === hu) {
      return workItem(hu, {
        "System.Title": "HU",
        "System.TeamProject": "Procesos Digitales",
      }, [
        ...children.map(({ id: child }) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `https://azure.test/_apis/wit/workItems/${child}` })),
        { rel: "ArtifactLink", attributes: { name: "Branch" }, url: "vstfs:///Git/Ref/proj%2Frepo%2FGBhu%2F23438" },
      ]);
    }
    const child = children.find((candidate) => candidate.id === id)!;
    return workItem(id, {
      "System.WorkItemType": "Task",
      "System.State": child.state,
      "System.Title": `Task ${id}`,
      "System.CreatedDate": `2026-01-0${id % 9}`,
    });
  }, async () => "");
}

test("una task Removido no es elegible: el equipo ya la sacó del alcance", async () => {
  const state = await serviceFor([{ id: 1, state: "Removido" }, { id: 2, state: "En espera" }])
    .getAutocodeState(23438);

  expect(state.context?.ticket.id).toBe(2);
});

test("una HU cuyas tasks están todas removidas no tiene nada pendiente", async () => {
  const state = await serviceFor([{ id: 1, state: "Removido" }, { id: 2, state: "Removido" }])
    .getAutocodeState(23438);

  expect(state.context).toBeNull();
  expect(state.pending).toBeFalse();
});

test("una task En revisión sigue pendiente: resuelta no es terminada", async () => {
  const state = await serviceFor([{ id: 1, state: "En revisión" }]).getAutocodeState(23438);

  expect(state.context?.ticket.id).toBe(1);
});
