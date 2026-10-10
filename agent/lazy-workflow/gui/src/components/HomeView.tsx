import { useCallback, useEffect, useState } from "react";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { AssignedWork } from "../../../src/workspace/assigned-work.ts";
import { backend, errorText } from "../lib/backend.ts";
import { foldRuns, formatDuration, type HistoryRun } from "../lib/history.ts";
import { readTool, repositoryName, workPreset, historyLabel, type WorkItem } from "../lib/work.ts";
import { openUrl, isDesktop } from "../lib/platform.ts";
import { DirectoryPicker } from "./DirectoryPicker.tsx";

interface HomeViewProps {
  readonly catalog: CommandCatalog;
  readonly repositories: readonly string[];
  readonly activeRepository: string | null;
  readonly revision: number;
  readonly onOpenCommand: (name: string, values?: Record<string, string>) => void;
  readonly onOpenHistory: (runId: string | null) => void;
  readonly onAddRepository: (path: string) => void;
}

const outcomes = { success: "Completado", failure: "Falló", interrupted: "Interrumpido", unfinished: "Sin cierre" };

export function HomeView({ catalog, repositories, activeRepository, revision, onOpenCommand, onOpenHistory, onAddRepository }: HomeViewProps) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [scope, setScope] = useState("all");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrors([]);
    setItems([]);
    const work = Promise.all(repositories.map(async (repository) => {
      try {
        const result = await readTool<AssignedWork>(catalog, "work-assigned", { "--working-directory": repository });
        return { items: result.items.map((item) => ({ ...item, tracker: result.tracker, scope: result.scope, repository })), error: result.truncated ? `${repositoryName(repository)}: se muestran las primeras 200 tareas.` : null };
      } catch (error) { return { items: [], error: `${repositoryName(repository)}: ${errorText(error)}` }; }
    }));
    void work.then((results) => {
      if (cancelled) return;
      // The final Map entry wins when one Azure project has several folders.
      setItems(results.flatMap((result) => result.items).sort((a, b) => Number(a.repository === activeRepository) - Number(b.repository === activeRepository)));
      setErrors((current) => [...current, ...results.flatMap((result) => result.error ? [result.error] : [])]);
      setLoading(false);
    });
    void backend.readRunLog().then((result) => {
      if (!cancelled) setHistory(foldRuns(result.records).filter((run) => run.command === "plan" || run.command === "code"));
    }, (error) => { if (!cancelled) setErrors((current) => [...current, `Historial: ${errorText(error)}`]); });
    return () => { cancelled = true; };
  }, [catalog, repositories, activeRepository, revision, refresh]);

  // Deduplicate after filtering: two repositories can query the same Azure project.
  const visible = [...new Map(items.filter((item) => (source === "all" || item.tracker === source) && (scope === "all" || item.repository === scope)
    && `${item.id} ${item.title} ${item.type} ${item.scope}`.toLowerCase().includes(query.trim().toLowerCase())).map((item) => [`${item.tracker}:${item.url}`, item])).values()];
  const can = useCallback((name: string) => catalog.commands.some((command) => command.name === name), [catalog]);

  return <div className="page dashboard">
    <header className="dashboard-header">
      <div><div className="eyebrow">Tu espacio de trabajo</div><h1>Tu trabajo, a mano</h1><p className="lead">Elige una tarea o prepara tu próxima ejecución.</p></div>
      <button type="button" className="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>↻ Actualizar</button>
    </header>
    <section className="workflow-actions" aria-label="Nueva ejecución">
      {can("plan") && <button type="button" className="workflow-action" onClick={() => onOpenCommand("plan")}><span className="action-icon">↗</span><span><strong>Planificar</strong><span>Convierte una idea o HU en tareas claras.</span></span><span aria-hidden="true">→</span></button>}
      {can("code") && <button type="button" className="workflow-action" onClick={() => onOpenCommand("code")}><span className="action-icon">⌘</span><span><strong>Implementar</strong><span>Prepara Code para entregar trabajo pendiente.</span></span><span aria-hidden="true">→</span></button>}
    </section>
    {!repositories.length && <section className="card onboarding"><h2>Empieza por una carpeta</h2><p className="muted">Selecciona el repositorio en el que quieres trabajar.</p><DirectoryPicker repositories={repositories} onPick={onAddRepository} label={isDesktop ? "Elegir mi repositorio…" : "Buscar repositorio del servidor…"} /></section>}
    <div className="dashboard-columns">
      <section className="card assigned-panel" aria-label="Tareas asignadas">
        <div className="row"><h2 className="grow">Asignadas a mí</h2><span className="pill">{visible.length}</span></div>
        <p className="muted small">Issues de GitHub y HU, Task o Bug de Azure de tus repositorios guardados. Se usa la cuenta autenticada en ese equipo.</p>
        <div className="work-filters">
          <input className="input" aria-label="Buscar tarea asignada" placeholder="Buscar título o número…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select className="input" aria-label="Filtrar por plataforma" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">Todas las plataformas</option><option value="github">GitHub</option><option value="azure">Azure DevOps</option></select>
          {repositories.length > 1 && <select className="input" aria-label="Filtrar por repositorio" value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">Todos los repositorios</option>{repositories.map((path) => <option key={path} value={path}>{repositoryName(path)}</option>)}</select>}
        </div>
        {loading && <div className="empty-state" role="status">Buscando tus tareas…</div>}
        {!loading && visible.length === 0 && <div className="empty-state"><strong>{query || source !== "all" ? "Sin coincidencias" : "No hay tareas asignadas para mostrar"}</strong><span>{errors.length ? "Revisa las consultas que no se pudieron completar debajo." : "Las tareas aparecerán aquí cuando estén asignadas a tu cuenta."}</span></div>}
        <div className="work-list">
          {visible.slice(0, 50).map((item) => {
            const preset = workPreset(item);
            return <article className="work-row" key={`${item.tracker}:${item.url}`}>
              <div className="row"><span className={`tracker-badge ${item.tracker}`}>{item.tracker === "github" ? "GitHub" : "Azure"}</span><span className="muted small">{item.type} #{item.id}</span><span className="pill">{item.state}</span></div>
              <strong>{item.title}</strong>
              <span className="muted small">{item.scope}{item.hu ? ` · HU #${item.hu}` : ""}</span>
              <div className="row"><button type="button" className="button small" disabled={!can(preset.name)} onClick={() => onOpenCommand(preset.name, preset.values)}>{preset.name === "code" ? "Preparar Code" : preset.name === "plan" ? "Preparar Plan" : "Ver detalles"}</button><button type="button" className="link-button small" onClick={() => void openUrl(item.url).catch((error) => setErrors((current) => [...current, errorText(error)]))}>Abrir en {item.tracker === "github" ? "GitHub" : "Azure"} ↗</button></div>
            </article>;
          })}
        </div>
        {visible.length > 50 && <p className="muted small">Mostrando 50 de {visible.length}. Usa los filtros para encontrar tu tarea.</p>}
        {errors.length > 0 && <div className="query-errors" role="status">{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
      </section>
      <section className="card activity-panel" aria-label="Actividad reciente">
        <div className="row"><h2 className="grow">Actividad reciente</h2><button type="button" className="link-button small" onClick={() => onOpenHistory(null)}>Ver todo</button></div>
        <p className="muted small">Plan y Code desde la GUI o la terminal.</p>
        {!history.length && <div className="empty-state"><strong>Tu historial empieza aquí</strong><span>Cuando ejecutes Plan o Code, verás el resultado y las tareas relacionadas.</span></div>}
        <div className="activity-list">{history.slice(0, 12).map((run) => <button key={run.runId} type="button" className="activity-row" onClick={() => onOpenHistory(run.runId)}>
          <span className={`activity-dot outcome-${run.outcome}`}>●</span><span className="grow"><strong>{historyLabel(run)}</strong><span className="muted small">{run.context.repository ? repositoryName(String(run.context.repository)) : ""} · {new Date(run.startedAt).toLocaleString("es-CL")}</span><span className={`outcome outcome-${run.outcome}`}>{outcomes[run.outcome]} · {formatDuration(run.durationMs)}</span></span><span aria-hidden="true">→</span>
        </button>)}</div>
      </section>
    </div>
  </div>;
}
