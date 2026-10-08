import { useCallback, useEffect, useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { backend, errorText, type RunLogDocument } from "../lib/backend.ts";
import { foldRuns, formatDuration, type HistoryOutcome, type HistoryRun } from "../lib/history.ts";

const OUTCOMES: Record<HistoryOutcome, string> = {
  success: "Exito",
  failure: "Fallo",
  interrupted: "Interrumpido",
  unfinished: "Sin cierre",
};

function RunRow({ run, expanded, onToggle }: { run: HistoryRun; expanded: boolean; onToggle: () => void }) {
  const context = Object.entries(run.context).filter(([key]) => key !== "repository");
  return (
    <>
      <tr className={`history-row${expanded ? " expanded" : ""}`} onClick={onToggle}>
        <td className="nowrap">{new Date(run.startedAt).toLocaleString()}</td>
        <td className="mono">{run.command}</td>
        <td>{run.provider ?? "—"}</td>
        <td className="mono small">{run.cli} · {run.model}</td>
        <td><span className={`outcome outcome-${run.outcome}`}>{OUTCOMES[run.outcome]}</span></td>
        <td className="nowrap">{formatDuration(run.durationMs)}</td>
        <td className="small">{context.map(([key, value]) => `${key} ${value}`).join(" · ")}</td>
        <td className="small">{run.errors > 0 ? `${run.errors} err` : ""}{run.warnings > 0 ? ` ${run.warnings} warn` : ""}</td>
      </tr>
      {expanded && (
        <tr className="history-events">
          <td colSpan={8}>
            <div className="small muted mono">run_id {run.runId}{run.context.repository ? ` · ${run.context.repository}` : ""}{run.exitCode !== null ? ` · código ${run.exitCode}` : ""}</div>
            {run.events.length === 0 && <div className="muted small">Sin eventos registrados (solo warn y error se registran).</div>}
            <ul className="events">
              {run.events.map((event, index) => (
                <li key={index} className={`event event-${event.severity}`}>
                  <span className="mono small">{new Date(event.ts).toLocaleTimeString()}</span>
                  <span className="event-tags">
                    {[event.failure_kind, event.phase, event.session_event, event.reason, event.checkpoint && `checkpoint ${event.checkpoint}`]
                      .filter(Boolean)
                      .map((tag) => <span key={String(tag)} className="pill">{tag}</span>)}
                  </span>
                  <span className="grow">{event.message}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

export function HistoryView({ focusRunId }: { readonly focusRunId: string | null }) {
  const [document, setDocument] = useState<RunLogDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryOutcome | "all">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(focusRunId);

  const refresh = useCallback(async () => {
    try {
      setDocument(await backend.readRunLog());
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (focusRunId) setExpanded(focusRunId); }, [focusRunId]);

  const runs = useMemo(() => foldRuns(document?.records ?? []), [document]);
  const visible = runs.filter((run) =>
    (filter === "all" || run.outcome === filter)
    && (query.trim() === "" || JSON.stringify(run).toLowerCase().includes(query.trim().toLowerCase())));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Historial</h1>
        <p className="lead">Los runs que el CLI registró en su run log, desde la GUI o desde la terminal.</p>
      </header>
      <div className="row toolbar">
        <input className="input grow" placeholder="Buscar por comando, issue, HU, sesion, mensaje…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select className="input" value={filter} onChange={(event) => setFilter(event.target.value as HistoryOutcome | "all")}>
          <option value="all">Todos</option>
          {Object.entries(OUTCOMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" className="button" onClick={refresh}>Actualizar</button>
        {document?.exists && <button type="button" className="button" onClick={() => revealItemInDir(document.path)}>Mostrar archivo</button>}
      </div>
      {error && <div className="callout error">{error}</div>}
      {document && !document.exists && (
        <div className="callout">Todavia no hay run log en <code className="mono">{document.path}</code>. Se crea con el primer run (salvo con --no-log-file).</div>
      )}
      {document?.exists && <div className="muted small">{document.path} · {runs.length} runs</div>}
      {visible.length > 0 && (
        <table className="history">
          <thead>
            <tr><th>Inicio</th><th>Comando</th><th>Tracker</th><th>Agente</th><th>Resultado</th><th>Duracion</th><th>Contexto</th><th>Eventos</th></tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <RunRow key={run.runId} run={run} expanded={expanded === run.runId} onToggle={() => setExpanded(expanded === run.runId ? null : run.runId)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
