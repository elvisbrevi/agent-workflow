import { useState, type ReactNode } from "react";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { can, useRead } from "../hooks.ts";
import { formatDuration, type HistoryRun } from "../lib/history.ts";
import { openUrl } from "../lib/platform.ts";
import type { RunTarget } from "../lib/run-request.ts";
import { isFinished, type RunState } from "../lib/runs.ts";
import {
  deliveryChildren, historyLabel, isDone, isEpic, progressOf, QUEUE_REASONS, runConcerns, runTitle,
  type GitHubQueue, type HuChild, type WorkEntry, type WorkSection,
} from "../lib/work.ts";
import type { FormRequest } from "./WorkView.tsx";

export type Selection = { kind: "entry"; entry: WorkEntry } | { kind: "section"; section: WorkSection };

interface WorkDetailProps {
  readonly catalog: CommandCatalog;
  readonly selection: Selection;
  readonly history: readonly HistoryRun[];
  readonly runs: readonly RunState[];
  readonly onBack: () => void;
  readonly onPrepare: (request: FormRequest) => void;
  readonly onSelect: (selection: Selection) => void;
  readonly onOpenActivity: (runId: string | null) => void;
  readonly onFocusRun: (id: number) => void;
}

const OUTCOMES = { success: "Completado", failure: "Falló", interrupted: "Interrumpido", unfinished: "Sin cierre" };

function Header({ id, state, title, url, chips, onBack }: { id: string; state?: string; title: string; url?: string; chips?: ReactNode; onBack: () => void }) {
  return (
    <header className="panel-header">
      <button type="button" className="link-button back" aria-label="Volver a la lista" onClick={onBack}>← Lista</button>
      <div className="grow">
        <div className="entry-line"><span className="entry-id">{id}</span>{chips}{state && <span className="state-chip">{state}</span>}</div>
        <h2>{title}</h2>
        {url && <button type="button" className="link-button small" onClick={() => void openUrl(url)}>Abrir en {url.includes("github.com") ? "GitHub" : "Azure DevOps"} ↗</button>}
      </div>
    </header>
  );
}

/** What ran, or runs, for this piece of work: the window's live runs first, then the run log. */
function RunsFor({ runs, history, live, recorded, onOpenActivity, onFocusRun }: {
  runs: readonly RunState[]; history: readonly HistoryRun[];
  live: (run: RunState) => boolean; recorded: (run: HistoryRun) => boolean;
  onOpenActivity: (runId: string | null) => void; onFocusRun: (id: number) => void;
}) {
  const active = runs.filter((run) => !isFinished(run) && live(run));
  const past = history.filter(recorded).slice(0, 6);
  return (
    <section className="panel-section">
      <h3>Ejecuciones</h3>
      {active.length === 0 && past.length === 0 && <p className="muted small">Todavía no se ha ejecutado Plan ni Code para esto.</p>}
      <ul className="run-list">
        {active.map((run) => (
          <li key={`live-${run.id}`}><button type="button" className="run-row" onClick={() => onFocusRun(run.id)}>
            <span className="status-dot status-running">●</span><span className="grow">{runTitle(run.command, run.args)}</span><span className="muted small">en curso</span>
          </button></li>
        ))}
        {past.map((run) => (
          <li key={run.runId}><button type="button" className="run-row" onClick={() => onOpenActivity(run.runId)}>
            <span className={`status-dot outcome-${run.outcome}`}>●</span>
            <span className="grow">{historyLabel(run)}<span className="muted small"> · {new Date(run.startedAt).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}</span></span>
            <span className={`outcome outcome-${run.outcome}`}>{OUTCOMES[run.outcome]}{run.durationMs !== null ? ` · ${formatDuration(run.durationMs)}` : ""}</span>
          </button></li>
        ))}
      </ul>
    </section>
  );
}

function TaskList({ tasks, mine, onCode }: { tasks: readonly HuChild[]; mine: ReadonlySet<number>; onCode?: (task: HuChild) => void }) {
  const { done, total } = progressOf(tasks);
  return (
    <>
      <div className="progress" role="img" aria-label={`${done} de ${total} tareas terminadas`}><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
      <p className="muted small">{done} de {total} tareas terminadas</p>
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id} className={isDone(task.state) ? "done" : ""}>
            <span className="entry-id">{task.type === "Bug" ? "Bug" : "Task"} #{task.id}</span>
            <span className="grow">{task.title ?? task.type}{mine.has(task.id) && <span className="kind-chip">tuya</span>}</span>
            <span className="state-chip">{task.state}</span>
            {onCode && !isDone(task.state) && <button type="button" className="button small" onClick={() => onCode(task)}>Code</button>}
          </li>
        ))}
      </ul>
    </>
  );
}

