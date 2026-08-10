import { LazyWorkflowCli } from "./src/cli/lazy-workflow-cli.ts";

await new LazyWorkflowCli().run(Bun.argv.slice(2));
