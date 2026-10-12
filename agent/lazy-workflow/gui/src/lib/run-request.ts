/**
 * What the operator chose — a piece of work, Plan or Code, and a handful of
 * options — turned into the `lz` argument vector. The catalog stays the
 * authority on flags: values go through `buildArgs`, so a value equal to the
 * CLI's default is not sent and the line is the shortest one with that meaning.
 */
import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { buildArgs, validateFlags, type FlagIssue, type FlagValues } from "./command-line.ts";

/**
 * The piece of work a run is about. `repository` is where it was read; an HU
 * or an epic is planned from wherever the operator chooses (`RunOptions.repositories`).
 */
export type RunTarget =
  /** `bug`: a Bug no story owns, planned and delivered as an HU of its own (ADR-0047). */
  | { kind: "azure-hu"; repository: string; hu: number; title: string; ticket?: number; bug?: boolean }
  /** An epic: `plan --issue` slices it and publishes its sub-issues in this, its own repository. */
  | { kind: "github-epic"; repository: string; issue: number; title: string; url: string }
  | { kind: "github-issue"; repository: string; issue: number; title: string; url: string }
  | { kind: "github-repository"; repository: string; scope: string };

/** A plan of one tracker unit, whose repositories the operator picks before it runs. */
export const plansUnit = (action: RunAction, target: RunTarget): boolean =>
  action === "plan" && (target.kind === "azure-hu" || target.kind === "github-epic");

export type RunAction = "plan" | "code";

export interface RunOptions {
  /** Ordered: the first one is the target's repository, the rest join a workspace run. */
  repositories: string[];
  /** Code on an HU: one Task or Bug, or empty for every eligible one. */
  ticket: string;
  prompt: string;
  cli: string;
  model: string;
  variant: string;
  /** Plan: answer the session's questions in the window before it plans. */
  interview: boolean;
  questions: string;
  normasSag: boolean;
  /** Code on an HU, only when its integration branch does not exist yet. */
  baseBranch: string;
  /** `<cli>:<model>:<variant>` rungs, in descent order. */
  fallbacks: string[];
  idleTimeout: string;
  verbose: boolean;
}

export const emptyRunOptions = (repository: string): RunOptions => ({
  repositories: [repository], ticket: "", prompt: "", cli: "", model: "", variant: "",
  interview: false, questions: "", normasSag: false, baseBranch: "", fallbacks: [], idleTimeout: "", verbose: false,
});

/** How a plan prompt names its issue, so a run's title can name it back. */
export const ISSUE_PLAN_PREFIX = "Planifica a partir de la issue #";

/**
 * A GitHub plan has no `--issue`: the session reads the issue itself with
 * `gh issue view`, which its authority allows, and the coordinator publishes
 * the slices as `ready-for-agent` issues like any other plan.
 */
export function issuePlanPrompt(target: Extract<RunTarget, { kind: "github-issue" }>, extra: string): string {
  return [
    `${ISSUE_PLAN_PREFIX}${target.issue} «${target.title}» (${target.url}).`,
    `Léela completa con \`gh issue view ${target.issue} --comments\` y córtala en issues entregables.`,
    extra.trim(),
  ].filter(Boolean).join("\n\n");
}

export function runValues(action: RunAction, target: RunTarget, options: RunOptions): FlagValues {
  const azure = target.kind === "azure-hu";
  const prompt = target.kind === "github-issue" ? issuePlanPrompt(target, options.prompt) : options.prompt.trim();
  return {
    "--working-directory": options.repositories.filter(Boolean).join(","),
    "--hu": azure ? String(target.hu) : "",
    "--issue": target.kind === "github-epic" && action === "plan" ? String(target.issue) : "",
    "--ticket": azure && action === "code" ? options.ticket : "",
    "--base-branch": azure && action === "code" ? options.baseBranch.trim() : "",
    "--prompt": prompt,
    "--cli": options.cli,
    "--model": options.model,
    "--variant": options.variant,
    "--interview": action === "plan" && options.interview ? "http" : "",
    "--number-of-questions": action === "plan" ? options.questions : "",
    "--normas-sag": options.normasSag,
    "--fallback": options.fallbacks.filter(Boolean),
    "--idle-timeout": options.idleTimeout,
    "--verbose": options.verbose,
  };
}

export interface PreparedRun {
  readonly command: CatalogCommand;
  readonly args: string[];
  readonly issues: FlagIssue[];
}

/** Null when this lz does not offer the command, as an older install or a narrowed web catalog may not. */
export function prepareRun(catalog: CommandCatalog, action: RunAction, target: RunTarget, options: RunOptions): PreparedRun | null {
  const command = catalog.commands.find((candidate) => candidate.name === action);
  if (!command) return null;
  const values = runValues(action, target, options);
  const issues = validateFlags(catalog, command, values);
  // A GitHub plan with nothing to plan would only state the workflow's own default.
  if (action === "plan" && target.kind === "github-repository" && !options.prompt.trim()) {
    issues.push({ flag: "--prompt", severity: "error", message: "Describe qué quieres planificar." });
  }
  // Said in the operator's terms, in place of the catalog's generic "Falta Repositorios".
  if (plansUnit(action, target) && !options.repositories.some(Boolean)) {
    const others = issues.filter((issue) => issue.flag !== "--working-directory");
    return { command, args: buildArgs(catalog, command, values), issues: [{ flag: "--working-directory", severity: "error", message: "Elige el repositorio donde trabajar." }, ...others] };
  }
  return { command, args: buildArgs(catalog, command, values), issues };
}

/** `lz setup` for the problems the window detected, with an installed agent. */
export function prepareSetup(catalog: CommandCatalog, repository: string | null, problems: string, cli: string): PreparedRun | null {
  const command = catalog.commands.find((candidate) => candidate.name === "setup");
  if (!command) return null;
  const values: FlagValues = { "--working-directory": repository ?? "", "--prompt": problems, "--cli": cli };
  return { command, args: buildArgs(catalog, command, values), issues: validateFlags(catalog, command, values) };
}
