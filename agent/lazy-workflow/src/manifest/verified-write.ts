/**
 * Write a manifest only if reading it back the way the coordinator does works.
 *
 * Both delivery manifests are written by a tool and read by the coordinator, and
 * the two must never disagree. Writing then re-reading through the coordinator's
 * own gate is what makes that structural rather than a promise — and a manifest
 * that fails the gate must not survive the attempt, because a half-valid file on
 * disk is worse than none: the delivery would read the broken one instead of
 * stopping at "there is no manifest yet". Whatever was already there is restored.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeVerifiedManifest<T>(
  manifestPath: string,
  manifest: unknown,
  verify: (path: string) => Promise<T>,
): Promise<T> {
  const file = Bun.file(manifestPath);
  const previous = await file.exists() ? await file.text() : null;
  await mkdir(dirname(manifestPath), { recursive: true });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    return await verify(manifestPath);
  } catch (error) {
    if (previous === null) await Bun.file(manifestPath).delete();
    else await Bun.write(manifestPath, previous);
    throw error;
  }
}
