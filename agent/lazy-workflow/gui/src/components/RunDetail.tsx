import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl, isDesktop } from "../lib/platform.ts";
import { WebInterview } from "./WebInterview.tsx";
import { finalMarker, interviewUrl, operatorFeed, parseStdout, runLogPointer } from "../lib/output.ts";
import { formatDuration } from "../lib/history.ts";
import { isFinished, type RunState, type RunStatus } from "../lib/runs.ts";
import { runTitle } from "../lib/work.ts";

export const STATUS: Record<RunStatus, string> = {
  running: "En curso",
  cancelling: "Interrumpiendo",
  success: "Completado",
  failure: "Falló",
  interrupted: "Interrumpido",
  error: "Error",
};

/** The interview's own address is the panel below, not something to read. */
const INTERVIEW_LINE = /\/api\/interviews\/|https?:\/\/[^\s]+:\d+\/i\//;

export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function InterviewPanel({ url }: { url: string }) {
  const [embedded, setEmbedded] = useState(!isDesktop);
  return (
    <section className="interview" aria-label="Preguntas del plan">
      <div className="row wrap">
        <strong className="grow">El plan espera tus respuestas.</strong>
        {isDesktop && <button type="button" className="button primary" onClick={() => openUrl(url)}>Abrir en el navegador</button>}
        {isDesktop && <button type="button" className="button" onClick={() => setEmbedded(!embedded)}>{embedded ? "Ocultar" : "Responder aquí"}</button>}
      </div>
      {embedded && (isDesktop ? <iframe className="interview-frame" src={url} title="Preguntas del plan" /> : <WebInterview path={url} />)}
    </section>
  );
}

/** The run's progress as a feed that follows its end while the operator has not scrolled up. */
function Feed({ run }: { run: RunState }) {
  const entries = useMemo(() => operatorFeed(run.stderr).filter((entry) => !INTERVIEW_LINE.test(entry.text)), [run.stderr]);
  const ref = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [entries]);
  if (entries.length === 0) return <p className="muted small">{isFinished(run) ? "La ejecución no informó progreso." : "Iniciando…"}</p>;
  return (
    <ol ref={ref} className="feed" onScroll={(event) => {
      const element = event.currentTarget;
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    }}>
      {entries.map((entry, index) => (
        <li key={index} className={`feed-${entry.level}`}>
          {entry.time && <time>{entry.time}</time>}
          <span>{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** What the run answered on stdout: a setup report is read as is; a plan's JSON stays out of the way. */
function Result({ run }: { run: RunState }) {
  const parsed = useMemo(() => parseStdout(run.stdout), [run.stdout]);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "json") {
    return (
      <details className="result-json">
        <summary>Resultado técnico</summary>
        <pre>{JSON.stringify(parsed.value, null, 2)}</pre>
      </details>
    );
  }
  return <section className="result-text" aria-label="Resultado"><h3>Resultado</h3><pre>{parsed.text}</pre></section>;
}

interface RunDetailProps {
  readonly run: RunState;
  readonly onBack: () => void;
  readonly onCancel: () => void;
  readonly onRerun: () => void;
  readonly onOpenHistory: (runId: string) => void;
}

export function RunDetail({ run, onBack, onCancel, onRerun, onOpenHistory }: RunDetailProps) {
  const finished = isFinished(run);
  const now = useNow(!finished);
  const duration = run.exit ? run.exit.durationMs : now - run.startedAt;
  const interview = !finished ? interviewUrl(run.stderr) : null;
  const pointer = finished ? runLogPointer(run.stderr) : null;
  const marker = finalMarker(run.stdout);
  return (
    <article className="panel-card run-detail">
      <header className="panel-header">
        <button type="button" className="link-button back" aria-label="Volver a las ejecuciones" onClick={onBack}>← Ejecuciones</button>
        <div className="grow">
          <div className="entry-line">
            <span className={`status status-${run.status}`}>{STATUS[run.status]}</span>
            <span className="muted small">{formatDuration(duration)}</span>
            {marker && <span className="state-chip">{marker}</span>}
          </div>
          <h2>{runTitle(run.command, run.args)}</h2>
        </div>
        {!finished && <button type="button" className="button warn" onClick={onCancel} title="Primero Ctrl-C; un segundo clic fuerza la terminación">{run.status === "cancelling" ? "Forzar" : "Interrumpir"}</button>}
        {finished && <button type="button" className="button" onClick={onRerun}>Repetir</button>}
      </header>
      {run.exit?.error && <div className="callout error">{run.exit.error}</div>}
      {pointer && <div className="callout error">La ejecución falló. <button type="button" className="link-button" onClick={() => onOpenHistory(pointer.runId)}>Ver qué pasó</button></div>}
      {interview && <InterviewPanel url={interview} />}
      <Result run={run} />
      <section className="panel-section">
        <h3>Progreso</h3>
        {run.dropped > 0 && <p className="muted small">Se omitieron {run.dropped} líneas antiguas.</p>}
        <Feed run={run} />
      </section>
    </article>
  );
}
