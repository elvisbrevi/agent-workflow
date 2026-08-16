/**
 * Which channel an `--interview` value resolves to. The single place that knows
 * the channel names, mirroring `create-coding-agent.ts`: adding a channel is a
 * new adapter plus one line here, and the coordinator never changes.
 */

import { getDefaultReporter } from "../output/operator-output.ts";
import type { Reporter } from "../output/reporter.ts";
import { FileQuestionChannel } from "./file-question-channel.ts";
import { HttpQuestionChannel } from "./http-question-channel.ts";
import {
  realDeadline,
  type InterviewSettings,
  type QuestionChannel,
  type QuestionChannelDependencies,
} from "./question-channel.ts";
import { TerminalQuestionChannel } from "./terminal-question-channel.ts";

/**
 * Null for `off`, so "no interview" stays a first-class state. A null-object
 * channel that answered with the recommendations would make an unattended run
 * indistinguishable from an interviewed one in the code that reads it.
 */
export type QuestionChannelFactory = (
  settings: InterviewSettings,
  reporter?: Reporter,
) => QuestionChannel | null;

export const createQuestionChannel: QuestionChannelFactory = (settings, reporter = getDefaultReporter()) => {
  const deps: QuestionChannelDependencies = { reporter, deadline: realDeadline };
  switch (settings.channel) {
    case "off":
      return null;
    case "http":
      return new HttpQuestionChannel(settings, deps);
    case "terminal":
      return new TerminalQuestionChannel(settings, deps);
    case "file":
      return new FileQuestionChannel(settings, deps);
  }
};
