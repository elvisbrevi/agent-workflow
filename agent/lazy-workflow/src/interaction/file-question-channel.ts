/**
 * The file channel: the round is written as JSON and the answers are read back
 * from JSON, polled the way `waitForAccess` polls Azure for a login.
 *
 * This is the channel that makes the seam worth having. Anything able to write
 * a file can answer a planning interview — a GUI of your own, a mail bridge, a
 * chat bot, another agent — without lazy-workflow learning what any of them
 * are. The files stay on disk afterwards, so a published plan can be read back
 * against the decisions that shaped it.
 */

import { join } from "node:path";
import { completeAnswers, unknownAnswerIds, type PlanAnswer, type QuestionAnswers, type QuestionRound } from "./question-round.ts";
import {
  QuestionChannelUnavailableError,
  withRoundDeadline,
  type InterviewSettings,
  type QuestionChannel,
  type QuestionChannelDependencies,
} from "./question-channel.ts";

const POLL_INTERVAL_MS = 1_000;

export class FileQuestionChannel implements QuestionChannel {
  readonly kind = "file" as const;

  private readonly directory: string;
  private closed = false;

  constructor(
    private readonly settings: InterviewSettings,
    private readonly deps: QuestionChannelDependencies,
    private readonly pollIntervalMs: number = POLL_INTERVAL_MS,
  ) {
    if (!settings.directory) {
      throw new QuestionChannelUnavailableError("El canal de archivos requiere un directorio de intercambio");
    }
    this.directory = settings.directory;
    this.deps.reporter.info(`Responde las preguntas del plan escribiendo las respuestas en ${this.directory}`);
  }

  async ask(round: QuestionRound): Promise<QuestionAnswers> {
    if (this.closed) throw new QuestionChannelUnavailableError("El canal de archivos de preguntas ya fue cerrado");
    const questionsPath = join(this.directory, `ronda-${round.round}.preguntas.json`);
    const answersPath = join(this.directory, `ronda-${round.round}.respuestas.json`);

    // A round file that already exists belongs to another run: overwriting it
    // would silently answer this round with someone else's decisions.
    if (await Bun.file(questionsPath).exists()) {
      throw new QuestionChannelUnavailableError(`${questionsPath} ya existe; el directorio pertenece a otra entrevista`);
    }
    await Bun.write(questionsPath, `${JSON.stringify(round, null, 2)}\n`);
    this.deps.reporter.info(`Ronda ${round.round} escrita en ${questionsPath}; esperando ${answersPath}`);

    return withRoundDeadline(round, this.settings.timeoutSeconds, this.deps.deadline, this.poll(round, answersPath));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async poll(round: QuestionRound, answersPath: string): Promise<QuestionAnswers> {
    for (;;) {
      if (this.closed) throw new QuestionChannelUnavailableError("El canal de archivos de preguntas fue cerrado");
      const file = Bun.file(answersPath);
      if (await file.exists()) {
        const answers = await this.read(file, answersPath, round);
        if (answers) return answers;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  /**
   * A half-written file is the normal case for a poller, so an unparseable read
   * is retried rather than failed: the writer is still writing. A parsed file
   * whose shape is wrong is the operator's mistake and stops the round.
   */
  private async read(file: Bun.BunFile, path: string, round: QuestionRound): Promise<QuestionAnswers | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return null;
    }
    const given = (parsed as { answers?: unknown })?.answers;
    if (!Array.isArray(given) || given.some((answer) => typeof answer?.id !== "string" || typeof answer?.answer !== "string")) {
      throw new QuestionChannelUnavailableError(`${path} debe traer answers: [{id, answer}]`);
    }
    const unknown = unknownAnswerIds(round, given as PlanAnswer[]);
    if (unknown.length > 0) {
      this.deps.reporter.warn(`Se descartan respuestas a preguntas que la ronda no hizo: ${unknown.join(", ")}`);
    }
    return completeAnswers(round, given as PlanAnswer[]);
  }
}
