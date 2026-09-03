import type { GitRunner } from "./git-ticket-branch-cleaner.ts";

/**
 * Lo que el coordinador le pregunta a git cuando el proceso de una sesión sale (ADR-0035).
 *
 * La rama activa es la fijada, el árbol no tiene cambios sin commitear, y la rama lleva al menos un
 * commit sobre su base. Un agente que preguntó, que se negó o que exploró sin commitear deja una
 * rama vacía; uno que commiteó parte de su trabajo deja el árbol sucio. Ninguna de las dos es una
 * entrega, y ninguna se distingue mirando el código de salida.
 *
 * Vive acá y no en un adaptador porque los dos proveedores hacen la misma pregunta: lo que cambia
 * entre GitHub y Azure es qué se hace con la respuesta, no cómo se obtiene.
 */
export class SessionNotVerifiedError extends Error {
  constructor(reason: string) {
    super(`La sesión no quedó verificada: ${reason}`);
    this.name = "SessionNotVerifiedError";
  }
}

const shortName = (ref: string): string => ref.replace(/^refs\/heads\//, "");

export async function verifySessionWithGit(
  git: GitRunner,
  branch: string,
  baseBranch: string,
  workingDirectory: string,
): Promise<{ commit: string }> {
  const active = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
  if (active !== shortName(branch)) {
    throw new SessionNotVerifiedError(`la rama activa ${active || "detached"} no coincide con ${branch}`);
  }
  if ((await git(["status", "--porcelain", "--untracked-files=no"], workingDirectory)).trim()) {
    throw new SessionNotVerifiedError("la sesión dejó cambios sin commitear");
  }
  const ahead = Number((await git(["rev-list", "--count", `${baseBranch}..${branch}`], workingDirectory)).trim());
  if (!Number.isInteger(ahead) || ahead <= 0) {
    throw new SessionNotVerifiedError(`la rama ${branch} no tiene commits sobre ${baseBranch}`);
  }
  const commit = (await git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new SessionNotVerifiedError(`git no devolvió un commit verificable: ${commit}`);
  return { commit };
}
