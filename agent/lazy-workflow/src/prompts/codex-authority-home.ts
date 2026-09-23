/**
 * Codex authority home assembly (ADR-0021, ADR-0033): `codex exec` takes no flag
 * for a rules path, so execpolicy `.rules` files are discovered only under the
 * resolved Codex home. Each run therefore gets a lazy-workflow-owned home
 * carrying its profile's rules, with the operator's `auth.json` and `skills/`
 * linked in — the login is how OpenCode and Claude Code already run, and Codex
 * loads skills from the home. The operator's `config.toml` is deliberately not
 * linked: the model and the effort are stated on the invocation, and nothing
 * else in the operator's home may vary the run.
 *
 * The five profiles exist a third time here, as `codex/<profile>.rules`, hand
 * written and generated from neither `opencode/authority.json` nor
 * `claudecode/*.json` (see authority-profile.ts): a rule lost in translation is
 * a rule that stops enforcing.
 */

import { link, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { AuthorityProfile } from "./authority-profile.ts";

/** Absolute path to the hand-written Codex execpolicy rules for a profile. */
export function codexRulesPath(profile: AuthorityProfile): string {
  return Bun.fileURLToPath(new URL(`../../codex/${profile}.rules`, import.meta.url));
}

/** The operator's own Codex home, exactly as `codex` itself resolves `CODEX_HOME`. */
export function resolveOperatorCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/**
 * Stable, repository-scoped state for a Codex session. The path must survive a
 * later `--session` invocation, while different repositories must not share
 * transcripts or race while their authority homes are assembled.
 */
export function codexAuthorityHomePath(profile: AuthorityProfile, workingDirectory: string): string {
  const repositoryKey = createHash("sha256").update(resolve(workingDirectory)).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "lazy-workflow", "codex", repositoryKey, profile);
}

/**
 * Assembles a Codex authority home for `profile` at `destination`: a `rules/`
 * directory holding only that profile's rules, `auth.json` and `skills/`
 * symlinked from `operatorHome`, and no `config.toml`. Returns `destination`,
 * meant to be exported as `CODEX_HOME` for the run.
 */
export async function assembleCodexAuthorityHome(
  profile: AuthorityProfile,
  operatorHome: string,
  destination: string,
): Promise<string> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, "rules"), { recursive: true });
  const rules = await Bun.file(codexRulesPath(profile)).text();
  await Bun.write(join(destination, "rules", `${profile}.rules`), rules);
  if (process.platform === "win32") {
    await link(join(operatorHome, "auth.json"), join(destination, "auth.json"));
    await symlink(join(operatorHome, "skills"), join(destination, "skills"), "junction");
  } else {
    await symlink(join(operatorHome, "auth.json"), join(destination, "auth.json"));
    await symlink(join(operatorHome, "skills"), join(destination, "skills"));
  }
  return destination;
}
