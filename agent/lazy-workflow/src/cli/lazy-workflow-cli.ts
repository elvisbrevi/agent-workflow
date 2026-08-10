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

function printHelp(): void {
  console.log([
    "Usage:",
    "  lazy-workflow plan --hu <id> [options]",
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
    private readonly huInfoService: Pick<HuInfoService, "getHuInfo" | "waitForAccess"> = new HuInfoService(),
    private readonly openCodeService: Pick<OpenCodeService, "run" | "resume"> = new OpenCodeService(),
  ) {}

  async run(args: string[]): Promise<number> {
    const command = args[0];
    if (command !== "plan" && command !== "hu-info") {
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
}
