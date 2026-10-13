import { useEffect, useState } from "react";
import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { can, useRead } from "../hooks.ts";
import type { GuiSettings } from "../lib/backend.ts";
import type { AgentModels } from "../lib/models.ts";
import { itemLabel, matchesPlannable, plannableTarget, scopesOf, TRACKER_LABELS, type PlannableItem, type PlannableWork, type PlanTracker } from "../lib/plannable.ts";
import type { RunState } from "../lib/runs.ts";
import { candidatesFor, type RepositoryWork } from "../lib/work.ts";
import { RunForm } from "./RunForm.tsx";
import { SetupBanner, type SetupState } from "./SetupBanner.tsx";

interface PlanViewProps {
  readonly catalog: CommandCatalog;
  readonly settings: GuiSettings;
  /** The saved repositories' trackers, to offer the ones of the chosen item's tracker. */
  readonly work: { results: RepositoryWork[] };
  readonly runs: readonly RunState[];
  readonly models: readonly AgentModels[] | null;
  readonly setup: SetupState;
  readonly onRun: (command: CatalogCommand, args: string[]) => Promise<boolean>;
  readonly onProvision: (command: CatalogCommand, args: string[]) => Promise<number | null>;
  readonly onSaveSettings: (settings: GuiSettings) => void;
  readonly onAddRepository: (path: string) => Promise<void>;
}

const TRACKER_KEY = "lz.plan.tracker";

function storedTracker(): PlanTracker {
  try { return window.localStorage.getItem(TRACKER_KEY) === "github" ? "github" : "azure"; } catch { return "azure"; }
}

const EMPTY: Record<PlanTracker, string> = {
  azure: "No tienes HU en «En Desarrollo» ni Bugs en «En progreso» asignados.",
  github: "No hay épicas abiertas en tus repositorios ni en los de tus organizaciones.",
};

/**
 * Planificar (ADR-0049): what a plan can slice, read at the tracker instead of
 * in a saved repository — your Azure HUs in development and Bugs in progress,
 * or the open epics of your GitHub repositories. Choosing one opens its plan,
 * whose first field is where it is worked: a saved folder, a repository
 * downloaded from the tracker, or a new one created there.
 */
export function PlanView({ catalog, settings, work, runs, models, setup, onRun, onProvision, onSaveSettings, onAddRepository }: PlanViewProps) {
  const [tracker, setTracker] = useState<PlanTracker>(storedTracker);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [selected, setSelected] = useState<PlannableItem | null>(null);
  const [revision, setRevision] = useState(0);
  const available = can(catalog, "work-plannable");
  const listing = useRead<PlannableWork>(catalog, "work-plannable", available ? { "--tracker": tracker } : null, revision);
  const items = listing.value?.items ?? [];
  const visible = items.filter((item) => matchesPlannable(item, query, scope));
  const scopes = scopesOf(items);

  const choose = (next: PlanTracker) => {
    setTracker(next); setScope(""); setSelected(null);
    try { window.localStorage.setItem(TRACKER_KEY, next); } catch { /* the choice just is not remembered */ }
  };
  // Where the panel replaces the list, it opens at its own top, not where the list was scrolled.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1050px)").matches) document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [selected]);

  const target = selected ? plannableTarget(selected, tracker) : null;
  return (
    <div className={`page work-page plan-page${selected ? " panel-open" : ""}`}>
      <SetupBanner setup={setup} />
      <header className="work-toolbar">
        <h1 className="grow">Planificar</h1>
        <div className="segmented" role="radiogroup" aria-label="Plataforma">
          {(["azure", "github"] as const).map((entry) => (
            <button key={entry} type="button" role="radio" aria-checked={tracker === entry} className={tracker === entry ? "selected" : ""} onClick={() => choose(entry)}>{TRACKER_LABELS[entry]}</button>
          ))}
        </div>
        <input className="input search" type="search" aria-label="Buscar qué planificar" placeholder="Buscar por número o título…" value={query} onChange={(event) => setQuery(event.target.value)} />
        {scopes.length > 1 && (
          <select className="input tracker-filter" aria-label={tracker === "azure" ? "Filtrar por proyecto" : "Filtrar por repositorio"} value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="">{tracker === "azure" ? "Todos los proyectos" : "Todos los repositorios"}</option>
            {scopes.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        )}
        <button type="button" className="button" onClick={() => setRevision((value) => value + 1)} disabled={available && !listing.value && !listing.error} aria-label="Actualizar lista">↻</button>
      </header>

      <div className={`work-layout${selected ? " has-panel" : ""}`}>
        <section className="work-list" aria-label={tracker === "azure" ? "HU y Bugs asignados" : "Épicas"}>
          {!available && <div className="callout">Este lz no lista qué planificar. Actualízalo con <code>lz update</code>{" "}o pide al dueño del servidor que permita <code>work-plannable</code>.</div>}
          {available && !listing.value && !listing.error && <div className="empty-state" role="status">{tracker === "azure" ? "Buscando tus HU y Bugs…" : "Buscando épicas en tus repositorios…"}</div>}
          {listing.error && <p className="read-errors">{listing.error}</p>}
          {listing.value && visible.length === 0 && <p className="muted small section-empty">{query || scope ? "Sin coincidencias." : EMPTY[tracker]}</p>}
          {visible.length > 0 && (
            <div className="work-section">
              {visible.map((item) => {
                const isSelected = selected?.url === item.url;
                return (
                  <button key={item.url} type="button" className={`work-entry${isSelected ? " selected" : ""}`} aria-pressed={isSelected} onClick={() => setSelected(item)}>
                    <span className="entry-line">
                      <span className="entry-id">{itemLabel(item, tracker)}</span>
                      {tracker === "github" && <span className="kind-chip">Épica</span>}
                      <span className="state-chip">{item.state}</span>
                      {tracker === "azure" && <span className="muted small ellipsis">{item.scope}</span>}
                    </span>
                    <strong className="entry-title">{item.title}</strong>
                  </button>
                );
              })}
            </div>
          )}
          {listing.value?.truncated && <p className="muted small">Se muestran los primeros 200.</p>}
        </section>

        <aside className="work-panel" aria-label="Plan">
          {target ? (
            <RunForm key={`plan:${selected!.url}`} catalog={catalog} settings={settings} models={models} action="plan" target={target}
              candidates={candidatesFor(target, work.results)} runs={runs}
              onRun={onRun} onProvision={onProvision} onAddRepository={onAddRepository} onSaveDefaults={onSaveSettings} onClose={() => setSelected(null)} />
          ) : (
            <div className="panel-card panel-empty">
              <p className="muted">Elige {tracker === "azure" ? "una HU o un Bug" : "una épica"}, luego dónde trabajar —un proyecto que ya tienes, uno que descargas o uno nuevo— y ejecuta Plan: sus tareas quedan listas para Code.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
