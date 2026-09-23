/**
 * Workflow prompt: the single place that decides what OpenCode is told.
 *
 * The coordinator hands this module the facts it has already fixed (workflow
 * kind, HU, ticket, issue, branches, manifest paths, repository order) and gets
 * back the prompt. Fragment order, contract text, and marker vocabulary live
 * here and in `prompts/`; they are no longer restated at each call site.
 */

import type { HuInfo } from "../azure/hu-info.ts";
import type { AutocodeContext, AzureWorkspaceBranchTopology } from "../azure/autocode-service.ts";
import type { GitHubRepositoryContext, SelectedManagedIssue } from "../github/managed-queue-service.ts";
import type { GitHubWorkspaceUnit } from "../github/github-workspace-checkpoint.ts";
import type { SagNormsContext } from "../sag/sag-norms-service.ts";
import type { WorkspaceScope } from "../workspace/repository-scope.ts";
import type { QuestionAnswers } from "../interaction/question-round.ts";
import {
  QUESTIONS_ANSWERED_MARKER,
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  TICKET_COMPLETED_MARKER,
  WORKFLOW_STEP_FINISHED_MARKER,
  renderContract,
} from "./workflow-contract.ts";

type PromptAsset =
  | "github-plan"
  /** Las tres líneas que toda entrega dice, sea GitHub o Azure (ADR-0036). */
  | "delivery"
  /** La línea que nombra la unidad de trabajo GitHub (issue). */
  | "github-delivery"
  /** La línea que nombra la unidad de trabajo Azure (ticket). */
  | "azure-delivery"
  | "autoplan"
  /** La forma del plan que toda sesion de planificacion devuelve, en cualquier tracker. */
  | "plan-tickets"
  | "autocode"
  | "plan-interview-auto"
  | "plan-interview-interactive"
  | "plan-interview-answers"
  | "plan-interview-round-repair";

export type SagContext = SagNormsContext;

/**
 * The provider an invocation resolves exactly once, in the vocabulary
 * `CONTEXT.md` already defines: an Azure HU run or a GitHub repository run.
 * Every branch that used to reinspect `--hu` reads this instead.
 */
export type WorkflowRun =
  | { readonly kind: "github-repository-run" }
  | { readonly kind: "azure-hu-run"; readonly hu: number };

/** Resolve the invocation's provider once, from the raw `--hu` CLI value. */
export function resolveWorkflowRun(hu: number | null): WorkflowRun {
  return hu === null ? { kind: "github-repository-run" } : { kind: "azure-hu-run", hu };
}

export type WorkflowPromptSpec =
  | { kind: "github-plan" }
  | { kind: "azure-plan"; huInfo: HuInfo }
  | { kind: "workspace-plan"; scope: WorkspaceScope; run: WorkflowRun; huInfo: HuInfo | null }
  | {
      kind: "github-delivery";
      issue: SelectedManagedIssue;
      repository: GitHubRepositoryContext;
      branch: string;
    }
  | {
      kind: "github-reconciliation";
      issue: SelectedManagedIssue;
      repository: GitHubRepositoryContext;
      branch: string;
      pullRequest: number;
      originalCommit: string;
      baseCommit: string;
    }
  | { kind: "github-workspace-delivery"; scope: WorkspaceScope; issue: SelectedManagedIssue; units: GitHubWorkspaceUnit[] }
  | {
      kind: "azure-workspace-delivery";
      scope: WorkspaceScope;
      hu: number | null;
      ticket: number | null;
      /** What the ticket asks for. The coordinator reads it before opening the session, because the
       * session is forbidden from selecting or inferring its own work. */
      context: AutocodeContext;
      description: string | null;
      topology: AzureWorkspaceBranchTopology;
      ticketTopology: AzureWorkspaceBranchTopology;
    }
  | {
      kind: "azure-delivery";
      context: AutocodeContext;
      /** La rama que el coordinador fijó y en la que la sesión ya está parada. */
      ticketBranch: string | null;
    };

