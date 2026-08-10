import { HuInfoService } from "./hu-info-service.ts";
import { OpenCodeService, type OpenCodeRunOptions } from "./open-code-service.ts";

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
    private readonly huInfoService = new HuInfoService(),
    private readonly openCodeService = new OpenCodeService(),
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
      const sagPrompt = Bun.file("./sag-azure-prompt.md");
      const sagPromptContent = await sagPrompt.text();

      options.prompt = JSON.stringify(huInfo) + "\n" + sagPromptContent + "\n" + "\n el numero de preguntas debe ser de " + options.numberOfQuestions + "\n" + options.prompt + "\n" + "\n el directorio de trabajo es " + options.workingDirectory + "";
    }

    const result = await this.openCodeService.run(options);
    console.log(JSON.stringify(result, null, 2));
  }
}

if (import.meta.main) {
  await new LazyWorkflowCli().run(Bun.argv.slice(2));
}
