import { expect, test } from "bun:test";
import {
  QuestionRoundParseError,
  completeAnswers,
  readPlanTurn,
  recommendedAnswers,
  unknownAnswerIds,
  type QuestionRound,
} from "../src/interaction/question-round.ts";
import { PLAN_READY_MARKER, QUESTIONS_PENDING_MARKER } from "../src/prompts/workflow-contract.ts";

const round: QuestionRound = {
  round: 1,
  questions: [
    { id: "q1", question: "¿Un servicio o dos?", recommended: "uno", options: ["uno", "dos"] },
    { id: "q2", question: "¿Se migra la data?", recommended: "sí" },
  ],
};

function pending(payload: unknown): string {
  return `analicé el repositorio\n${QUESTIONS_PENDING_MARKER}\n${JSON.stringify(payload)}`;
}

test("un texto sin marcadores es un plan terminado", () => {
  expect(readPlanTurn("el plan quedó listo")).toEqual({ kind: "final" });
});

test("una ronda pendiente se lee con sus preguntas", () => {
  expect(readPlanTurn(pending(round))).toEqual({ kind: "questions", round });
});

test("el último marcador manda: un plan que cita rondas anteriores está terminado", () => {
  const text = `${pending(round)}\n${PLAN_READY_MARKER}\n{"tickets":[]}`;

  expect(readPlanTurn(text)).toEqual({ kind: "final" });
});

test("una ronda posterior a un plan citado sigue siendo una pregunta", () => {
  const text = `${PLAN_READY_MARKER}\n{"tickets":[]}\n${pending(round)}`;

  expect(readPlanTurn(text)).toEqual({ kind: "questions", round });
});

test("una ronda sin JSON, malformada o sin preguntas falla cerrado", () => {
  expect(() => readPlanTurn(`${QUESTIONS_PENDING_MARKER}\nsin json`)).toThrow(QuestionRoundParseError);
  expect(() => readPlanTurn(`${QUESTIONS_PENDING_MARKER}\n{"round":1,`)).toThrow(QuestionRoundParseError);
  expect(() => readPlanTurn(pending({ round: 1, questions: [] }))).toThrow(QuestionRoundParseError);
  expect(() => readPlanTurn(pending({ questions: round.questions }))).toThrow(QuestionRoundParseError);
});

test("una pregunta sin recomendación falla cerrado: es lo que responde el vencimiento", () => {
  const text = pending({ round: 1, questions: [{ id: "q1", question: "¿uno o dos?" }] });

  expect(() => readPlanTurn(text)).toThrow(/recommended/);
});

test("una ronda con ids repetidos falla cerrado", () => {
  const text = pending({
    round: 1,
    questions: [
      { id: "q1", question: "a", recommended: "x" },
      { id: "q1", question: "b", recommended: "y" },
    ],
  });

  expect(() => readPlanTurn(text)).toThrow(/repite el id/);
});

test("una ronda cerrada con un bloque de código se lee igual", () => {
  const text = `${QUESTIONS_PENDING_MARKER}\n${JSON.stringify(round)}\n\`\`\``;

  expect(readPlanTurn(text)).toEqual({ kind: "questions", round });
});

test("sin respuesta se toman las recomendaciones de la propia sesión", () => {
  expect(recommendedAnswers(round)).toEqual({
    round: 1,
    source: "recommended",
    answers: [{ id: "q1", answer: "uno" }, { id: "q2", answer: "sí" }],
  });
});

test("responder todo es una decisión del operador", () => {
  const answers = completeAnswers(round, [{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }]);

  expect(answers.source).toBe("operator");
  expect(answers.answers).toEqual([{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }]);
});

test("una pregunta en blanco cae en su recomendación y la mezcla queda declarada", () => {
  const answers = completeAnswers(round, [{ id: "q1", answer: "dos" }, { id: "q2", answer: "   " }]);

  expect(answers.source).toBe("mixed");
  expect(answers.answers).toEqual([{ id: "q1", answer: "dos" }, { id: "q2", answer: "sí" }]);
});

test("no responder nada equivale a aceptar las recomendaciones", () => {
  expect(completeAnswers(round, []).source).toBe("recommended");
  expect(completeAnswers(round, []).answers).toEqual(recommendedAnswers(round).answers);
});

test("las respuestas a preguntas que la ronda no hizo se detectan y no se reenvían", () => {
  const given = [{ id: "q1", answer: "dos" }, { id: "inventada", answer: "x" }];

  expect(unknownAnswerIds(round, given)).toEqual(["inventada"]);
  expect(completeAnswers(round, given).answers.map(({ id }) => id)).toEqual(["q1", "q2"]);
});