export interface WorkflowPromptContext {
  /**
   * La petición del operador, y solo cuando la hay: el coordinador manda `""` cuando `--prompt`
   * quedó en su default, porque ese texto no es una petición sino relleno, y un prompt de cuatro
   * líneas no tiene dónde esconderlo.
   */
  operatorRequest: string;
  /** The directory the run was scoped to. Workspace runs override it with the parent directory. */
  workingDirectory: string;
  /** Phase-selected SAG norms, when the run loaded them. */
  norms?: SagContext | null;
  /** Question budget for the planning workflows. */
  questions?: number;
  /**
   * Whether an operator is reachable to answer this planning run's questions.
   * The two branches are separate assets rather than conditional prose, so the
   * session is never told both policies and left to pick one.
   */
  interview?: boolean;
  /** Set only when this prompt hands the same fixed work to a session in another CLI. */
  progress?: HandoffProgress | null;
}

/**
 * Lo que un traspaso dice del trabajo ya hecho: la rama, los commits que lleva
 * sobre su base, y las últimas cadenas de pensamiento del agente saliente tal
 * cual las emitió (ADR-0039). Las cadenas no son un informe que se le pidió a
 * una cuenta agotada: son lo último que su stream ya había emitido, y viajan
 * como lo que son. Lo que aterrizó lo dice la lista de commits al lado.
 */
export interface HandoffProgress {
  branch: string;
  /** `git log` de la rama sobre su base, vacío cuando todavía no commiteó nada. */
  commits: string;
  /** Las últimas cadenas de pensamiento del agente saliente. */
  reasoning: string[];
}

/** La sección de avance con la que arranca una sesión traspasada, anexada a su propio prompt. */
export function formatHandoffProgress(progress: HandoffProgress): string {
  const commits = progress.commits.trim();
  return [
    "Este trabajo ya está en curso; continúa desde acá y no reimplementes lo que ya está commiteado.",
    `Rama: ${progress.branch}`,
    commits ? `Commits en esta rama:\n${commits}` : "Todavía no hay commits en esta rama.",
    ...(progress.reasoning.length > 0
      ? ["Últimas cadenas de pensamiento del agente anterior:", ...progress.reasoning]
      : []),
  ].join("\n");
}

async function readAsset(name: PromptAsset): Promise<string> {
  // Sin el recorte, el salto final del archivo se vuelve una línea vacía del prompt.
  return (await Bun.file(new URL(`../../prompts/${name}-prompt.md`, import.meta.url)).text())
    .replace(/\r\n?/g, "\n")
    .trimEnd();
}

/** Load a prompt asset and resolve its contract placeholders. */
export async function readPromptAsset(
  name: PromptAsset,
  runtimeBindings?: Record<string, string>,
): Promise<string> {
  return renderContract(await readAsset(name), runtimeBindings);
}

/**
 * How this planning run answers its own questions. Every planning branch —
 * GitHub, Azure, workspace — appends exactly one of the two, so the policy is
 * stated once per run and never twice.
 */
function planInterviewSection(interview: boolean | undefined): Promise<string> {
  return readPromptAsset(interview ? "plan-interview-interactive" : "plan-interview-auto");
}

/**
 * The resume prompt of an answered round: the static reading instructions, the
 * marker, and the payload. The marker is composed here from the contract rather
 * than written into the asset, exactly as the delivery prompts do.
 */
export async function buildInterviewAnswersPrompt(
  answers: QuestionAnswers,
  remainingRounds: number,
): Promise<string> {
  return [
    await readPromptAsset("plan-interview-answers"),
    remainingRounds > 0
      ? `Quedan ${remainingRounds} ronda(s) de preguntas si aún necesitas decidir algo con el operador.`
      : "No quedan rondas de preguntas: entrega el plan final ahora, sin abrir otra ronda.",
    QUESTIONS_ANSWERED_MARKER,
    JSON.stringify(answers),
  ].join("\n");
}

