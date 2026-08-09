import { HuInfoService } from "./hu-info-service.ts";
import { OpenCodeService, type OpenCodeRunOptions } from "./open-code-service.ts";

type CliOptions = OpenCodeRunOptions & {
  hu: number;
};

const DEFAULT_MODEL = "opencode-go/deepseek-v4-pro";
const DEFAULT_VARIANT = "high";
const DEFAULT_PROMPT = "cuanto es uno mas 3";
const DEFAULT_HU = 23438;

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function parseOptions(args: string[]): CliOptions {
  const hu = Number.parseInt(optionValue(args, "--hu") ?? `${DEFAULT_HU}`, 10);

  return {
    model: optionValue(args, "--model") ?? DEFAULT_MODEL,
    variant: optionValue(args, "--variant") ?? DEFAULT_VARIANT,
    session: optionValue(args, "--session"),
    prompt: optionValue(args, "--prompt") ?? DEFAULT_PROMPT,
    hu,
  };
}

export class LazyWorkflowCli {
  constructor(
    private readonly huInfoService = new HuInfoService(),
    private readonly openCodeService = new OpenCodeService(),
  ) {}

  async run(args: string[]): Promise<void> {
    if (args[0] === "hu-info") {
      await this.showHuInfo(parseOptions(args.slice(1)));
      return;
    }

    await this.runPlanner(args);
  }

  private async showHuInfo(options: CliOptions): Promise<void> {
    const huInfo = await this.huInfoService.getHuInfo(options.hu);
    console.log(JSON.stringify(huInfo, null, 2));
  }

  private async runPlanner(args: string[]): Promise<void> {
    const options = parseOptions(args);
    const result = await this.openCodeService.run(options);

    console.log(JSON.stringify(result, null, 2));
  }
}

if (import.meta.main) {
  await new LazyWorkflowCli().run(Bun.argv.slice(2));
}
