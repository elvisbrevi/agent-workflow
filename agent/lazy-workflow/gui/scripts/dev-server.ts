/**
 * The dev server `tauri dev` points the window at (`devUrl` in tauri.conf.json),
 * with Bun's hot module reloading.
 */
import index from "../index.html";

const server = Bun.serve({
  port: 1420,
  hostname: "localhost",
  routes: { "/*": index },
  development: { hmr: true, console: true },
});

console.log(`lz GUI dev server en ${server.url}`);