function HuDetail({ catalog, entry, props }: { catalog: CommandCatalog; entry: Extract<WorkEntry, { kind: "hu" }>; props: WorkDetailProps }) {
  const children = useRead<unknown>(catalog, "hu-children-info", { "--hu": String(entry.hu) });
  const info = useRead<{ title?: string; state?: string }>(catalog, "hu-info", entry.story ? null : { "--hu": String(entry.hu) });
  const tasks = children.value === null ? (children.error ? [] : null) : deliveryChildren(children.value);
  const title = entry.story?.title ?? info.value?.title ?? `HU #${entry.hu}`;
  const url = entry.story?.url ?? entry.tasks[0]?.url.replace(/\/\d+$/, `/${entry.hu}`);
  const target: RunTarget = { kind: "azure-hu", repository: entry.repository, hu: entry.hu, title };
  const mine = new Set(entry.tasks.map((task) => task.id));
  return (
    <div className="panel-card">
      <Header id={`HU #${entry.hu}`} state={entry.story?.state ?? info.value?.state} title={title} url={url} onBack={props.onBack} />
      <div className="panel-actions">
        {can(catalog, "plan") && <button type="button" className="button" onClick={() => props.onPrepare({ action: "plan", target })}>Planificar</button>}
        {can(catalog, "code") && <button type="button" className="button primary" onClick={() => props.onPrepare({ action: "code", target })}>Implementar</button>}
      </div>
      <section className="panel-section">
        <h3>Tareas</h3>
        {tasks === null && <p className="muted small" role="status">Cargando tareas…</p>}
        {children.error && <p className="read-errors">{children.error}</p>}
        {tasks && tasks.length === 0 && !children.error && <p className="muted small">La HU todavía no tiene tareas: Planificar las crea.</p>}
        {tasks && tasks.length > 0 && <TaskList tasks={tasks} mine={mine} onCode={can(catalog, "code") ? (task) => props.onPrepare({ action: "code", target: { ...target, ticket: task.id } }) : undefined} />}
      </section>
      <RunsFor runs={props.runs} history={props.history} onOpenActivity={props.onOpenActivity} onFocusRun={props.onFocusRun}
        live={(run) => run.args.includes("--hu") && run.args[run.args.indexOf("--hu") + 1] === String(entry.hu)}
        recorded={(run) => runConcerns(run, { hu: entry.hu })} />
    </div>
  );
}

