import { expect, test } from "bun:test";
import type { Reporter } from "../src/output/reporter.ts";
import { openSessionStart } from "../src/output/session-event.ts";
import type { RunLogSessionEvent } from "../src/output/run-log.ts";

type Written = { kind: RunLogSessionEvent; message: string; cli?: string; sessionId: string | null };

function capturing(): { reporter: Reporter; written: Written[] } {
  const written: Written[] = [];
  const reporter = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    tracing: false,
    heading: () => undefined,
    start: () => undefined as never,
    stop: () => undefined,
    session: (kind, message, detail) => {
      written.push({ kind, message, cli: detail?.cli ?? undefined, sessionId: detail?.context?.sessionId ?? null });
    },
  } satisfies Reporter;
  return { reporter, written };
}

const rung = { cli: "opencode", model: "provider/model", variant: "high" };

test("el primer identificador que aparece escribe session_started, y los siguientes no repiten el registro", () => {
  const { reporter, written } = capturing();
  const start = openSessionStart("inicia", rung, reporter);

  start.observed(undefined);
  start.observed(null);
  expect(written).toHaveLength(0);

  start.observed("ses_primero");
  start.observed("ses_segundo");

  expect(written).toEqual([{ kind: "session_started", message: "inicia", cli: "opencode", sessionId: "ses_primero" }]);
});

test("una sesion reanudada escribe su session_started antes de que el stream hable", () => {
  const { reporter, written } = capturing();
  const start = openSessionStart("inicia", rung, reporter, "ses_reanudada");

  expect(written).toHaveLength(1);
  expect(written[0]?.sessionId).toBe("ses_reanudada");

  start.observed("ses_del_stream");
  start.settle();

  expect(written).toHaveLength(1);
});

test("settle deja el registro de una sesion que murio sin nombrarse, y es idempotente", () => {
  const { reporter, written } = capturing();
  const start = openSessionStart("inicia", rung, reporter);

  start.settle();
  start.settle();

  expect(written).toEqual([{ kind: "session_started", message: "inicia", cli: "opencode", sessionId: null }]);
});

test("settle no escribe nada cuando el stream ya nombro la sesion", () => {
  const { reporter, written } = capturing();
  const start = openSessionStart("inicia", rung, reporter);

  start.observed("ses_nombrada");
  start.settle();

  expect(written).toHaveLength(1);
  expect(written[0]?.sessionId).toBe("ses_nombrada");
});
