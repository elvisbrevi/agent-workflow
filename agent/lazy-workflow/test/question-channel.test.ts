import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileQuestionChannel } from "../src/interaction/file-question-channel.ts";
import { HttpQuestionChannel } from "../src/interaction/http-question-channel.ts";
import {
  QuestionChannelUnavailableError,
  QuestionTimeoutError,
  realDeadline,
  type Deadline,
  type InterviewSettings,
  type QuestionChannelDependencies,
} from "../src/interaction/question-channel.ts";
import { TerminalQuestionChannel } from "../src/interaction/terminal-question-channel.ts";
import type { QuestionRound } from "../src/interaction/question-round.ts";
import { captureReporter } from "./_helpers/reporter-capture.ts";

const round: QuestionRound = {
  round: 1,
  questions: [
    { id: "q1", question: "¿Un servicio o dos?", recommended: "uno", options: ["uno", "dos"] },
    { id: "q2", question: "¿Se migra la data?", recommended: "sí" },
  ],
};

const settings = (overrides: Partial<InterviewSettings> = {}): InterviewSettings => ({
  channel: "http",
  host: "127.0.0.1",
  port: 0,
  directory: null,
  timeoutSeconds: 900,
  rounds: 8,
  ...overrides,
});

/** A deadline nothing fires: the tests that are not about expiry never wait. */
const neverExpires = () => ({ expired: new Promise<void>(() => undefined), cancel: () => undefined });

/** A deadline already spent, so the expiry path is exercised without real time. */
const alreadyExpired = (): Deadline => ({ expired: Promise.resolve(), cancel: () => undefined });

function deps(deadline = neverExpires): QuestionChannelDependencies {
  const { reporterFn } = captureReporter();
  return { reporter: reporterFn(true), deadline };
}

test("el canal http publica la ronda y la respuesta del operador la resuelve", async () => {
  const channel = new HttpQuestionChannel(settings(), deps());
  try {
    const idle = await fetch(`${channel.url}/round`).then((response) => response.json());
    expect(idle).toEqual({ status: "idle" });

    const asked = channel.ask(round);
    const pending = await fetch(`${channel.url}/round`).then((response) => response.json());
    expect(pending).toEqual({ status: "pending", round });

    const posted = await fetch(`${channel.url}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: 1, answers: [{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }] }),
    });
    expect(posted.status).toBe(200);

    expect(await asked).toEqual({
      round: 1,
      source: "operator",
      answers: [{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }],
    });
  } finally {
    await channel.close();
  }
});

test("el canal http sirve su página en la URL que anuncia", async () => {
  const { reporterFn, messages } = captureReporter();
  const channel = new HttpQuestionChannel(settings(), { reporter: reporterFn(true), deadline: neverExpires });
  try {
    const page = await fetch(channel.url);

    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(messages.some((message) => message.includes(channel.url))).toBeTrue();
  } finally {
    await channel.close();
  }
});

test("el canal http responde 404 a un token que no es el suyo", async () => {
  const channel = new HttpQuestionChannel(settings(), deps());
  try {
    const base = new URL(channel.url);

    expect((await fetch(`${base.origin}/i/otro-token`)).status).toBe(404);
    expect((await fetch(`${base.origin}/i/otro-token/round`)).status).toBe(404);
    expect((await fetch(base.origin)).status).toBe(404);
  } finally {
    await channel.close();
  }
});

test("el canal http rechaza una ronda que no es la que espera y una respuesta repetida", async () => {
  const channel = new HttpQuestionChannel(settings(), deps());
  try {
    const asked = channel.ask(round);
    const answers = { answers: [{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }] };

    const stale = await fetch(`${channel.url}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: 7, ...answers }),
    });
    expect(stale.status).toBe(409);

    await fetch(`${channel.url}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: 1, ...answers }),
    });
    await asked;

    const repeated = await fetch(`${channel.url}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: 1, ...answers }),
    });
    expect(repeated.status).toBe(409);
  } finally {
    await channel.close();
  }
});

