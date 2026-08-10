import { HuInfoService } from "../azure/hu-info-service.ts";
import { OpenCodeService, type OpenCodeRunOptions } from "../opencode/open-code-service.ts";

type CliOptions = OpenCodeRunOptions & {
  hu: number;
  numberOfQuestions: number;
  workingDirectory: string;
};

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

export class LazyWorkflowCli {
  constructor(
    private readonly huInfoService: Pick<HuInfoService, "getHuInfo" | "waitForAccess"> = new HuInfoService(),
    private readonly openCodeService: Pick<OpenCodeService, "run" | "resume"> = new OpenCodeService(),
  ) {}

  async run(args: string[]): Promise<void> {
    let options = parseOptions(args);

    if (args.indexOf("hu-info") >= 0) {
      const huInfo = await this.huInfoService.getHuInfo(options.hu);
      console.log(JSON.stringify(huInfo, null, 2));
      return;
    }

    if (options.hu > 0) {
      const huInfo = await this.huInfoService.getHuInfo(options.hu);
      const sagPrompt = Bun.file(new URL("../../prompts/sag-azure-prompt.md", import.meta.url));
      const sagPromptContent = await sagPrompt.text();

      options.prompt = [
        JSON.stringify(huInfo),
        sagPromptContent,
        `el numero de preguntas debe ser de ${options.numberOfQuestions}`,
        options.prompt,
        `el directorio de trabajo es ${options.workingDirectory}`,
      ].join("\n");
    }

    const execution = await this.openCodeService.run(options, options.hu > 0);
    let result = execution.result;
    if (execution.azureLoginRequired && options.hu > 0) {
      console.error(`Sesion OpenCode detenida: ${result.sessionId}`);
      await this.huInfoService.waitForAccess(options.hu);
      result = await this.openCodeService.resume(result.sessionId);
    }
    console.log(JSON.stringify(result, null, 2));
  }
}
