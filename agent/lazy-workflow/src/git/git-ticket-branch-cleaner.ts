export type GitRunner = (args: string[], workingDirectory: string) => Promise<string>;

export const runGit: GitRunner = async (args, workingDirectory) => {
  const child = Bun.spawn(["git", ...args], {
    cwd: workingDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} falló: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
};

function branchName(ref: string): string {
  const prefix = "refs/heads/";
  const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  if (
    !name
    || !/^[A-Za-z0-9._/-]+$/.test(name)
    || name.includes("..")
    || name.includes("//")
    || name.startsWith("/")
    || name.endsWith("/")
  ) {
    throw new Error(`Rama no válida: ${ref}`);
  }
  return name;
}

export async function pushGitBranch(
  git: GitRunner,
  branchRef: string,
  workingDirectory: string,
): Promise<void> {
  const branch = branchName(branchRef);
  const current = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
  if (current !== branch) throw new Error(`La rama activa ${current || "detached"} no coincide con ${branch}`);
  const head = (await git(["rev-parse", "HEAD^{commit}"], workingDirectory)).trim();
  await git(["push", "origin", `HEAD:${branchRef}`], workingDirectory);
  const remote = (await git(["ls-remote", "--heads", "origin", branchRef], workingDirectory))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.split(/\s+/)[0];
  if (remote !== head) throw new Error(`La rama remota ${branchRef} no coincide con el commit local`);
}

export async function checkoutGitBranch(
  git: GitRunner,
  branchRef: string,
  workingDirectory: string,
): Promise<void> {
  const branch = branchName(branchRef);
  const status = await git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
  if (status.trim()) throw new Error("El repositorio tiene cambios sin guardar; no se cambiará a la rama del ticket");
  const current = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
  await git(["fetch", "origin", `+${branchRef}:refs/remotes/origin/${branch}`], workingDirectory);
  const local = await git(["branch", "--list", branch], workingDirectory);
  if (current === branch && !local.trim()) throw new Error(`La rama activa ${branchRef} no tiene una referencia local verificable`);
  if (local.trim()) {
    const localSha = (await git(["rev-parse", `refs/heads/${branch}^{commit}`], workingDirectory)).trim();
    const remoteSha = (await git(["rev-parse", `refs/remotes/origin/${branch}^{commit}`], workingDirectory)).trim();
    // Las dos ramas quedan desalineadas por razones opuestas y ninguna pierde
    // trabajo. Adelantada: el agente commiteó y el push todavía no ocurrió, que
    // es justo lo que el paso siguiente va a subir. Atrasada: el merge aterrizó
    // y el remoto de la rama del ticket avanzó más allá del commit local, que
    // ya está contenido ahí. Solo la divergencia real -- cada lado con commits
    // que el otro no tiene, y por eso el merge-base no coincide con ninguno --
    // puede perder algo al cambiar de rama, y esa se sigue rechazando.
    const mergeBase = localSha === remoteSha
      ? localSha
      : (await git(["merge-base", localSha, remoteSha], workingDirectory)).trim();
    if (mergeBase !== remoteSha && mergeBase !== localSha) {
      throw new Error(`La rama local ${branchRef} no coincide con su rama remota`);
    }
    await git(["switch", branch], workingDirectory);
    // Atrasada: alcanzar al remoto es un avance rápido, nunca un merge que
    // fabrique historia que nadie revisó.
    if (mergeBase === localSha && localSha !== remoteSha) {
      await git(["merge", "--ff-only", `refs/remotes/origin/${branch}`], workingDirectory);
    }
  } else {
    await git(["switch", "--create", branch, "--track", `refs/remotes/origin/${branch}`], workingDirectory);
  }
  const active = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
  if (active !== branch) throw new Error(`No se pudo activar la rama ${branchRef}`);
}

export class GitTicketBranchCleaner {
  constructor(private readonly git: GitRunner = runGit) {}

  async deleteTicketBranch(
    ticketBranchRef: string,
    integrationBranchRef: string,
    workingDirectory: string,
    expectedRemoteCommit?: string,
  ): Promise<void> {
    const ticketBranch = branchName(ticketBranchRef);
    const integrationBranch = branchName(integrationBranchRef);
    if (ticketBranch === integrationBranch) {
      throw new Error("La rama del ticket no puede ser la rama de integración");
    }

    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
    if (status.trim()) {
      throw new Error("El repositorio tiene cambios sin guardar; no se eliminará la rama del ticket");
    }

    await this.git([
      "fetch",
      "origin",
      `+${integrationBranchRef}:refs/remotes/origin/${integrationBranch}`,
    ], workingDirectory);
    const integrationLocalBranch = await this.git(["branch", "--list", integrationBranch], workingDirectory);
    if (integrationLocalBranch.trim()) {
      await this.git(["switch", integrationBranch], workingDirectory);
    } else {
      await this.git(["switch", "--create", integrationBranch, "--track", `refs/remotes/origin/${integrationBranch}`], workingDirectory);
    }
    await this.git(["merge", "--ff-only", `origin/${integrationBranch}`], workingDirectory);

    const localBranch = await this.git(["branch", "--list", ticketBranch], workingDirectory);
    if (localBranch.trim()) {
      await this.git(["branch", "-D", ticketBranch], workingDirectory);
    }

    const remoteBranch = await this.git(["ls-remote", "--heads", "origin", ticketBranchRef], workingDirectory);
    if (remoteBranch.trim()) {
      const remoteCommit = remoteBranch.trim().split(/\s+/)[0];
      if (expectedRemoteCommit && remoteCommit !== expectedRemoteCommit) {
        throw new Error(`La rama remota ${ticketBranchRef} cambió antes de eliminarse`);
      }
      await this.git([
        "push",
        "origin",
        ...(expectedRemoteCommit ? [`--force-with-lease=refs/heads/${ticketBranch}:${expectedRemoteCommit}`] : []),
        "--delete",
        ticketBranch,
      ], workingDirectory);
    }
  }
}
