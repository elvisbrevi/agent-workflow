import { useEffect, useState } from "react";
import { revealItemInDir, isDesktop } from "../lib/platform.ts";
import type { RunLogDocument } from "../lib/backend.ts";
import { formatDuration, type HistoryOutcome, type HistoryRun } from "../lib/history.ts";
import { cliLabel } from "../lib/models.ts";
import { interviewUrl, operatorFeed } from "../lib/output.ts";
import { isFinished, type RunState } from "../lib/runs.ts";
import { historyLabel, repositoryName, runTitle } from "../lib/work.ts";
import { RunDetail, STATUS, useNow } from "./RunDetail.tsx";

const OUTCOMES: Record<HistoryOutcome, string> = { success: "Completado", failure: "Falló", interrupted: "Interrumpido", unfinished: "Sin cierre" };
/** The runs an operator follows; the tools a workflow calls internally stay in the run log. */
const WORKFLOWS = new Set(["plan", "code", "setup"]);

interface ActivityViewProps {
  readonly runs: readonly RunState[];
  readonly history: { document: RunLogDocument | null; runs: HistoryRun[]; error: string | null; refresh: () => void };
  /** The window's run whose progress is open, if any. */
  readonly selected: number | null;
  /** A run-log run to open expanded. */
  readonly focusRunId: string | null;
  readonly onSelect: (id: number | null) => void;
  readonly onCancel: (id: number) => void;
  readonly onRerun: (run: RunState) => void;
  readonly onDismiss: (id: number) => void;
  readonly onOpenHistory: (runId: string) => void;
}

/** Where the run is: its latest line, or why it ended. */
function latest(run: RunState): string {
  if (interviewUrl(run.stderr) && !isFinished(run)) return "Espera tus respuestas";
  const last = operatorFeed(run.stderr).at(-1)?.text.split("\n")[0];
  return isFinished(run) ? STATUS[run.status] : last ?? "Iniciando…";
}

function SessionRun({ run, now, selected, onSelect, onDismiss }: { run: RunState; now: number; selected: boolean; onSelect: () => void; onDismiss: () => void }) {
  const finished = isFinished(run);
  return (
    <li className={`session-run${selected ? " selected" : ""}`}>
      <button type="button" className="session-run-body" aria-pressed={selected} onClick={onSelect}>
        <span className={`status-dot status-${run.status}`}>●</span>
        <span className="grow">
          <strong>{runTitle(run.command, run.args)}</strong>
          <span className={`small ellipsis ${interviewUrl(run.stderr) && !finished ? "attention" : "muted"}`}>{latest(run)}</span>
        </span>
        <span className="muted small nowrap">{formatDuration(run.exit ? run.exit.durationMs : now - run.startedAt)}</span>
      </button>
      {finished && <button type="button" className="icon-button" aria-label="Quitar de la lista" onClick={onDismiss}>✕</button>}
    </li>
  );
}

