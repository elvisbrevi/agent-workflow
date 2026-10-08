/**
 * Bundles the window into `dist/`, which `tauri build` embeds. Bun's HTML
 * entrypoint bundles the TSX and CSS it references; no other bundler is used.
 */
import { rm } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
await rm(`${root}dist`, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${root}index.html`],
  outdir: `${root}dist`,
  minify: true,
  target: "browser",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

for (const log of result.logs) console.error(log);
if (!result.success) process.exit(1);
console.log(`dist: ${result.outputs.map((output) => output.path.replace(`${root}dist/`, "")).join(", ")}`);
