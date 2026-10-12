import { useEffect, useState } from "react";
import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { GuiSettings } from "../lib/backend.ts";
import type { HistoryRun } from "../lib/history.ts";
import type { AgentModels } from "../lib/models.ts";
import { isDesktop } from "../lib/platform.ts";
import type { RunAction, RunTarget } from "../lib/run-request.ts";
import type { RunState } from "../lib/runs.ts";
import { groupWork, huLabel, isEpic, matchesQuery, plannableSections, planTarget, type RepositoryWork, type WorkEntry, type WorkSection } from "../lib/work.ts";
import { DirectoryPicker } from "./DirectoryPicker.tsx";
import { RunForm } from "./RunForm.tsx";
import { SetupBanner, type SetupState } from "./SetupBanner.tsx";
import { WorkDetail, type Selection } from "./WorkDetail.tsx";

interface WorkViewProps {
  /** `plan` lists only what a plan slices — epics, HUs and lone Bugs — and opens its plan form directly. */
  readonly mode: "work" | "plan";
  readonly catalog: CommandCatalog;
  readonly settings: GuiSettings;
  readonly work: { results: RepositoryWork[]; loading: boolean; refresh: () => void };
  readonly history: readonly HistoryRun[];
  readonly runs: readonly RunState[];
  readonly models: readonly AgentModels[] | null;
  readonly setup: SetupState;
  readonly onRun: (command: CatalogCommand, args: string[]) => Promise<boolean>;
  readonly onSaveSettings: (settings: GuiSettings) => void;
  readonly onAddRepository: (path: string) => Promise<void>;
  readonly onOpenActivity: (runId: string | null) => void;
  readonly onFocusRun: (id: number) => void;
}

export interface FormRequest {
  readonly action: RunAction;
  readonly target: RunTarget;
}

const TRACKERS = { github: "GitHub", azure: "Azure DevOps" } as const;

const TEXTS = {
  work: {
    title: "Trabajo", label: "Trabajo asignado", search: "Buscar trabajo", loading: "Buscando tu trabajo…",
    empty: { github: "No tienes issues asignadas aquí.", azure: "No tienes HU ni tareas asignadas aquí." },
    panel: "Elige una HU o una issue para ver sus tareas y ejecutar Plan o Code.",
  },
  plan: {
    title: "Planificar", label: "Épicas, HU y Bugs asignados", search: "Buscar qué planificar", loading: "Buscando lo que puedes planificar…",
    empty: { github: "No tienes épicas asignadas aquí.", azure: "No tienes HU ni Bugs asignados aquí." },
    panel: "Elige una épica, una HU o un Bug, luego el repositorio donde trabajar, y ejecuta Plan: sus tareas quedan listas para Code.",
  },
} as const;

/** The repositories a plan of this target may work in: its own first, then the saved ones of the same tracker. */
function candidatesFor(target: RunTarget, results: readonly RepositoryWork[]): string[] {
  const tracker = target.kind === "azure-hu" ? "azure" : "github";
  return [...new Set([target.repository, ...results.filter((result) => result.tracker === tracker).map((result) => result.repository)])];
}

