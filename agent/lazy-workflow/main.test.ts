import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "./main.ts";
import { HuInfo } from "./hu-info.ts";
import { OpenCodeResult } from "./open-code-result.ts";
import type { OpenCodeRunOptions } from "./open-code-service.ts";

test("HuInfo expone sus campos", () => {
  const huInfo = new HuInfo({
    id: 23438,
    title: "Nueva HU",
    state: "New",
  });

  expect(huInfo.id).toBe(23438);
  expect(huInfo.title).toBe("Nueva HU");
  expect(huInfo.state).toBe("New");
});

test("el comando hu-info obtiene y muestra la HU solicitada", async () => {
  let requestedHu = 0;
  const huInfo = new HuInfo({ id: 12345, title: "HU de prueba" });
  const service = {
    getHuInfo: async (hu: number) => {
      requestedHu = hu;
      return huInfo;
    },
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await new LazyWorkflowCli(service).run(["hu-info", "--hu", "12345"]);
  } finally {
    console.log = originalLog;
  }

  expect(requestedHu).toBe(12345);
  expect(output).toEqual([JSON.stringify(huInfo, null, 2)]);
});

test("OpenCodeResult normaliza la salida JSONL", () => {
  const result = OpenCodeResult.fromJsonLines([
    JSON.stringify({
      type: "step_start",
      sessionID: "ses_test",
      part: { type: "step-start" },
    }),
    JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: { type: "text", text: "4" },
    }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_test",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: { total: 10, input: 8, output: 1, reasoning: 1 },
        cost: 0.01,
      },
    }),
  ].join("\n"));

  expect(result.sessionId).toBe("ses_test");
  expect(result.text).toBe("4");
  expect(result.reason).toBe("stop");
  expect(result.tokens?.total).toBe(10);
  expect(result.cost).toBe(0.01);
});

test("main imprime OpenCode con formato JSON legible", async () => {
  const result = OpenCodeResult.fromJsonLines(
    JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: { type: "text", text: "respuesta" },
    }),
  );
  const receivedOptions: { value: OpenCodeRunOptions | null } = { value: null };
  const service = {
    run: async (options: OpenCodeRunOptions) => {
      receivedOptions.value = options;
      return result;
    },
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await new LazyWorkflowCli(undefined, service).run([
      "--model",
      "modelo-test",
      "--prompt",
      "pregunta-test",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(receivedOptions.value?.model).toBe("modelo-test");
  expect(receivedOptions.value?.prompt).toBe("pregunta-test");
  expect(output).toEqual([JSON.stringify(result, null, 2)]);
});