test("el canal http rechaza un cuerpo sin la forma de respuestas", async () => {
  const channel = new HttpQuestionChannel(settings(), deps());
  try {
    const asked = channel.ask(round);
    const invalid = await fetch(`${channel.url}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: 1, answers: "dos" }),
    });

    expect(invalid.status).toBe(400);
    // The round is still open: a malformed post is not an answer.
    expect(await fetch(`${channel.url}/round`).then((response) => response.json())).toEqual({ status: "pending", round });
    void asked.catch(() => undefined);
  } finally {
    await channel.close();
  }
});

test("una ronda http que vence lanza el vencimiento con su número y su plazo", async () => {
  const channel = new HttpQuestionChannel(settings({ timeoutSeconds: 30 }), deps(alreadyExpired));
  try {
    await expect(channel.ask(round)).rejects.toThrow(QuestionTimeoutError);
    await expect(channel.ask(round)).rejects.toThrow("La ronda 1 no fue respondida en 30s");
  } finally {
    await channel.close();
  }
});

test("un puerto ocupado deja el canal http inutilizable antes de abrir sesión", async () => {
  const taken = new HttpQuestionChannel(settings(), deps());
  try {
    const port = new URL(taken.url).port;

    expect(() => new HttpQuestionChannel(settings({ port: Number(port) }), deps()))
      .toThrow(QuestionChannelUnavailableError);
  } finally {
    await taken.close();
  }
});

function terminal(typed: string) {
  const { reporterFn, messages } = captureReporter();
  const channel = new TerminalQuestionChannel(
    settings({ channel: "terminal" }),
    { reporter: reporterFn(true), deadline: neverExpires },
    { input: new Blob([typed]).stream(), write: () => undefined },
  );
  return { channel, messages };
}

test("el canal terminal toma lo tecleado como respuesta", async () => {
  const { channel } = terminal("dos\nno\n");
  try {
    expect(await channel.ask(round)).toEqual({
      round: 1,
      source: "operator",
      answers: [{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }],
    });
  } finally {
    await channel.close();
  }
});

test("en el canal terminal una línea vacía acepta la recomendación", async () => {
  const { channel } = terminal("\n\n");
  try {
    const answers = await channel.ask(round);

    expect(answers.source).toBe("recommended");
    expect(answers.answers).toEqual([{ id: "q1", answer: "uno" }, { id: "q2", answer: "sí" }]);
  } finally {
    await channel.close();
  }
});

test("en el canal terminal un número elige entre las opciones ofrecidas", async () => {
  const { channel, messages } = terminal("2\nno\n");
  try {
    const answers = await channel.ask(round);

    expect(answers.answers[0]).toEqual({ id: "q1", answer: "dos" });
    expect(messages.some((message) => message.includes("recomendación: uno"))).toBeTrue();
  } finally {
    await channel.close();
  }
});

test("una terminal cerrada a mitad de ronda deja el canal inutilizable", async () => {
  const { channel } = terminal("dos\n");
  try {
    await expect(channel.ask(round)).rejects.toThrow(QuestionChannelUnavailableError);
  } finally {
    await channel.close();
  }
});

test("el canal de archivos escribe la ronda y lee las respuestas que aparecen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazy-workflow-interview-"));
  const channel = new FileQuestionChannel(
    settings({ channel: "file", directory }),
    deps(),
    5,
  );
  try {
    const asked = channel.ask(round);
    // Written before the first poll returns, exactly as an external answerer would.
    await Bun.write(
      join(directory, "ronda-1.respuestas.json"),
      JSON.stringify({ answers: [{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }] }),
    );

    expect(await asked).toEqual({
      round: 1,
      source: "operator",
      answers: [{ id: "q1", answer: "dos" }, { id: "q2", answer: "no" }],
    });
    expect(await Bun.file(join(directory, "ronda-1.preguntas.json")).json()).toEqual(round);
  } finally {
    await channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("el canal de archivos no pisa la ronda de otra entrevista", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazy-workflow-interview-"));
  await Bun.write(join(directory, "ronda-1.preguntas.json"), "{}");
  const channel = new FileQuestionChannel(settings({ channel: "file", directory }), deps(), 5);
  try {
    await expect(channel.ask(round)).rejects.toThrow(QuestionChannelUnavailableError);
  } finally {
    await channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("el canal de archivos exige un directorio de intercambio", () => {
  expect(() => new FileQuestionChannel(settings({ channel: "file" }), deps()))
    .toThrow(QuestionChannelUnavailableError);
});

test("el plazo real se cancela cuando la ronda se respondió", async () => {
  const deadline = realDeadline(60_000);
  deadline.cancel();

  // A cancelled deadline never settles, so an answered round leaves nothing
  // holding the process open until its timeout would have fired.
  expect(await Promise.race([deadline.expired, Promise.resolve("cancelado")])).toBe("cancelado");
});
