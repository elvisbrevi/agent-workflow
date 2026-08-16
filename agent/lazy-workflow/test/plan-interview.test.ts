import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import { AgentExhaustionError, type AgentRunOptions } from "../src/coding-agent/coding-agent.ts";
import { PLAN_READY_MARKER, QUESTIONS_PENDING_MARKER } from "../src/prompts/workflow-contract.ts";
import type { QuestionChannelFactory } from "../src/interaction/create-question-channel.ts";
import type { QuestionChannel } from "../src/interaction/question-channel.ts";
import { completeAnswers, type QuestionAnswers, type QuestionRound } from "../src/interaction/question-round.ts";
import { captureReporter } from "./_helpers/reporter-capture.ts";

const round = (n: number): QuestionRound => ({
  round: n,
  questions: [{ id: `q${n}`, question: `¿decisión ${n}?`, recommended: `recomendada ${n}` }],
});

function pending(n: number): string {
  return `avanzo con la planificación\n${QUESTIONS_PENDING_MARKER}\n${JSON.stringify(round(n))}`;
}

const planReady = `${PLAN_READY_MARKER}\n${JSON.stringify({ tickets: [] })}`;

function agentResult(text: string, sessionId = "ses_plan"): AgentResult {
  return new AgentResult({ sessionId, text });
}

interface Resumed {
  sessionId: string;
  prompt: string;
  workingDirectory?: string;
  terminalMarker?: string;
}

/**
 * A planning agent that answers with the given texts in order: the first is the
 * run's own result and every later one is what a resume returns.
 */
function scriptedAgent(texts: string[]) {
  const resumes: Resumed[] = [];
  const runs: AgentRunOptions[] = [];
  let next = 1;
  return {
    resumes,
    runs,
    agent: {
      run: async (options: AgentRunOptions) => {
        runs.push(options);
        return { result: agentResult(texts[0]!), azureLoginRequired: false, failed: false };
      },
      resume: async (sessionId: string, prompt?: string, workingDirectory?: string, terminalMarker?: string) => {
        resumes.push({ sessionId, prompt: prompt ?? "", workingDirectory, terminalMarker });
        const text = texts[next] ?? planReady;
        next += 1;
        return agentResult(text);
      },
    },
  };
}

/** A channel that answers each round from a script, recording what it was asked. */
function scriptedChannel(answers: (round: QuestionRound) => QuestionAnswers | Promise<QuestionAnswers>) {
  const asked: QuestionRound[] = [];
  let closed = 0;
  const channel: QuestionChannel = {
    kind: "http",
    ask: async (round) => {
      asked.push(round);
      return answers(round);
    },
    close: async () => { closed += 1; },
  };
  return { asked, channel, closed: () => closed, factory: (() => channel) as QuestionChannelFactory };
}

const huInfoService = {
  getHuInfo: async () => new HuInfo({ id: 12345, title: "HU de prueba" }),
  waitForAccess: async () => undefined,
};

function planCli(
  agent: ReturnType<typeof scriptedAgent>["agent"],
  factory: QuestionChannelFactory,
  reporterFn: ReturnType<typeof captureReporter>["reporterFn"],
): LazyWorkflowCli {
  return new LazyWorkflowCli(
    huInfoService,
    agent,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    reporterFn,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    factory,
  );
}

async function withCapturedStdout<T>(action: () => Promise<T>): Promise<{ value: T; output: string[] }> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    return { value: await action(), output };
  } finally {
    console.log = originalLog;
  }
}

test("sin --interview una ronda de preguntas no reanuda nada", async () => {
  const { agent, resumes } = scriptedAgent([pending(1)]);
  const { reporterFn } = captureReporter();
  let channelsBuilt = 0;
  const factory: QuestionChannelFactory = () => {
    channelsBuilt += 1;
    return null;
  };

  const { value } = await withCapturedStdout(() =>
    planCli(agent, factory, reporterFn).run(["plan", "--working-directory", "/repo"]));

  expect(value).toBe(0);
  expect(resumes).toEqual([]);
  expect(channelsBuilt).toBe(1);
});

