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
const hu = args.indexOf("--hu") > -1 ? args[args.indexOf("--hu") + 1] : null;
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

// get response
console.log(output);
console.log(args);
