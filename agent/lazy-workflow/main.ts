import { format } from "node:util";
import { LazyWorkflowCli } from "./src/cli/lazy-workflow-cli.ts";

// Once a module has touched `process.stdout` — yargs and ora both do — Bun's
// `console.log` drops whatever exceeds 64 KiB when stdout is a pipe and the
// process exits, so a large JSON answer (`catalog`, a long `github-issue-list`)
// reached a GUI or `| jq` cut in half. `process.stdout.write` flushes it whole.
console.log = (...data: unknown[]): void => {
  process.stdout.write(`${format(...data)}\n`);
};

// A reader that stops early (`lz catalog | head -1`) closes the pipe: the rest
// of the answer has nowhere to go, which is what `console.log` silently did.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

process.exitCode = await new LazyWorkflowCli().run(Bun.argv.slice(2));