test("una ronda se responde y la misma sesión se reanuda con las respuestas", async () => {
  const { agent, resumes, runs } = scriptedAgent([pending(1), planReady]);
  const { channel, asked } = scriptedChannel((round) => completeAnswers(round, [{ id: "q1", answer: "decidido" }]));
  const { reporterFn } = captureReporter();

  const { value } = await withCapturedStdout(() =>
    planCli(agent, () => channel, reporterFn).run([
      "plan", "--interview", "http", "--working-directory", "/repo",
    ]));

  expect(value).toBe(0);
  expect(asked).toEqual([round(1)]);
  expect(resumes).toHaveLength(1);
  expect(resumes[0]?.sessionId).toBe("ses_plan");
  expect(resumes[0]?.workingDirectory).toBe("/repo");
  // A terminal marker would close the very session the next round must resume.
  expect(resumes[0]?.terminalMarker).toBeUndefined();
  expect(resumes[0]?.prompt).toContain("QUESTIONS_ANSWERED");
  expect(resumes[0]?.prompt).toContain("decidido");
  expect(resumes[0]?.prompt).toContain('"source":"operator"');
  expect(runs[0]?.prompt).toContain("An operator is available to answer questions");
});

test("la entrevista encadena rondas hasta que el plan queda listo", async () => {
  const { agent, resumes } = scriptedAgent([pending(1), pending(2), planReady]);
  const { channel, asked } = scriptedChannel((round) => completeAnswers(round, []));
  const { reporterFn } = captureReporter();

  const { value } = await withCapturedStdout(() =>
    planCli(agent, () => channel, reporterFn).run([
      "plan", "--interview", "http", "--working-directory", "/repo",
    ]));

  expect(value).toBe(0);
  expect(asked.map(({ round }) => round)).toEqual([1, 2]);
  expect(resumes).toHaveLength(2);
});

test("una ronda vencida sigue con las recomendaciones de la sesión", async () => {
  const { agent, resumes } = scriptedAgent([pending(1), planReady]);
  const { reporterFn, messages } = captureReporter();
  const channel: QuestionChannel = {
    kind: "http",
    ask: async () => { throw new Error("La ronda 1 no fue respondida en 30s"); },
    close: async () => undefined,
  };

  const { value } = await withCapturedStdout(() =>
    planCli(agent, () => channel, reporterFn).run([
      "plan", "--interview", "http", "--working-directory", "/repo",
    ]));

  expect(value).toBe(0);
  expect(resumes[0]?.prompt).toContain('"source":"recommended"');
  expect(resumes[0]?.prompt).toContain("recomendada 1");
  expect(messages.some((message) => message.includes("se aceptan las respuestas recomendadas"))).toBeTrue();
});

test("con el tope de rondas agotado se exige el plan final y otra ronda detiene la corrida", async () => {
  const { agent, resumes } = scriptedAgent([pending(1), pending(2)]);
  const { channel } = scriptedChannel((round) => completeAnswers(round, []));
  const { reporterFn, messages } = captureReporter();

  const { value } = await withCapturedStdout(() =>
    planCli(agent, () => channel, reporterFn).run([
      "plan", "--interview", "http", "--interview-rounds", "1", "--working-directory", "/repo",
    ]));

  expect(value).toBe(1);
  expect(resumes).toHaveLength(1);
  expect(resumes[0]?.prompt).toContain("No quedan rondas de preguntas");
  expect(messages.some((message) => message.includes("abrió otra ronda con el tope"))).toBeTrue();
});