function HistoryRow({ run, expanded, onToggle }: { run: HistoryRun; expanded: boolean; onToggle: () => void }) {
  const repository = String(run.context.repository ?? "").split(",").filter(Boolean).map(repositoryName).join(", ");
  return (
    <li className={`history-item${expanded ? " expanded" : ""}`}>
      <button type="button" className="history-summary" aria-expanded={expanded} onClick={onToggle}>
        <span className={`status-dot outcome-${run.outcome}`}>●</span>
        <span className="grow">
          <strong>{historyLabel(run)}</strong>
          <span className="muted small">{[repository, `${cliLabel(run.cli)} · ${run.model}`, new Date(run.startedAt).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" })].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="history-outcome">
          <span className={`outcome outcome-${run.outcome}`}>{OUTCOMES[run.outcome]}</span>
          <span className="muted small nowrap">{formatDuration(run.durationMs)}</span>
        </span>
      </button>
      {expanded && (
        <div className="history-detail">
          {run.events.length === 0
            ? <p className="muted small">{run.outcome === "success" ? "Terminó sin avisos." : "No dejó avisos registrados."}</p>
            : <ul className="events">{run.events.map((event, index) => (
              <li key={index} className={`event event-${event.severity}`}>
                <span className="mono small nowrap">{new Date(event.ts).toLocaleTimeString("es-CL")}</span>
                <span className="grow">{event.message}</span>
              </li>
            ))}</ul>}
        </div>
      )}
    </li>
  );
}

export function ActivityView({ runs, history, selected, focusRunId, onSelect, onCancel, onRerun, onDismiss, onOpenHistory }: ActivityViewProps) {
  const [expanded, setExpanded] = useState<string | null>(focusRunId);
  const [filter, setFilter] = useState<HistoryOutcome | "all">("all");
  const [query, setQuery] = useState("");
  const [everything, setEverything] = useState(false);
  const live = runs.some((run) => !isFinished(run));
  const now = useNow(live);
  const session = [...runs].sort((a, b) => Number(isFinished(a)) - Number(isFinished(b)) || b.startedAt - a.startedAt);
  const open = runs.find((run) => run.id === selected) ?? null;
  useEffect(() => { if (focusRunId) setExpanded(focusRunId); }, [focusRunId]);
  useEffect(() => { history.refresh(); }, []);
  // On a phone the run replaces the list; it opens at its own top.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1050px)").matches) document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [selected]);

  const needle = query.trim().toLowerCase();
  const visible = history.runs.filter((run) => (everything || WORKFLOWS.has(run.command))
    && (filter === "all" || run.outcome === filter)
    && (!needle || `${historyLabel(run)} ${run.context.repository ?? ""} ${run.model} ${run.events.map((event) => event.message).join(" ")}`.toLowerCase().includes(needle)));

  return (
    <div className={`page activity-page${open ? " panel-open" : ""}`}>
      <header className="work-toolbar"><h1 className="grow">Ejecuciones</h1><button type="button" className="button" aria-label="Actualizar ejecuciones" onClick={history.refresh}>↻</button></header>
      <div className={`work-layout${open ? " has-panel" : ""}`}>
        <div className="work-list">
          {session.length > 0 && (
            <section className="panel-card">
              <h2>En esta sesión</h2>
              <ul className="session-runs">
                {session.map((run) => <SessionRun key={run.id} run={run} now={now} selected={run.id === selected} onSelect={() => onSelect(run.id)} onDismiss={() => onDismiss(run.id)} />)}
              </ul>
            </section>
          )}
          <section className="panel-card">
            <div className="row wrap">
              <h2 className="grow">Historial</h2>
              <input className="input search" type="search" aria-label="Buscar en el historial" placeholder="HU, issue, repositorio…" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="input tracker-filter" aria-label="Filtrar por resultado" value={filter} onChange={(event) => setFilter(event.target.value as HistoryOutcome | "all")}>
                <option value="all">Todos</option>
                {Object.entries(OUTCOMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            {history.error && <p className="read-errors">{history.error}</p>}
            {history.document && !history.document.exists && <p className="muted small">Aún no hay ejecuciones registradas.</p>}
            <ul className="history-list">
              {visible.slice(0, 200).map((run) => (
                <HistoryRow key={run.runId} run={run} expanded={expanded === run.runId} onToggle={() => setExpanded(expanded === run.runId ? null : run.runId)} />
              ))}
            </ul>
            {history.document?.exists && visible.length === 0 && <p className="muted small">No hay ejecuciones que coincidan.</p>}
            <div className="row wrap muted small">
              <label className="toggle"><input type="checkbox" checked={everything} onChange={(event) => setEverything(event.target.checked)} /><span>Incluir consultas internas</span></label>
              {history.document?.exists && isDesktop && <button type="button" className="link-button small" onClick={() => void revealItemInDir(history.document!.path)}>Mostrar el registro</button>}
            </div>
          </section>
        </div>
        <aside className="work-panel" aria-label="Progreso">
          {open
            ? <RunDetail key={open.id} run={open} onBack={() => onSelect(null)} onCancel={() => onCancel(open.id)} onRerun={() => onRerun(open)} onOpenHistory={onOpenHistory} />
            : <div className="panel-card panel-empty"><p className="muted">{session.length ? "Elige una ejecución de esta sesión para ver su progreso." : "Las ejecuciones que lances aparecerán aquí con su progreso."}</p></div>}
        </aside>
      </div>
    </div>
  );
}
