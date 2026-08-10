export type GitRunner = (args: string[], workingDirectory: string) => Promise<string>;

const runGit: GitRunner = async (args, workingDirectory) => {
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

export class GitTicketBranchCleaner {
  constructor(private readonly git: GitRunner = runGit) {}

  async deleteTicketBranch(
    ticketBranchRef: string,
    integrationBranchRef: string,
    workingDirectory: string,
  ): Promise<void> {
    const ticketBranch = branchName(ticketBranchRef);
    const integrationBranch = branchName(integrationBranchRef);
    if (ticketBranch === integrationBranch) {
      throw new Error("La rama del ticket no puede ser la rama de integración");
    }

    const status = await this.git(["status", "--porcelain"], workingDirectory);
    if (status.trim()) {
      throw new Error("El repositorio tiene cambios sin guardar; no se eliminará la rama del ticket");
    }

    await this.git([
      "fetch",
      "origin",
      `+${integrationBranchRef}:refs/remotes/origin/${integrationBranch}`,
    ], workingDirectory);
    await this.git(["switch", integrationBranch], workingDirectory);
    await this.git(["merge", "--ff-only", `origin/${integrationBranch}`], workingDirectory);

    const localBranch = await this.git(["branch", "--list", ticketBranch], workingDirectory);
    if (localBranch.trim()) {
      await this.git(["branch", "-D", ticketBranch], workingDirectory);
    }

    const remoteBranch = await this.git(["ls-remote", "--heads", "origin", ticketBranchRef], workingDirectory);
    if (remoteBranch.trim()) {
      await this.git(["push", "origin", "--delete", ticketBranch], workingDirectory);
    }
  }
}
