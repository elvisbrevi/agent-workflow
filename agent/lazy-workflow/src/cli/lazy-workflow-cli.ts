import { HuInfoService } from "../azure/hu-info-service.ts";
import { AzureAutocodeService, type AutocodeContext, type AutocodeState, type VerifiedTicketCompletion } from "../azure/autocode-service.ts";
import { GitAutocodeCheckpointStore, type AutocodeCheckpointStore } from "../azure/autocode-checkpoint.ts";
import { OpenCodeService, OpenCodeSessionCloseError, type OpenCodeRunOptions } from "../opencode/open-code-service.ts";
import { reportOperator } from "../output/operator-output.ts";
import { GitTicketBranchCleaner } from "../git/git-ticket-branch-cleaner.ts";

type CliOptions = OpenCodeRunOptions & {
  hu: number;
  numberOfQuestions: number;
  workingDirectory: string;
};

type AzureBoundary = Pick<HuInfoService, "getHuInfo" | "waitForAccess"> & Partial<{
  ensureIntegrationBranch(hu: number): Promise<string | null>;
  getAutocodeState?(hu: number, integrationBranch?: string): Promise<AutocodeState>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  getAutocodeContextForTicket(hu: number, ticket: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<VerifiedTicketCompletion | null>;
  getCompletedTicketBranch(context: AutocodeContext): Promise<string | null>;
}>;

interface RetryTimer { wait(milliseconds: number): Promise<void>; }
interface TicketBranchCleaner {
  deleteTicketBranch(ticketBranch: string, integrationBranch: string, workingDirectory: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containsMarker(text: string, marker: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === marker);
}

const DEFAULT_MODEL = "opencode-go/deepseek-v4-pro";
const DEFAULT_VARIANT = "high";
const DEFAULT_PROMPT = "cuanto es uno mas 3";
const DEFAULT_HU = -1;
const DEFAULT_NUMBER_OF_QUESTIONS = 5;
const TICKET_COMPLETED_MARKER = "TICKET_COMPLETED";

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function parseOptions(args: string[]): CliOptions {
  return {
    model: optionValue(args, "--model") ?? DEFAULT_MODEL,
    variant: optionValue(args, "--variant") ?? DEFAULT_VARIANT,
    session: optionValue(args, "--session"),
    prompt: optionValue(args, "--prompt") ?? DEFAULT_PROMPT,
    hu: Number.parseInt(optionValue(args, "--hu") ?? `${DEFAULT_HU}`, 10),
    numberOfQuestions: Number.parseInt(optionValue(args, "--number-of-questions") ?? `${DEFAULT_NUMBER_OF_QUESTIONS}`, 10),
    workingDirectory: optionValue(args, "--working-directory") ?? process.cwd(),
  };
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  lazy-workflow plan --hu <id> [options]",
    "  lazy-workflow code --hu <id> [options]",
    "  lazy-workflow code --session <id> --prompt continue",
    "  lazy-workflow hu-info --hu <id>",
    "",
    "Options:",
    "  --hu <id>",
    "  --session <id>",
    "  --model <model>",
    "  --variant <variant>",
    "  --prompt <prompt>",
    "  --number-of-questions <count>",
    "  --working-directory <path>",
  ].join("\n"));
}

export class LazyWorkflowCli {
  constructor(
    private readonly huInfoService: AzureBoundary = new AzureAutocodeService(),
    private readonly openCodeService: Pick<OpenCodeService, "run" | "resume"> = new OpenCodeService(),
    private readonly checkpointStore: AutocodeCheckpointStore = new GitAutocodeCheckpointStore(),
    private readonly retryTimer: RetryTimer = { wait: Bun.sleep },
    private readonly ticketBranchCleaner: TicketBranchCleaner = new GitTicketBranchCleaner(),
  ) {}

