import { $ } from "bun";
import { OpenCodeResult } from "./open-code-result.ts";

export interface OpenCodeRunOptions {
  model: string;
  variant: string;
  session: string | null;
  prompt: string;
}

export class OpenCodeService {
  async run(options: OpenCodeRunOptions): Promise<OpenCodeResult> {
    const sessionArgs = options.session ? ["--session", options.session] : [];
    const output = await $`
      opencode run \
      --auto \
      --model ${options.model} \
      --variant ${options.variant} \
      ${sessionArgs} \
      --format json \
      ${options.prompt}
    `.text();

    return OpenCodeResult.fromJsonLines(output);
  }
}
