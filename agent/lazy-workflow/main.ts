import { LazyWorkflowCli } from "./src/cli/lazy-workflow-cli.ts";

process.exitCode = await new LazyWorkflowCli().run(Bun.argv.slice(2));
