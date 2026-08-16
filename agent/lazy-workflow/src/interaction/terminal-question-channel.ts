/**
 * The terminal channel: the operator answers where they launched the run.
 *
 * It reads `/dev/tty` rather than stdin, the idiom `install.sh` already uses,
 * because a planning run's stdout is normally piped somewhere — the plan is
 * JSON — and a channel that died the moment the result was piped would be
 * useless exactly when it is most convenient.
 *
 * Questions are rendered through the Reporter, which writes to stderr, so the
 * interview never interleaves with the JSON result on stdout.
 */

import type { PlanAnswer, QuestionAnswers, QuestionRound } from "./question-round.ts";
import { completeAnswers } from "./question-round.ts";
import {
  QuestionChannelUnavailableError,
  withRoundDeadline,
  type InterviewSettings,
  type QuestionChannel,
  type QuestionChannelDependencies,
} from "./question-channel.ts";

/** Where the operator types. Injected so a test drives it without a terminal. */
export interface TerminalIo {
  input: ReadableStream<Uint8Array>;
  /** The bare `> ` prompt, written straight to the terminal rather than stamped. */
  write(chunk: string): void;
}

export function openTerminalIo(): TerminalIo {
  try {
    const tty = Bun.file("/dev/tty");
    const writer = Bun.file("/dev/tty").writer();
    return {
      input: tty.stream(),
      write: (chunk) => {
        writer.write(chunk);
        writer.flush();
      },
    };
  } catch (error) {
    throw new QuestionChannelUnavailableError(
      "El canal terminal necesita una terminal (/dev/tty) para preguntar",
      { cause: error },
    );
  }
}

/** Reads one line at a time off a stream that stays open between rounds. */
/**
 * The two calls this reader needs. Structural rather than a named reader type,
 * because Bun's own declaration and the `node:stream/web` one differ in members
 * neither this module nor its tests ever touch.
 */
interface StreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<unknown>;
}

class LineReader {
  private readonly reader: StreamReader;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader() as StreamReader;
  }

  async readLine(): Promise<string | null> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line.replace(/\r$/, "");
      }
      const { done, value } = await this.reader.read();
      if (done) {
        const rest = this.buffer;
        this.buffer = "";
        return rest.length > 0 ? rest : null;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // The terminal is already gone; nothing to release.
    }
  }
}

export class TerminalQuestionChannel implements QuestionChannel {
  readonly kind = "terminal" as const;

  private readonly lines: LineReader;
  private closed = false;

  constructor(
    private readonly settings: InterviewSettings,
    private readonly deps: QuestionChannelDependencies,
    private readonly io: TerminalIo = openTerminalIo(),
  ) {
    this.lines = new LineReader(io.input);
    this.deps.reporter.info("Responde las preguntas del plan en esta terminal; vacío acepta la recomendación.");
  }

  async ask(round: QuestionRound): Promise<QuestionAnswers> {
    if (this.closed) throw new QuestionChannelUnavailableError("El canal terminal de preguntas ya fue cerrado");
    return withRoundDeadline(round, this.settings.timeoutSeconds, this.deps.deadline, this.prompt(round));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.lines.close();
  }

  private async prompt(round: QuestionRound): Promise<QuestionAnswers> {
    const given: PlanAnswer[] = [];
    for (const [index, question] of round.questions.entries()) {
      this.deps.reporter.info(`Ronda ${round.round} · pregunta ${index + 1}/${round.questions.length}: ${question.question}`);
      if (question.rationale) this.deps.reporter.info(`  por qué: ${question.rationale}`);
      question.options?.forEach((option, position) => {
        this.deps.reporter.info(`  ${position + 1}) ${option}`);
      });
      this.deps.reporter.info(`  recomendación: ${question.recommended}`);
      this.io.write("> ");

      const line = await this.lines.readLine();
      if (line === null) {
        throw new QuestionChannelUnavailableError("La terminal se cerró durante la ronda de preguntas");
      }
      const typed = line.trim();
      // A number picks from the offered options; anything else is the answer itself.
      const chosen = question.options && /^\d+$/.test(typed)
        ? question.options[Number.parseInt(typed, 10) - 1]
        : undefined;
      given.push({ id: question.id, answer: chosen ?? typed });
    }
    return completeAnswers(round, given);
  }
}