/**
 * The resume prompt of a round the coordinator could not read: the static
 * restating instructions plus what the reader actually complained about, so the
 * session repairs the payload it wrote instead of guessing what was wrong with
 * it.
 */
export async function buildRoundRepairPrompt(reason: string): Promise<string> {
  return [
    await readPromptAsset("plan-interview-round-repair"),
    `Reader message: ${reason}`,
  ].join("\n");
}

/**
 * The Azure HU planning run's own sections: the User Story data, the
 * `autoplan` prompt, and the question budget. Both the mono-repository and
 * workspace planning runs consume exactly this, so a change here reaches
 * both at once.
 */
async function azureHuPlanningSections(
  huInfo: HuInfo,
  questions: number | undefined,
  interview: boolean | undefined,
): Promise<string[]> {
  return [
    JSON.stringify(huInfo),
    await readPromptAsset("autoplan"),
    await readPromptAsset("plan-tickets"),
    `The number of questions must be ${questions}`,
    await planInterviewSection(interview),
  ];
}

/**
 * The ready-made manifest invocations, when the coordinator has fixed enough to
 * write them. A run that has not fixed the ticket branch or the manifest path
 * yet gets the tool's instruction alone rather than a command line with a hole
 * in it, which a session would fill with something it invented.
 */
function manifestCommandLines(lines: Array<string | null>): string[] {
  const commands = lines.filter((line): line is string => line !== null);
  return commands.length > 0 ? ["Create each manifest with exactly this invocation:", ...commands] : [];
}

function repositoryRoster(scope: WorkspaceScope): string[] {
  return [
    "Ordered participant repositories:",
    ...scope.repositories.map(({ path, remote }, index) => `${index + 1}. ${path} (${remote})`),
  ];
}

