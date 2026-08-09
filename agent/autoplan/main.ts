import { $ } from "bun";

// get arguments
const args = Bun.argv.slice(2);
const model = args.indexOf("--model") > -1 ? args[args.indexOf("--model") + 1] : "opencode-go/deepseek-v4-pro";
const variant = args.indexOf("--variant") > -1 ? args[args.indexOf("--variant") + 1] : "high";
const session = args.indexOf("--session") > -1 ? args[args.indexOf("--session") + 1] : null;
const sessionArgs = session
  ? ["--session", session]
  : [];
const prompt = args.indexOf("--prompt") > -1 ? args[args.indexOf("--prompt") + 1] : "cuanto es uno mas 3";
const hu: number = args.indexOf("--hu") > -1 ? Number.parseInt(args[args.indexOf("--hu") + 1]!) : 23438;
const auto = args.indexOf("--auto") > -1 ? args[args.indexOf("--auto") + 1]  : null;


// run command
const output = await $`
  opencode run \
  --auto \
  --model ${model} \
  --variant ${variant} \
  ${sessionArgs} \
  --format json \
  ${prompt}
  `.text();

async function getHuInfo(hu: number): Promise<any> {

  const query = `{
    id: id,
    title: fields."System.Title",
    description: fields."System.Description",
    criterioDeAceptacion: fields."Microsoft.VSTS.Common.AcceptanceCriteria",
    state: fields."System.State",
    project: fields."System.TeamProject",
    assignedTo: fields."System.AssignedTo",
    desarrollador: fields."Custom.Desarrollador1"
  }`;

  const output = await $`
    az boards work-item show \
    --id ${hu} \
    --organization https://dev.azure.com/SubdepartamentoSolucionesTI \
    --query ${query} \
    --output json
  `.text();

  const data = JSON.parse(output);

  const ordered = {
    id: data.id,
    title: data.title,
    description: data.description,
    criterioDeAceptacion: data.criterioDeAceptacion,
    state: data.state,
    project: data.project,
    assignedTo: data.assignedTo,
    desarrollador: data.desarrollador,
  };

  return ordered;
}



// get response
console.log(output);
console.log(args);

const ordered = getHuInfo(hu);
console.log(JSON.stringify(ordered, null, 2));