function EntryRow({ entry, selected, onSelect }: { entry: WorkEntry; selected: boolean; onSelect: () => void }) {
  if (entry.kind === "hu") {
    return (
      <button type="button" className={`work-entry${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
        <span className="entry-line"><span className="entry-id">{huLabel(entry)} #{entry.hu}</span>{entry.story && <span className="state-chip">{entry.story.state}</span>}</span>
        <strong className="entry-title">{entry.story?.title ?? (entry.tasks.length ? `Tareas de la HU #${entry.hu}` : `HU #${entry.hu}`)}</strong>
        {entry.tasks.length > 0 && (
          <ul className="entry-tasks">
            {entry.tasks.map((task) => <li key={task.id}><span className="entry-id">#{task.id}</span><span className="grow ellipsis">{task.title}</span><span className="state-chip">{task.state}</span></li>)}
          </ul>
        )}
      </button>
    );
  }
  const { item } = entry;
  return (
    <button type="button" className={`work-entry${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
      <span className="entry-line">
        <span className="entry-id">{item.tracker === "github" ? `#${item.id}` : `${item.type} #${item.id}`}</span>
        {isEpic(item) && <span className="kind-chip">Épica</span>}
        <span className="state-chip">{item.state}</span>
      </span>
      <strong className="entry-title">{item.title}</strong>
    </button>
  );
}

export function WorkView({ mode, catalog, settings, work, history, runs, models, setup, onRun, onSaveSettings, onAddRepository, onOpenActivity, onFocusRun }: WorkViewProps) {
  const [query, setQuery] = useState("");
  const [tracker, setTracker] = useState<"all" | "github" | "azure">("all");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [form, setForm] = useState<FormRequest | null>(null);
  const texts = TEXTS[mode];
  const grouped = groupWork(work.results);
  const sections = mode === "plan" ? plannableSections(grouped) : grouped;
  const visible = (section: WorkSection) => tracker === "all" || section.tracker === tracker;
  const trackers = new Set(sections.map((section) => section.tracker));

  // A refreshed read replaces the entries; the open one follows its key.
  useEffect(() => {
    if (!selection || selection.kind === "section") return;
    const fresh = sections.flatMap((section) => section.entries).find((entry) => entry.key === selection.entry.key);
    if (fresh && fresh !== selection.entry) setSelection({ kind: "entry", entry: fresh });
  }, [work.results]);

  // Planificar goes straight to the plan form; Trabajo opens the work first.
  const select = (next: Selection) => {
    const target = mode === "plan" && next.kind === "entry" ? planTarget(next.entry) : null;
    setForm(target ? { action: "plan", target } : null);
    setSelection(next);
  };
  const panelOpen = form !== null || selection !== null;
  // Where the panel replaces the list, it opens at its own top, not where the list was scrolled.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1050px)").matches) document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [selection, form]);

  return (
    <div className={`page work-page${panelOpen ? " panel-open" : ""}`}>
      <SetupBanner setup={setup} />
      <header className="work-toolbar">
        <h1 className="grow">{texts.title}</h1>
        <input className="input search" type="search" aria-label={texts.search} placeholder="Buscar por número o título…" value={query} onChange={(event) => setQuery(event.target.value)} />
        {trackers.size > 1 && (
          <select className="input tracker-filter" aria-label="Filtrar por plataforma" value={tracker} onChange={(event) => setTracker(event.target.value as typeof tracker)}>
            <option value="all">Todo</option><option value="azure">Azure DevOps</option><option value="github">GitHub</option>
          </select>
        )}
        <button type="button" className="button" onClick={work.refresh} disabled={work.loading} aria-label="Actualizar trabajo">↻</button>
      </header>

      {!settings.repositories.length && (
        <section className="panel-card onboarding">
          <h2>Agrega un repositorio</h2>
          <p className="muted">Lee las HU de Azure DevOps o las issues de GitHub asignadas a ti en ese repositorio.</p>
          <DirectoryPicker onPick={onAddRepository} label={isDesktop ? "Elegir repositorio…" : "Elegir repositorio del servidor…"} />
        </section>
      )}

      <div className={`work-layout${panelOpen ? " has-panel" : ""}`}>
        <section className="work-list" aria-label={texts.label}>
          {work.loading && <div className="empty-state" role="status">{texts.loading}</div>}
          {!work.loading && sections.filter(visible).map((section) => {
            const entries = section.entries.filter((entry) => matchesQuery(entry, query));
            const sectionSelected = selection?.kind === "section" && selection.section.key === section.key;
            return (
              <div className="work-section" key={section.key}>
                <button type="button" className={`section-header${sectionSelected ? " selected" : ""}`} aria-pressed={sectionSelected} onClick={() => select({ kind: "section", section })}>
                  <span className={`tracker-badge ${section.tracker}`}>{TRACKERS[section.tracker]}</span>
                  <span className="grow ellipsis">{section.scope}</span>
                  <span className="muted small">{section.tracker === "github" ? "Cola y nuevo plan" : "Abrir HU"} ›</span>
                </button>
                {entries.map((entry) => (
                  <EntryRow key={entry.key} entry={entry} selected={selection?.kind === "entry" && selection.entry.key === entry.key} onSelect={() => select({ kind: "entry", entry })} />
                ))}
                {entries.length === 0 && <p className="muted small section-empty">{query ? "Sin coincidencias." : texts.empty[section.tracker]}</p>}
              </div>
            );
          })}
          {!work.loading && work.results.some((result) => result.truncated) && <p className="muted small">Se muestran las primeras 200 tareas por repositorio.</p>}
        </section>

        <aside className="work-panel" aria-label="Detalle">
          {form ? (
            <RunForm key={`${form.action}:${JSON.stringify(form.target)}`} catalog={catalog} settings={settings} models={models} action={form.action} target={form.target}
              candidates={candidatesFor(form.target, work.results)}
              onRun={onRun} onSaveDefaults={onSaveSettings} onClose={() => { setForm(null); if (mode === "plan" && selection?.kind === "entry") setSelection(null); }} />
          ) : selection ? (
            <WorkDetail key={selection.kind === "section" ? selection.section.key : selection.entry.key} catalog={catalog} selection={selection} history={history} runs={runs}
              onBack={() => setSelection(null)} onPrepare={setForm} onSelect={select} onOpenActivity={onOpenActivity} onFocusRun={onFocusRun} />
          ) : (
            <div className="panel-card panel-empty">
              <p className="muted">{texts.panel}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
