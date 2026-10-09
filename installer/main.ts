import { install } from "./install.ts";

if (import.meta.main) {
  try {
    await install(process.argv.slice(2));
  } catch (error) {
    console.error(`agent-workflow: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
