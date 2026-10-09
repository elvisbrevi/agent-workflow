import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Credential-bearing installation files never belong to a source checkout. */
export async function outsideCheckout(path: string) {
  let directory = await realpath(path);
  for (;;) {
    const git = join(directory, ".git");
    try {
      const entry = await stat(git);
      if (entry.isFile()) throw new Error("web credentials and state must live outside every Git checkout");
      if ((await stat(join(git, "HEAD"))).isFile()) throw new Error("web credentials and state must live outside every Git checkout");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
}
