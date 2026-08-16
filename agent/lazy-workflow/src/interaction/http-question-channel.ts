/**
 * The browser channel: the coordinator serves the pending round on loopback and
 * waits for the operator to answer it.
 *
 * The server belongs to the coordinator process, not to the session, so it is
 * bound before the session opens. An unusable port is then an argument-shaped
 * failure that costs no model usage, and the URL is already printed while the
 * agent is still thinking about its first question.
 */

import { completeAnswers, unknownAnswerIds, type PlanAnswer, type QuestionAnswers, type QuestionRound } from "./question-round.ts";
import {
  QuestionChannelUnavailableError,
  withRoundDeadline,
  type InterviewSettings,
  type QuestionChannel,
  type QuestionChannelDependencies,
} from "./question-channel.ts";

/** The subset of `Bun.serve` this channel uses; injected so a test can fake it. */
export type HttpServer = {
  port: number;
  hostname: string;
  stop(closeActiveConnections?: boolean): void;
};

export type HttpServeFn = (options: {
  hostname: string;
  port: number;
  fetch: (request: Request) => Promise<Response>;
}) => HttpServer;

interface Waiting {
  round: QuestionRound;
  resolve: (answers: QuestionAnswers) => void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * The page is one self-contained string: no bundler, no assets, no network. A
 * planning interview must work on a machine that can reach nothing but itself.
 */
function page(token: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lazy-workflow · preguntas del plan</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2rem 1rem; font: 16px/1.55 system-ui, sans-serif;
         background: #1a1b26; color: #a9b1d6; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.1rem; color: #bb9af7; letter-spacing: .04em; text-transform: uppercase; }
  .q { background: #24283b; border: 1px solid #414868; border-radius: 8px;
       padding: 1rem 1.15rem; margin: 1rem 0; }
  .q p.text { margin: 0 0 .5rem; color: #c0caf5; font-weight: 600; }
  .q p.why { margin: 0 0 .75rem; color: #565f89; font-size: .9rem; }
  label { display: block; font-size: .8rem; color: #7aa2f7; margin-bottom: .3rem; }
  textarea, select { width: 100%; box-sizing: border-box; background: #1a1b26; color: #a9b1d6;
                     border: 1px solid #414868; border-radius: 6px; padding: .55rem .7rem;
                     font: inherit; font-size: .95rem; }
  textarea { min-height: 4.5rem; resize: vertical; }
  select { margin-bottom: .5rem; }
  button { background: #7aa2f7; color: #1a1b26; border: 0; border-radius: 6px;
           padding: .6rem 1.4rem; font: inherit; font-weight: 600; cursor: pointer; }
  .note { color: #565f89; font-size: .9rem; }
  .done { color: #9ece6a; }
  .error { color: #f7768e; }
</style>
</head>
<body>
<main>
  <h1>lazy-workflow · preguntas del plan</h1>
  <div id="status" class="note">Esperando la primera ronda…</div>
  <form id="form" hidden></form>
</main>
<script>
const token = ${JSON.stringify(token)};
const statusEl = document.getElementById("status");
const form = document.getElementById("form");
let current = null;

function render(round) {
  current = round;
  statusEl.textContent = "Ronda " + round.round + " · " + round.questions.length + " pregunta(s). " +
    "Lo prellenado es la recomendación del agente; envíalo tal cual para aceptarla.";
  statusEl.className = "note";
  form.innerHTML = round.questions.map(function (q, i) {
    const options = (q.options || []).map(function (o) {
      return '<option value="' + escapeAttr(o) + '">' + escapeText(o) + "</option>";
    }).join("");
    return '<div class="q">' +
      '<p class="text">' + (i + 1) + ". " + escapeText(q.question) + "</p>" +
      (q.rationale ? '<p class="why">' + escapeText(q.rationale) + "</p>" : "") +
      (options ? '<label>Opciones</label><select data-fills="' + escapeAttr(q.id) + '">' +
        '<option value="">— escribir libremente —</option>' + options + "</select>" : "") +
      '<label>Tu respuesta</label>' +
      '<textarea name="' + escapeAttr(q.id) + '">' + escapeText(q.recommended) + "</textarea>" +
      "</div>";
  }).join("") + '<button type="submit">Enviar respuestas</button>';
  form.hidden = false;
  form.querySelectorAll("select[data-fills]").forEach(function (select) {
    select.addEventListener("change", function () {
      if (!select.value) return;
      form.querySelector('textarea[name="' + cssEscape(select.dataset.fills) + '"]').value = select.value;
    });
  });
}

function escapeText(value) { const d = document.createElement("div"); d.textContent = value; return d.innerHTML; }
function escapeAttr(value) { return escapeText(value).replaceAll('"', "&quot;"); }
function cssEscape(value) { return window.CSS && CSS.escape ? CSS.escape(value) : value; }

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  const data = new FormData(form);
  const answers = current.questions.map(function (q) {
    return { id: q.id, answer: String(data.get(q.id) || "") };
  });
  const response = await fetch("/i/" + token + "/answers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ round: current.round, answers: answers }),
  });
  if (response.ok) {
    form.hidden = true;
    current = null;
    statusEl.className = "done";
    statusEl.textContent = "Respuestas enviadas. La sesión continúa; deja esta pestaña abierta para la próxima ronda.";
    poll();
    return;
  }
  statusEl.className = "error";
  statusEl.textContent = "No se pudieron enviar: " + (await response.text());
});

async function poll() {
  while (true) {
    try {
      const response = await fetch("/i/" + token + "/round");
      if (!response.ok) throw new Error(await response.text());
      const body = await response.json();
      if (body.status === "closed") {
        form.hidden = true;
        statusEl.className = "note";
        statusEl.textContent = "La planificación terminó. Puedes cerrar esta pestaña.";
        return;
      }
      if (body.status === "pending" && (!current || current.round !== body.round.round)) render(body.round);
      if (body.status === "idle" && !current) {
        statusEl.className = "note";
        statusEl.textContent = "Sin preguntas por ahora; el agente está trabajando…";
      }
    } catch (error) {
      statusEl.className = "error";
      statusEl.textContent = "Sin conexión con lazy-workflow: " + error.message;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 1000); });
  }
}

poll();
</script>
</body>
</html>`;
}

export class HttpQuestionChannel implements QuestionChannel {
  readonly kind = "http" as const;

  private readonly server: HttpServer;
  private readonly token: string;
  private waiting: Waiting | null = null;
  /** Rounds already answered, so a resubmitted form is rejected, not replayed. */
  private readonly answered = new Set<number>();
  private closed = false;

  constructor(
    private readonly settings: InterviewSettings,
    private readonly deps: QuestionChannelDependencies,
    serve: HttpServeFn = Bun.serve as unknown as HttpServeFn,
    token: string = crypto.randomUUID(),
  ) {
    this.token = token;
    try {
      this.server = serve({
        hostname: settings.host,
        port: settings.port,
        fetch: (request) => this.handle(request),
      });
    } catch (error) {
      throw new QuestionChannelUnavailableError(
        `No se pudo abrir el canal HTTP de preguntas en ${settings.host}:${settings.port}: `
        + `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    this.deps.reporter.info(`Responde las preguntas del plan en ${this.url}`);
    if (!isLoopback(settings.host)) {
      this.deps.reporter.warn(
        `El canal de preguntas escucha en ${settings.host}, fuera de loopback: la URL con su token es la única credencial.`,
      );
    }
  }

  get url(): string {
    const host = this.server.hostname === "0.0.0.0" || this.server.hostname === "::"
      ? "127.0.0.1"
      : this.server.hostname;
    return `http://${host.includes(":") ? `[${host}]` : host}:${this.server.port}/i/${this.token}`;
  }

  async ask(round: QuestionRound): Promise<QuestionAnswers> {
    if (this.closed) throw new QuestionChannelUnavailableError("El canal HTTP de preguntas ya fue cerrado");
    const answers = new Promise<QuestionAnswers>((resolve) => {
      this.waiting = { round, resolve };
    });
    this.deps.reporter.info(`Ronda ${round.round} publicada en ${this.url}`);
    try {
      return await withRoundDeadline(round, this.settings.timeoutSeconds, this.deps.deadline, answers);
    } finally {
      this.waiting = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.waiting = null;
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const base = `/i/${this.token}`;
    // An unknown token is indistinguishable from an unknown path on purpose: a
    // 404 says nothing about whether an interview is running here.
    if (path !== base && !path.startsWith(`${base}/`)) return new Response("No encontrado", { status: 404 });

    const rest = path.slice(base.length);
    if (rest === "" || rest === "/") return new Response(page(this.token), { headers: HTML_HEADERS });
    if (rest === "/round" && request.method === "GET") return this.roundResponse();
    if (rest === "/answers" && request.method === "POST") return this.answersResponse(request);
    return new Response("No encontrado", { status: 404 });
  }

  private roundResponse(): Response {
    if (this.closed) return json({ status: "closed" });
    if (!this.waiting) return json({ status: "idle" });
    return json({ status: "pending", round: this.waiting.round });
  }

  private async answersResponse(request: Request): Promise<Response> {
    const waiting = this.waiting;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "El cuerpo no es JSON válido" }, 400);
    }
    const round = (body as { round?: unknown })?.round;
    const given = (body as { answers?: unknown })?.answers;
    if (typeof round !== "number") return json({ error: "El cuerpo debe declarar la ronda" }, 400);
    if (!Array.isArray(given) || given.some((answer) => typeof answer?.id !== "string")) {
      return json({ error: "El cuerpo debe traer answers: [{id, answer}]" }, 400);
    }
    if (this.answered.has(round)) return json({ error: `La ronda ${round} ya fue respondida` }, 409);
    if (!waiting || waiting.round.round !== round) {
      return json({ error: `La ronda ${round} no es la que está esperando respuesta` }, 409);
    }
    const unknown = unknownAnswerIds(waiting.round, given as PlanAnswer[]);
    if (unknown.length > 0) {
      this.deps.reporter.warn(`Se descartan respuestas a preguntas que la ronda no hizo: ${unknown.join(", ")}`);
    }
    this.answered.add(round);
    waiting.resolve(completeAnswers(waiting.round, given as PlanAnswer[]));
    return json({ status: "ok" });
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
