import { $ } from "bun";
import { HuInfo, type HuInfoData } from "./hu-info.ts";

const AZURE_ORGANIZATION = "https://dev.azure.com/SubdepartamentoSolucionesTI";
const HU_QUERY = `{
  id: id,
  title: fields."System.Title",
  description: fields."System.Description",
  criterioDeAceptacion: fields."Microsoft.VSTS.Common.AcceptanceCriteria",
  state: fields."System.State",
  project: fields."System.TeamProject",
  assignedTo: fields."System.AssignedTo",
  desarrollador: fields."Custom.Desarrollador1"
}`;

export class HuInfoService {
  async getHuInfo(hu: number): Promise<HuInfo> {
    if (!Number.isInteger(hu) || hu <= 0) {
      throw new Error(`La HU debe ser un entero positivo: ${hu}`);
    }

    const output = await $`
      az boards work-item show \
      --id ${hu} \
      --organization ${AZURE_ORGANIZATION} \
      --query ${HU_QUERY} \
      --output json
    `.text();

    return new HuInfo(JSON.parse(output) as HuInfoData);
  }

  async waitForAccess(hu: number): Promise<void> {
    console.error("OpenCode requiere autenticacion Azure.");
    console.error("Ejecuta en otra terminal: az login --use-device-code");

    while (true) {
      try {
        await this.getHuInfo(hu);
        console.error("Login Azure detectado. Continuando la sesion OpenCode una vez.");
        return;
      } catch {
        await Bun.sleep(2_000);
      }
    }
  }
}
