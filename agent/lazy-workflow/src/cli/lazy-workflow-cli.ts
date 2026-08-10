import { HuInfoService } from "../azure/hu-info-service.ts";
import { AzureAutocodeService, type AutocodeContext } from "../azure/autocode-service.ts";
import { GitAutocodeCheckpointStore, type AutocodeCheckpointStore } from "../azure/autocode-checkpoint.ts";
import { OpenCodeService, type OpenCodeRunOptions } from "../opencode/open-code-service.ts";

type CliOptions = OpenCodeRunOptions & {
  hu: number;
  numberOfQuestions: number;
  workingDirectory: string;
};

type AzureBoundary = Pick<HuInfoService, "getHuInfo" | "waitForAccess"> & Partial<{
  ensureIntegrationBranch(hu: number, prompt: string): Promise<string | null>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<boolean>;
}>;

interface RetryTimer { wait(milliseconds: number): Promise<void>; }

const DEFAULT_MODEL = "opencode-go/deepseek-v4-pro";
const DEFAULT_VARIANT = "high";
const DEFAULT_PROMPT = "cuanto es uno mas 3";
const DEFAULT_HU = -1;
const DEFAULT_NUMBER_OF_QUESTIONS = 5;

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
    "  lazy-workflow hu-info --hu <id>",
    "",
    "Options:",
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
      console.error(`Sesion OpenCode detenida: ${result.sessionId}`);
      await this.huInfoService.waitForAccess(options.hu);
      result = await this.openCodeService.resume(result.sessionId);
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  private async runCode(options: CliOptions): Promise<number> {
    if (!this.huInfoService.getAutocodeContext || !this.huInfoService.verifyTicketCompletion) {
      console.error("El servicio Azure no soporta autocode");
      return 1;
    }

    if (!this.huInfoService.ensureIntegrationBranch) {
      console.error("El servicio Azure no soporta autocode");
      return 1;
    }
    const checkpoint = await this.checkpointStore.read();
    const recovering = options.session !== null;
    if (recovering && (!checkpoint || checkpoint.sessionId !== options.session)) return 1;
    if (!recovering && checkpoint) return 1;
    const hu = recovering ? checkpoint!.hu : options.hu;
    let integrationBranch: string | null = null;
    let context: AutocodeContext | null = null;
    while (true) {
      try {
        integrationBranch = recovering
          ? (checkpoint!.sessionId && (await this.huInfoService.getAutocodeContext(hu))?.integrationBranch) ?? null
          : await this.huInfoService.ensureIntegrationBranch(hu, options.prompt);
        if (!integrationBranch) {
          await this.retryTimer.wait(10_000);
          continue;
        }
        context = await this.huInfoService.getAutocodeContext(hu, integrationBranch);
        if (context) break;
        if (!recovering) return 0;
        await this.retryTimer.wait(10_000);
      } catch {
        integrationBranch = null;
        context = null;
        try { await this.retryTimer.wait(10_000); } catch { return 1; }
      }
    }
    if (recovering && context.ticket.id !== checkpoint!.ticket) return 1;
    if (!recovering) {
      while (true) {
        try {
          await this.checkpointStore.write({ workflow: "autocode", hu, ticket: context.ticket.id, sessionId: null });
          break;
        } catch {
          try { await this.retryTimer.wait(10_000); } catch { return 1; }
        }
      }
    }
    const promptAsset = Bun.file(new URL("../../prompts/autocode-prompt.md", import.meta.url));
    const prompt = [
      await promptAsset.text(),
      JSON.stringify(context),
      `The working directory is ${options.workingDirectory}`,
      options.prompt,
    ].join("\n");

    let sessionId = options.session;
    let resumePrompt = options.prompt;
    while (true) {
      let result;
      try {
        const execution = sessionId
          ? { result: await this.openCodeService.resume(sessionId, resumePrompt), azureLoginRequired: false }
          : await this.openCodeService.run({ ...options, prompt, session: null }, true);
        result = execution.result;
        sessionId = result.sessionId;
        await this.checkpointStore.write({ workflow: "autocode", hu, ticket: context.ticket.id, sessionId });
        if (execution.azureLoginRequired) {
          await this.huInfoService.waitForAccess(hu);
          resumePrompt = "continue";
          continue;
        }
        resumePrompt = options.prompt;
        if (!execution.failed && result.text.trim() === "TICKET_COMPLETED" && await this.huInfoService.verifyTicketCompletion(context)) {
          await this.checkpointStore.clear();
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
      } catch {
        // Keep the pinned ticket and checkpoint; the next attempt may recover it.
      }
      try { await this.retryTimer.wait(10_000); } catch { return 1; }
    }
  }
}