export function formatSagContext(context: SagContext): string {
  return [
    "SAG norms context (normative file paths selected by tipo from .sag/config.json):",
    "The session reads the files itself with az.",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

async function fragments(spec: WorkflowPromptSpec, context: WorkflowPromptContext): Promise<Array<string | null>> {
  const { operatorRequest, workingDirectory, norms = null, questions, interview } = context;
  const sag = norms ? [formatSagContext(norms)] : [];

  switch (spec.kind) {
    case "github-plan":
      return [
        await readPromptAsset("github-plan"),
        await readPromptAsset("plan-tickets"),
        ...sag,
        `The number of questions must be ${questions}`,
        await planInterviewSection(interview),
        `The working directory is ${workingDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "azure-plan":
      return [
        ...(await azureHuPlanningSections(spec.huInfo, questions, interview)),
        ...sag,
        operatorRequest,
        `The working directory is ${workingDirectory}`,
      ];

    case "workspace-plan":
      // An Azure workspace plan is the Azure planning run with a repository roster,
      // so it must not carry the GitHub scope that forbids `az` and mandates `gh`.
      // `spec.run` is the already-resolved provider; it is never reinspected here.
      return [
        ...(spec.run.kind === "azure-hu-run"
          ? await azureHuPlanningSections(spec.huInfo!, questions, interview)
          : [
            await readPromptAsset("github-plan"),
            await readPromptAsset("plan-tickets"),
            await planInterviewSection(interview),
          ]),
        ...sag,
        `Workspace parent directory: ${spec.scope.parentDirectory}`,
        ...repositoryRoster(spec.scope),
        "OpenCode may only read or modify the listed repositories. Do not create, switch, push, delete, or associate delivery branches or pull requests through provider commands.",
        `The working directory is ${spec.scope.parentDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "github-delivery":
      // La única instrucción: el trabajo, y nada del contrato (ADR-0036). El Issue viaja como su
      // número porque la sesión tiene `gh` y lee el cuerpo fresco, no la foto que el coordinador
      // sacó antes de abrirla.
      return [
        await readPromptAsset("github-delivery", { UNIT_ID: `#${spec.issue.number}` }),
        await readPromptAsset("delivery"),
        ...sag,
        operatorRequest.trim() ? operatorRequest : null,
      ];

    case "github-reconciliation": {
      const { branch, pullRequest, originalCommit, baseCommit } = spec;
      return [
        "Reconcile the existing pull request conflict. This is not a new issue implementation.",
        `Coordinator-fixed pull request: #${pullRequest}`,
        `Original implementation commit: ${originalCommit}`,
        `Coordinator-fetched base commit: ${baseCommit}`,
        `Merge exactly ${baseCommit} into ${branch}; resolve every conflict while preserving both the fixed Issue requirements and already integrated base changes.`,
        "Do not rebase, reset, force-push, switch branches, select another issue, or mutate GitHub.",
        "Corre la validación que corresponda y crea el commit de merge. No pushees: el coordinador lo hace y verifica el resultado con git.",
      ];
    }

    case "github-workspace-delivery":
      // La variante transversal del issue GitHub: el mismo asset de entrega que usa un solo
      // repositorio, con el roster de repositorios en lugar de un único directorio (ADR-0036).
      return [
        await readPromptAsset("github-delivery", { UNIT_ID: `#${spec.issue.number}` }),
        `Workspace parent directory: ${spec.scope.parentDirectory}`,
        ...repositoryRoster(spec.scope),
        ...(spec.units.length > 0
          ? ["Ramas fijadas:", ...spec.units.map(({ path, branch }) => `${path}: ${branch}`)]
          : []),
        "Trabaja los repositorios en el orden declarado, commiteando cada uno por separado.",
        await readPromptAsset("delivery"),
        ...sag,
        `The working directory is ${spec.scope.parentDirectory}`,
        operatorRequest.trim() ? operatorRequest : null,
      ];

    case "azure-workspace-delivery":
      // La variante transversal del ticket Azure: el mismo trabajo, con el roster de repositorios
      // en lugar de un solo directorio (ADR-0036). El ticket viaja entero por la misma razón que
      // en el repositorio único — la sesión no tiene `az`.
      return [
        await readPromptAsset("azure-delivery", { UNIT_ID: String(spec.ticket) }),
        JSON.stringify(spec.context),
        ...(spec.description ? ["Descripción del ticket:", spec.description] : []),
        `Rama de integración: ${spec.topology.integrationBranch}`,
        `Rama del ticket: ${spec.ticketTopology.ticketBranch ?? null}`,
        ...repositoryRoster(spec.scope),
        "Trabaja los repositorios en el orden declarado, commiteando cada uno por separado en la rama del ticket.",
        await readPromptAsset("delivery"),
        ...sag,
        operatorRequest.trim() ? operatorRequest : null,
      ];

    case "azure-delivery":
      // El trabajo, y nada del contrato (ADR-0036). El ticket viaja entero porque la sesión no
      // tiene `az`: es la única forma de que sepa qué se le pidió, y el coordinador ya lo leyó.
      return [
        await readPromptAsset("azure-delivery", { UNIT_ID: String(spec.context.ticket.id) }),
        JSON.stringify(spec.context),
        await readPromptAsset("delivery"),
        ...sag,
        operatorRequest.trim() ? operatorRequest : null,
      ];
  }
}

/**
 * Compose the prompt for one coordinator-fixed run. A handoff passes the same
 * spec with `progress`, so the session on the next rung is told the same fixed
 * work — the issue and its branch — plus where it stands, rather than a prompt
 * written in parallel at the call site (ADR-0039).
 */
export async function buildWorkflowPrompt(
  spec: WorkflowPromptSpec,
  context: WorkflowPromptContext,
): Promise<string> {
  const lines = await fragments(spec, context);
  return [
    ...lines.filter((line): line is string => line !== null),
    ...(context.progress ? [formatHandoffProgress(context.progress)] : []),
  ].join("\n");
}

/** Append SAG norms to a resume prompt, which carries no coordinator facts of its own. */
export function buildResumePrompt(prompt: string, norms: SagContext | null): string {
  return norms ? [prompt, formatSagContext(norms)].join("\n") : prompt;
}