test("una ronda malformada detiene la corrida sin reanudar la sesión", async () => {
  const { agent, resumes } = scriptedAgent([`${QUESTIONS_PENDING_MARKER}\n{"round":1,`]);
  const { channel, asked } = scriptedChannel((round) => completeAnswers(round, []));
  const { reporterFn, messages } = captureReporter();

  const { value } = await withCapturedStdout(() =>
    planCli(agent, () => channel, reporterFn).run([
      "plan", "--interview", "http", "--working-directory", "/repo",
    ]));

  expect(value).toBe(1);
  expect(asked).toEqual([]);
  expect(resumes).toEqual([]);
  expect(messages.some((message) => message.includes("la ronda de preguntas no se pudo leer"))).toBeTrue();
});

test("un proveedor agotado a mitad de entrevista detiene la corrida con el resultado parcial", async () => {
  const partial = agentResult("lo que alcanzó a decir");
  const { reporterFn, messages } = captureReporter();
  const agent = {
    run: async () => ({ result: agentResult(pending(1)), azureLoginRequired: false, failed: false }),
    resume: async () => {
      throw new AgentExhaustionError({ cli: "OpenCode", model: "m", cause: "rate_limit" }, partial);
    },
  };
  const { channel } = scriptedChannel((round) => completeAnswers(round, []));

  const { value, output } = await withCapturedStdout(() =>
    planCli(agent, () => channel, reporterFn).run([
      "plan", "--interview", "http", "--working-directory", "/repo",
    ]));

  expect(value).toBe(1);
  expect(output).toEqual([JSON.stringify(partial, null, 2)]);
  expect(messages.some((message) => message.includes("agotó al proveedor"))).toBeTrue();
});

test("el canal se cierra aunque la entrevista termine mal", async () => {
  const { agent } = scriptedAgent([`${QUESTIONS_PENDING_MARKER}\nsin json`]);
  const { channel, closed } = scriptedChannel((round) => completeAnswers(round, []));
  const { reporterFn } = captureReporter();

  await withCapturedStdout(() =>
    planCli(agent, () => channel, reporterFn).run([
      "plan", "--interview", "http", "--working-directory", "/repo",
    ]));

  expect(closed()).toBe(1);
});

test("la entrevista de una HU publica el plan que cierra la última ronda", async () => {
  const tickets = { tickets: [{ type: "Task", title: "Slice uno", body: "cuerpo", blockedBy: [] }] };
  const { agent, resumes } = scriptedAgent([pending(1), `${PLAN_READY_MARKER}\n${JSON.stringify(tickets)}`]);
  const { channel } = scriptedChannel((round) => completeAnswers(round, [{ id: "q1", answer: "decidido" }]));
  const { reporterFn } = captureReporter();
  const created: string[] = [];
  const azure = {
    ...huInfoService,
    createTicket: async (input: { hu: number; type: string; title: string }) => {
      created.push(input.title);
      return { hu: input.hu, ticket: 23459, type: input.type, title: input.title, created: true };
    },
    linkPredecessor: async (blocker: number, blocked: number) => ({ blocker, blocked, linked: true }),
  };
  const cli = new LazyWorkflowCli(
    azure as never,
    agent,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    reporterFn,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    () => channel,
  );

  const { value } = await withCapturedStdout(() =>
    cli.run(["plan", "--hu", "12345", "--interview", "http", "--working-directory", "/repo"]));

  expect(value).toBe(0);
  expect(resumes).toHaveLength(1);
  expect(created).toEqual(["Slice uno"]);
});

test("--interview solo aplica a plan y no convive con --quiet", async () => {
  const { agent, runs } = scriptedAgent([planReady]);
  const { reporterFn, messages } = captureReporter();

  const wrongCommand = await planCli(agent, () => null, reporterFn)
    .run(["code", "--interview", "http", "--working-directory", "/repo"]);
  const silent = await planCli(agent, () => null, reporterFn)
    .run(["plan", "--interview", "http", "--quiet", "--working-directory", "/repo"]);

  expect(wrongCommand).toBe(1);
  expect(silent).toBe(1);
  expect(runs).toEqual([]);
  expect(messages.some((message) => message.includes("--interview solo se permite con plan"))).toBeTrue();
  expect(messages.some((message) => message.includes("--interview y --quiet son mutuamente excluyentes"))).toBeTrue();
});
