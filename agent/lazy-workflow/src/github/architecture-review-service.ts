export interface GitHubIssueScope {
  number: number;
  title: string;
  body: string;
  comments: string[];
  state: string;
  labels: string[];
}

export interface ArchitectureReviewTicket {
  title: string;
  body: string;
}

export interface ArchitectureReviewPublication {
  specification: number;
  tickets: number[];
}

export interface ArchitectureReviewTracker {
  readIssue(issue: number, workingDirectory: string): Promise<GitHubIssueScope>;
  publishFindings(
    sourceIssue: number,
    specification: { title: string; body: string },
    tickets: ArchitectureReviewTicket[],
    workingDirectory: string,
  ): Promise<ArchitectureReviewPublication>;
}

type GhRunner = (args: string[], workingDirectory: string) => Promise<string>;

const runGh: GhRunner = async (args, workingDirectory) => {
  const child = Bun.spawn(["gh", ...args], { cwd: workingDirectory, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`gh ${args[0] ?? "command"} fallo (${stderr.trim() || `exit ${exitCode}`})`);
  return stdout;
};

function issueNumber(output: string): number {
  const match = output.match(/(?:issues|pull)\/(\d+)/);
  const number = Number(match?.[1]);
  if (!Number.isInteger(number) || number <= 0) throw new Error("gh no devolvio el Issue creado");
  return number;
}

function sanitizeTrackerText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+|bearer\s+|(?:token|password|secret|cookie|pat|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function parseScope(output: string, issue: number): GitHubIssueScope {
  const value = JSON.parse(output) as {
    number?: number;
    title?: string;
    body?: string;
    state?: string;
    labels?: Array<{ name?: string }>;
    comments?: Array<{ body?: string }>;
  };
  if (value.number !== issue || typeof value.title !== "string" || typeof value.body !== "string") {
    throw new Error(`gh devolvio un alcance inesperado para el Issue ${issue}`);
  }
  return {
    number: issue,
    title: sanitizeTrackerText(value.title),
    body: sanitizeTrackerText(value.body),
    comments: (value.comments ?? []).map(({ body }) => sanitizeTrackerText(body ?? "")),
    state: value.state ?? "",
    labels: (value.labels ?? []).map(({ name }) => name ?? ""),
  };
}

export class GitHubArchitectureReviewService implements ArchitectureReviewTracker {
  constructor(private readonly gh: GhRunner = runGh) {}

  async readIssue(issue: number, workingDirectory: string): Promise<GitHubIssueScope> {
    const output = await this.gh([
      "issue",
      "view",
      `${issue}`,
      "--comments",
      "--json",
      "number,title,body,state,labels,comments",
    ], workingDirectory);
    return parseScope(output, issue);
  }

  async publishFindings(
    sourceIssue: number,
    specification: { title: string; body: string },
    tickets: ArchitectureReviewTicket[],
    workingDirectory: string,
  ): Promise<ArchitectureReviewPublication> {
    const spec = await this.createIssue(
      `[Spec] ${sanitizeTrackerText(specification.title)}`,
      `${sanitizeTrackerText(specification.body)}\n\nSource Issue: #${sourceIssue}`,
      workingDirectory,
    );
    const publishedTickets: number[] = [];
    for (const ticket of tickets) {
      publishedTickets.push(await this.createIssue(
        sanitizeTrackerText(ticket.title),
        `${sanitizeTrackerText(ticket.body)}\n\nSource Issue: #${sourceIssue}\nSpecification: #${spec}`,
        workingDirectory,
      ));
    }
    for (const number of [spec, ...publishedTickets]) {
      const verified = await this.readIssue(number, workingDirectory);
      const relation = number === spec ? `Source Issue: #${sourceIssue}` : `Specification: #${spec}`;
      if (verified.number !== number || !verified.body.includes(relation)) {
        throw new Error(`no se pudo verificar el Issue publicado ${number}`);
      }
    }
    return { specification: spec, tickets: publishedTickets };
  }

  private async createIssue(title: string, body: string, workingDirectory: string): Promise<number> {
    return issueNumber(await this.gh([
      "issue",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--label",
      "ready-for-agent",
    ], workingDirectory));
  }
}
