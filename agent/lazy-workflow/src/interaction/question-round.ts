/**
 * The planning interview's protocol: what a question round is, how it is read
 * out of a session's own text, and how the answers travel back.
 *
 * The vocabulary lives here rather than in the coordinator because both the
 * coordinator and every question channel speak it, and because parsing a round
 * is exactly the kind of fail-closed reading `parsePlan` already does for a
 * delivery plan: the session decided what to ask, the coordinator decides
 * nothing it cannot verify.
 */

import { PLAN_READY_MARKER, QUESTIONS_PENDING_MARKER } from "../prompts/workflow-contract.ts";

/** One decision the session cannot make on its own, with the answer it would take. */
export interface PlanQuestion {
  id: string;
  question: string;
  /**
   * What the session would answer by itself. Mandatory, because it is what an
   * expired deadline resolves to: without it, an unattended run could not keep
   * behaving the way a non-interview run does.
   */
  recommended: string;
  rationale?: string;
  options?: string[];
}

/** The questions one paused turn handed over, together. */
export interface QuestionRound {
  round: number;
  questions: PlanQuestion[];
}

export interface PlanAnswer {
  id: string;
  answer: string;
}

/**
 * Where the answers came from, so the session knows whether a decision was
 * really made: an expired deadline resolves to `recommended`, which is a default
 * the session may revisit, not an operator's confirmed choice.
 */
export type AnswerSource = "operator" | "recommended" | "mixed";

export interface QuestionAnswers {
  round: number;
  source: AnswerSource;
  answers: PlanAnswer[];
}

/**
 * What a planning turn was: the plan is finished, or the session is waiting on
 * the operator. Nothing else is a turn — a text carrying neither marker is a
 * finished plan, which is how a GitHub planning run has always ended.
 */
export type PlanTurn =
  | { kind: "final" }
  | { kind: "questions"; round: QuestionRound };

export class QuestionRoundParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionRoundParseError";
  }
}

function isQuestion(candidate: unknown): candidate is PlanQuestion {
  const question = candidate as PlanQuestion;
  return typeof question === "object" && question !== null
    && typeof question.id === "string" && question.id.trim().length > 0
    && typeof question.question === "string" && question.question.trim().length > 0
    && typeof question.recommended === "string" && question.recommended.trim().length > 0
    && (question.rationale === undefined || typeof question.rationale === "string")
    && (question.options === undefined
      || (Array.isArray(question.options) && question.options.every((option) => typeof option === "string")));
}

/** The JSON object that follows a marker, with a trailing code fence tolerated. */
function readMarkerPayload(text: string, marker: string, at: number): unknown {
  const tail = text.slice(at + marker.length);
  const start = tail.indexOf("{");
  if (start < 0) throw new QuestionRoundParseError(`${marker} no va seguido de un objeto JSON`);
  try {
    return JSON.parse(tail.slice(start).replace(/```[\s\S]*$/, "").trim());
  } catch (error) {
    throw new QuestionRoundParseError(
      `La ronda tras ${marker} no es JSON válido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read what the session's last word was.
 *
 * The later marker wins, exactly as `parsePlan` reads the last `PLAN_READY`: a
 * finished plan legitimately quotes the rounds that produced it, so position —
 * not presence — is what says whether the session is still asking.
 */
export function readPlanTurn(text: string): PlanTurn {
  const questionsAt = text.lastIndexOf(QUESTIONS_PENDING_MARKER);
  if (questionsAt < 0) return { kind: "final" };
  if (text.lastIndexOf(PLAN_READY_MARKER) > questionsAt) return { kind: "final" };

  const parsed = readMarkerPayload(text, QUESTIONS_PENDING_MARKER, questionsAt) as QuestionRound;
  const round = (parsed as { round?: unknown })?.round;
  if (!Number.isInteger(round) || (round as number) <= 0) {
    throw new QuestionRoundParseError("La ronda no declara un número de ronda entero positivo");
  }
  const questions = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new QuestionRoundParseError("La ronda no contiene un arreglo \"questions\" con preguntas");
  }
  const invalid = questions.findIndex((question) => !isQuestion(question));
  if (invalid >= 0) {
    throw new QuestionRoundParseError(
      `La pregunta ${invalid + 1} de la ronda no tiene la forma esperada (id, question y recommended son obligatorios)`,
    );
  }
  const ids = (questions as PlanQuestion[]).map(({ id }) => id.trim());
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new QuestionRoundParseError(`La ronda repite el id de pregunta "${duplicate}"`);

  return { kind: "questions", round: { round: round as number, questions: questions as PlanQuestion[] } };
}

/** What an unanswered round resolves to: the session's own recommendations. */
export function recommendedAnswers(round: QuestionRound): QuestionAnswers {
  return {
    round: round.round,
    source: "recommended",
    answers: round.questions.map(({ id, recommended }) => ({ id, answer: recommended })),
  };
}

/**
 * Bind what the operator gave to the round that asked it. A question left blank
 * falls back to its recommendation and the payload says so, so the session is
 * never handed an answer it cannot bind nor told a default was a decision.
 */
export function completeAnswers(round: QuestionRound, given: readonly PlanAnswer[]): QuestionAnswers {
  const byId = new Map(given.map(({ id, answer }) => [id.trim(), answer]));
  let answered = 0;
  const answers = round.questions.map(({ id, recommended }) => {
    const answer = byId.get(id.trim())?.trim();
    if (answer) answered += 1;
    return { id, answer: answer || recommended };
  });
  return {
    round: round.round,
    source: answered === 0 ? "recommended" : answered === answers.length ? "operator" : "mixed",
    answers,
  };
}

/** The ids the operator sent that this round never asked about. */
export function unknownAnswerIds(round: QuestionRound, given: readonly PlanAnswer[]): string[] {
  const asked = new Set(round.questions.map(({ id }) => id.trim()));
  return given.map(({ id }) => id.trim()).filter((id) => !asked.has(id));
}
