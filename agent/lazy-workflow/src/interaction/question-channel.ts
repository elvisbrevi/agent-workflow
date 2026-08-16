/**
 * The question channel seam: how a planning round reaches a human and how the
 * answers come back.
 *
 * The coordinator owns the interview — how many rounds, what an expired
 * deadline means, which session is resumed — and the channel owns only the
 * carrying. That split is what makes another channel a single adapter: a
 * browser page, a terminal, a pair of files today, and a GUI or a mailbox
 * later, without the coordinator learning any of them.
 *
 * The session itself never touches a channel. It prints a marker and reads the
 * answers it is handed on resume, so the interview adds no capability to the
 * agent and its authority profile stays exactly as it was.
 */

import type { Reporter } from "../output/reporter.ts";
import type { QuestionAnswers, QuestionRound } from "./question-round.ts";

/** The channels an operator may pick. `off` is the default: no interview at all. */
export const INTERVIEW_CHANNELS = ["off", "http", "terminal", "file"] as const;

export type InterviewChannelKind = (typeof INTERVIEW_CHANNELS)[number];

export function isInterviewChannel(value: string): value is InterviewChannelKind {
  return (INTERVIEW_CHANNELS as readonly string[]).includes(value);
}

/** Everything a run fixes about its interview before the first question exists. */
export interface InterviewSettings {
  channel: InterviewChannelKind;
  /** Loopback by default; a wider bind is announced to the operator. */
  host: string;
  /** `0` asks the OS for a free port, so two runs never collide. */
  port: number;
  /** Where the file channel writes rounds and reads answers. */
  directory: string | null;
  /** Deadline per round; once spent, the recommended answers are taken. */
  timeoutSeconds: number;
  /** Bound on round trips, so an interview always terminates. */
  rounds: number;
}

export interface QuestionChannel {
  readonly kind: InterviewChannelKind;
  /**
   * Wait for this round's answers. Rejects with `QuestionTimeoutError` when the
   * deadline is spent, and with `QuestionChannelUnavailableError` when the
   * operator's end went away; the coordinator decides what either one means.
   */
  ask(round: QuestionRound): Promise<QuestionAnswers>;
  close(): Promise<void>;
}

/** The round's deadline was spent before an answer arrived. */
export class QuestionTimeoutError extends Error {
  constructor(readonly round: number, readonly seconds: number) {
    super(`La ronda ${round} no fue respondida en ${seconds}s`);
    this.name = "QuestionTimeoutError";
  }
}

/** The channel cannot carry a question: no tty, a taken port, an unusable directory. */
export class QuestionChannelUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QuestionChannelUnavailableError";
  }
}

/**
 * A deadline that can be called off. Cancellable rather than a bare sleep,
 * because the timer of an answered round must not hold the process open for
 * the fifteen minutes the operator did not need.
 */
export interface Deadline {
  expired: Promise<void>;
  cancel(): void;
}

export type DeadlineFactory = (milliseconds: number) => Deadline;

export const realDeadline: DeadlineFactory = (milliseconds) => {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return { expired, cancel: () => clearTimeout(timer) };
};

/** What every channel is built with; injected so a test never opens a real one. */
export interface QuestionChannelDependencies {
  reporter: Reporter;
  /** The deadline's clock, injected so a test does not wait real seconds. */
  deadline: DeadlineFactory;
}

/**
 * Race one round's answers against its deadline. Every channel waits the same
 * way, so the deadline means one thing regardless of which one is carrying.
 */
export async function withRoundDeadline<T>(
  round: QuestionRound,
  seconds: number,
  deadline: DeadlineFactory,
  answered: Promise<T>,
): Promise<T> {
  const pending = deadline(seconds * 1000);
  try {
    return await Promise.race([
      answered,
      pending.expired.then(() => {
        throw new QuestionTimeoutError(round.round, seconds);
      }),
    ]);
  } finally {
    pending.cancel();
  }
}