function QueueSection({ catalog, repository, highlight }: { catalog: CommandCatalog; repository: string; highlight?: number }) {
  const queue = useRead<GitHubQueue>(catalog, "github-issue-list", { "--working-directory": repository });
  if (!can(catalog, "github-issue-list")) return null;
  const position = highlight === undefined ? -1 : (queue.value?.eligible ?? []).findIndex((issue) => issue.number === highlight);
  const blocked = highlight === undefined ? undefined : queue.value?.blocked.find((issue) => issue.number === highlight);
  return (
    <section className="panel-section">
      <h3>Cola de Code</h3>
      {!queue.value && !queue.error && <p className="muted small" role="status">Leyendo la cola…</p>}
      {queue.error && <p className="read-errors">{queue.error}</p>}
      {queue.value && (
        <>
          {highlight !== undefined && <p className="small">{position >= 0 ? `Esta issue está en la cola (posición ${position + 1}).` : blocked ? `Esta issue no se implementará todavía: ${blocked.reasons.map((reason) => QUEUE_REASONS[reason] ?? reason).join(", ")}.` : "Esta issue no está en la cola: le falta la etiqueta ready-for-agent."}</p>}
          {queue.value.eligible.length === 0 && <p className="muted small">No hay issues listas para Code.</p>}
          <ol className="task-list">
            {queue.value.eligible.map((issue) => <li key={issue.number} className={issue.number === highlight ? "current" : ""}><span className="entry-id">#{issue.number}</span><span className="grow">{issue.title}</span><span className="state-chip ok">lista</span></li>)}
            {queue.value.blocked.map((issue) => <li key={issue.number} className="done"><span className="entry-id">#{issue.number}</span><span className="grow">{issue.title}</span><span className="state-chip">{issue.reasons.map((reason) => QUEUE_REASONS[reason] ?? reason).join(", ")}</span></li>)}
          </ol>
        </>
      )}
    </section>
  );
}

function OpenHu({ section, onSelect }: { section: WorkSection; onSelect: (selection: Selection) => void }) {
  const [hu, setHu] = useState("");
  return (
    <form className="row" onSubmit={(event) => {
      event.preventDefault();
      if (!/^[1-9]\d*$/.test(hu)) return;
      onSelect({ kind: "entry", entry: { kind: "hu", key: `azure:${section.scope}:${hu}`, repository: section.repository, scope: section.scope, hu: Number(hu), story: null, tasks: [] } });
    }}>
      <input className="input" inputMode="numeric" aria-label="Número de HU" placeholder="Número de HU" value={hu} onChange={(event) => setHu(event.target.value.replace(/\D/g, ""))} />
      <button type="submit" className="button" disabled={!hu}>Abrir HU</button>
    </form>
  );
}

export function WorkDetail(props: WorkDetailProps) {
  const { catalog, selection, onBack, onPrepare } = props;
  if (selection.kind === "section") {
    const { section } = selection;
    const target: RunTarget = { kind: "github-repository", repository: section.repository, scope: section.scope };
    return (
      <div className="panel-card">
        <Header id={section.tracker === "github" ? "GitHub" : "Azure DevOps"} title={section.scope} onBack={onBack} />
        {section.tracker === "github" ? (
          <>
            <div className="panel-actions">
              {can(catalog, "plan") && <button type="button" className="button" onClick={() => onPrepare({ action: "plan", target })}>Nuevo plan</button>}
              {can(catalog, "code") && <button type="button" className="button primary" onClick={() => onPrepare({ action: "code", target })}>Implementar la cola</button>}
            </div>
            <QueueSection catalog={catalog} repository={section.repository} />
            <RunsFor runs={props.runs} history={props.history} onOpenActivity={props.onOpenActivity} onFocusRun={props.onFocusRun}
              live={(run) => !run.args.includes("--hu") && (run.args[run.args.indexOf("--working-directory") + 1] ?? "").split(",")[0] === section.repository}
              recorded={(run) => !run.context.hu && String(run.context.repository ?? "").split(",")[0] === section.repository} />
          </>
        ) : (
          <section className="panel-section">
            <h3>Trabajar otra HU</h3>
            <p className="muted small">Abre cualquier HU del proyecto, aunque no esté asignada a ti.</p>
            <OpenHu section={section} onSelect={props.onSelect} />
          </section>
        )}
      </div>
    );
  }
  const { entry } = selection;
  if (entry.kind === "hu") return <HuDetail catalog={catalog} entry={entry} props={props} />;
  const { item } = entry;
  if (item.tracker === "github") {
    const target: RunTarget = { kind: "github-issue", repository: item.repository, issue: item.id, title: item.title, url: item.url };
    return (
      <div className="panel-card">
        <Header id={`#${item.id}`} state={item.state} title={item.title} url={item.url} chips={isEpic(item) ? <span className="kind-chip">Épica</span> : null} onBack={onBack} />
        <div className="panel-actions">
          {can(catalog, "plan") && <button type="button" className="button" onClick={() => onPrepare({ action: "plan", target })}>Planificar desde esta issue</button>}
          {can(catalog, "code") && <button type="button" className="button primary" onClick={() => onPrepare({ action: "code", target: { kind: "github-repository", repository: item.repository, scope: item.scope } })}>Implementar la cola</button>}
        </div>
        <p className="muted small">Plan publica issues ready-for-agent; Code las implementa una a una, en orden y respetando sus dependencias.</p>
        <QueueSection catalog={catalog} repository={item.repository} highlight={isEpic(item) ? undefined : item.id} />
        <RunsFor runs={props.runs} history={props.history} onOpenActivity={props.onOpenActivity} onFocusRun={props.onFocusRun}
          live={() => false} recorded={(run) => runConcerns(run, { issue: item.id })} />
      </div>
    );
  }
  return (
    <div className="panel-card">
      <Header id={`${item.type} #${item.id}`} state={item.state} title={item.title} url={item.url} onBack={onBack} />
      <p className="muted">{["Task", "Bug"].includes(item.type)
        ? "Esta tarea no cuelga de una HU. Code implementa tareas dentro de su HU: vincúlala a una en Azure DevOps."
        : "Plan y Code trabajan sobre historias de usuario. Abre una de sus HU desde el proyecto."}</p>
    </div>
  );
}