  async run(args: string[]): Promise<number> {
    const command = args[0];
    if (command !== "plan" && command !== "code" && command !== "hu-info") {
      printHelp();
      return 1;
    }

    const options = parseOptions(args);

    if (command === "hu-info") {
      const huInfo = await this.huInfoService.getHuInfo(options.hu);
      console.log(JSON.stringify(huInfo, null, 2));
      return 0;
    }

    if (options.hu <= 0) {
      printHelp();
      return 1;
    }

    if (command === "code") return this.runCode(options);

    const huInfo = await this.huInfoService.getHuInfo(options.hu);
    const autoplanPrompt = Bun.file(new URL("../../prompts/autoplan-prompt.md", import.meta.url));
    const autoplanPromptContent = await autoplanPrompt.text();

    options.prompt = [
      JSON.stringify(huInfo),
      autoplanPromptContent,
      `The number of questions must be ${options.numberOfQuestions}`,
      options.prompt,
      `The working directory is ${options.workingDirectory}`,
    ].join("\n");

    const execution = await this.openCodeService.run(options, true);
    let result = execution.result;
    if (execution.azureLoginRequired && options.hu > 0) {
      reportOperator(`Sesion OpenCode detenida: ${result.sessionId}`);
      await this.huInfoService.waitForAccess(options.hu);
      result = await this.openCodeService.resume(result.sessionId, "continue", options.workingDirectory);
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  private async runCode(options: CliOptions): Promise<number> {
    if (!this.huInfoService.getAutocodeContext || !this.huInfoService.verifyTicketCompletion) {
      reportOperator("El servicio Azure no soporta autocode");
      return 1;
    }

    if (!this.huInfoService.ensureIntegrationBranch) {
      reportOperator("El servicio Azure no soporta autocode");
      return 1;
    }
    const checkpoint = await this.checkpointStore.read();
    let recovering = options.session !== null;
    let reconciling = !recovering && checkpoint?.sessionId === null;
    if (recovering && (!checkpoint || checkpoint.sessionId !== options.session)) return 1;
    if (!recovering && checkpoint && !reconciling) return 1;
    const hu = recovering || reconciling ? checkpoint!.hu : options.hu;
    let integrationBranch: string | null = null;
    let sessionId = options.session;
    let lastResult;
    reportOperator(`lazy-workflow: buscando la rama de integración y los tickets de la HU ${hu}...`);
    while (true) {
      let state: AutocodeState;
      try {
        if (recovering && !integrationBranch) {
          state = this.huInfoService.getAutocodeState
            ? await this.huInfoService.getAutocodeState(hu)
            : { context: await this.huInfoService.getAutocodeContext(hu), pending: false };
          integrationBranch = state.context?.integrationBranch ?? null;
        } else {
          integrationBranch = integrationBranch ?? await this.huInfoService.ensureIntegrationBranch(hu);
        }
        if (!integrationBranch) {
          reportOperator(`lazy-workflow: no se encontró todavía la rama base para la HU ${hu}; reintentando en 10s.`);
          await this.retryTimer.wait(10_000);
          continue;
        }
        if (reconciling) {
          if (!this.huInfoService.getAutocodeContextForTicket) {
            reportOperator("lazy-workflow: el servicio Azure no puede reconciliar el ticket interrumpido.");
            return 1;
          }
          const completedContext = await this.huInfoService.getAutocodeContextForTicket(
            hu,
            checkpoint!.ticket,
            integrationBranch,
          );
          const verification = completedContext
            ? await this.huInfoService.verifyTicketCompletion(completedContext)
            : null;
          if (!completedContext || !verification) {
            reportOperator(`lazy-workflow: el ticket ${checkpoint!.ticket} todavía no cumple el cierre verificable.`);
            return 1;
          }
          try {
            await this.cleanupCompletedTicketBranch(
              completedContext,
              options.workingDirectory,
              verification.ticketBranch,
            );
          } catch (error) {
            reportOperator(`lazy-workflow: la limpieza Git del ticket ${completedContext.ticket.id} falló (${errorMessage(error)}); checkpoint conservado.`);
            return 1;
          }
          await this.checkpointStore.clear();
          reconciling = false;
          continue;
        }
        state = this.huInfoService.getAutocodeState
          ? await this.huInfoService.getAutocodeState(hu, integrationBranch)
          : { context: await this.huInfoService.getAutocodeContext(hu, integrationBranch), pending: false };
      } catch (error) {
        reportOperator(`lazy-workflow: Azure no respondió (${errorMessage(error)}); reintentando en 10s.`);
        try { await this.retryTimer.wait(10_000); } catch { return 1; }
        continue;
      }

      if (!state.context) {
        if (!state.pending) {
          if (lastResult) console.log(JSON.stringify(lastResult, null, 2));
          reportOperator(`lazy-workflow: no hay tickets pendientes para la HU ${hu}.`);
          return 0;
        }
        reportOperator(`lazy-workflow: no hay un ticket elegible todavía; reintentando en 10s.`);
        try { await this.retryTimer.wait(10_000); } catch { return 1; }
        continue;
      }

      if (recovering && state.context.ticket.id !== checkpoint!.ticket) return 1;
      const context = state.context;
      if (!recovering) {
        try {
          await this.checkpointStore.write({ workflow: "autocode", hu, ticket: context.ticket.id, sessionId: null });
        } catch {
          try { await this.retryTimer.wait(10_000); } catch { return 1; }
          continue;
        }
      }

      const promptAsset = Bun.file(new URL("../../prompts/autocode-prompt.md", import.meta.url));
      const prompt = [
        await promptAsset.text(),
        JSON.stringify(context),
        `The working directory is ${options.workingDirectory}`,
        options.prompt,
      ].join("\n");
      let resumePrompt = options.prompt;
      while (true) {
        try {
          const execution = sessionId
            ? { result: await this.openCodeService.resume(sessionId, resumePrompt, options.workingDirectory, TICKET_COMPLETED_MARKER), azureLoginRequired: false }
            : await this.openCodeService.run({ ...options, prompt, session: null, terminalMarker: TICKET_COMPLETED_MARKER }, true);
          const result = execution.result;
          lastResult = result;
          const terminalMarkerReceived = !execution.failed && containsMarker(result.text, TICKET_COMPLETED_MARKER);
          try {
            await this.checkpointStore.write({
              workflow: "autocode",
              hu,
              ticket: context.ticket.id,
              sessionId: terminalMarkerReceived ? null : result.sessionId,
            });
          } catch (error) {
            if (terminalMarkerReceived) {
              reportOperator(`lazy-workflow: no se pudo persistir el checkpoint sessionless (${errorMessage(error)}); ejecución detenida.`);
              return 1;
            }
            throw error;
          }
          sessionId = terminalMarkerReceived ? null : result.sessionId;
          if (execution.azureLoginRequired) {
            reportOperator(`Sesion OpenCode detenida: ${result.sessionId}`);
            await this.huInfoService.waitForAccess(hu);
            resumePrompt = "continue";
            continue;
          }
          resumePrompt = options.prompt;
          if (terminalMarkerReceived) {
            const verification = await this.huInfoService.verifyTicketCompletion(context);
            if (!verification) {
              reportOperator(`lazy-workflow: el ticket ${context.ticket.id} todavía no cumple el cierre verificable; checkpoint sessionless conservado.`);
              return 1;
            }
            try {
              await this.cleanupCompletedTicketBranch(
                context,
                options.workingDirectory,
                verification.ticketBranch,
              );
            } catch (error) {
              reportOperator(`lazy-workflow: la limpieza Git del ticket ${context.ticket.id} falló (${errorMessage(error)}); checkpoint conservado.`);
              return 1;
            }
            await this.checkpointStore.clear();
            if (!this.huInfoService.getAutocodeState) {
              console.log(JSON.stringify(result, null, 2));
              return 0;
            }
            recovering = false;
            sessionId = null;
            break;
          }
        } catch (error) {
          if (error instanceof OpenCodeSessionCloseError) {
            try {
              await this.checkpointStore.write({
                workflow: "autocode",
                hu,
                ticket: context.ticket.id,
                sessionId: null,
              });
            } catch { /* preserve the existing checkpoint when persistence is unavailable */ }
            reportOperator(`lazy-workflow: no se pudo cerrar la sesión ${error.sessionId} (${errorMessage(error)}); checkpoint sessionless conservado y ejecución detenida.`);
            return 1;
          }
          reportOperator(`lazy-workflow: OpenCode falló (${errorMessage(error)}); conservaré la sesión y reintentaré en 10s.`);
        }
        try { await this.retryTimer.wait(10_000); } catch { return 1; }
      }
    }
  }

  private async cleanupCompletedTicketBranch(
    context: AutocodeContext,
    workingDirectory: string,
    verifiedTicketBranch: string,
  ): Promise<void> {
    await this.ticketBranchCleaner.deleteTicketBranch(verifiedTicketBranch, context.integrationBranch, workingDirectory);
    reportOperator(`lazy-workflow: rama completada ${verifiedTicketBranch} eliminada local y remotamente.`);
  }
}
