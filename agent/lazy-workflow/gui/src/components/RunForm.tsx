import { useMemo, useState } from "react";
import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { FlagDefault, GuiSettings } from "../lib/backend.ts";
import { initialValues } from "../lib/form-defaults.ts";
import { cliLabel, cliOf, defaultModelOf, type AgentModels } from "../lib/models.ts";
import { emptyRunOptions, plansUnit, prepareRun, type RunAction, type RunOptions, type RunTarget } from "../lib/run-request.ts";
import type { RunState } from "../lib/runs.ts";
import { deliveryChildren, isDone, repositoryName, type HuChild } from "../lib/work.ts";
import { can, useRead } from "../hooks.ts";
import { AgentPicker, defaultVariant, type AgentChoice } from "./AgentPicker.tsx";
import { WorkspaceChooser } from "./WorkspaceChooser.tsx";

interface RunFormProps {
  readonly catalog: CommandCatalog;
  readonly settings: GuiSettings;
  readonly models: readonly AgentModels[] | null;
  readonly action: RunAction;
  readonly target: RunTarget;
  /** The saved repositories of the target's tracker, the target's own first: where a plan of it may work. */
  readonly candidates: readonly string[];
  /** The window's runs, so a download or a creation started from the form is followed in it. */
  readonly runs: readonly RunState[];
  readonly onRun: (command: CatalogCommand, args: string[]) => Promise<boolean>;
  readonly onProvision: (command: CatalogCommand, args: string[]) => Promise<number | null>;
  readonly onAddRepository: (path: string) => Promise<void>;
  readonly onSaveDefaults: (settings: GuiSettings) => void;
  readonly onClose: () => void;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Where a run opens: the target's repository, except for the plan of an HU,
 * whose repositories the operator picks unless only one could serve. An epic
 * keeps its own repository first, because its sub-issues are published there.
 */
function initialRepositories(action: RunAction, target: RunTarget, candidates: readonly string[]): string[] {
  if (!plansUnit(action, target)) return target.repository ? [target.repository] : [];
  if (target.kind === "github-epic" && target.repository) return [target.repository];
  return candidates.length === 1 ? [candidates[0]!] : [];
}

/** The operator's saved defaults for this command, as the options the form opens with. */
function initialOptions(catalog: CommandCatalog, command: CatalogCommand | undefined, settings: GuiSettings, action: RunAction, target: RunTarget, candidates: readonly string[]): RunOptions {
  const values = command ? initialValues(catalog, command, settings) : {};
  return {
    ...emptyRunOptions(target.repository),
    repositories: initialRepositories(action, target, candidates),
    ticket: target.kind === "azure-hu" && target.ticket ? String(target.ticket) : "",
    cli: text(values["--cli"]),
    model: text(values["--model"]),
    variant: text(values["--variant"]),
    interview: values["--interview"] === "http",
    questions: text(values["--number-of-questions"]),
    normasSag: values["--normas-sag"] === true,
    idleTimeout: text(values["--idle-timeout"]),
    verbose: values["--verbose"] === true,
    fallbacks: Array.isArray(values["--fallback"]) ? [...values["--fallback"]] : [],
  };
}

function heading(action: RunAction, target: RunTarget): { title: string; subtitle: string } {
  if (target.kind === "azure-hu") return { title: `${action === "plan" ? "Planificar" : "Implementar"} ${target.bug ? "Bug" : "HU"} #${target.hu}`, subtitle: target.title };
  if (target.kind === "github-epic") return { title: `Planificar la épica #${target.issue}`, subtitle: `${target.nameWithOwner} · ${target.title}` };
  if (target.kind === "github-issue") return { title: `Planificar desde la issue #${target.issue}`, subtitle: target.title };
  return action === "plan"
    ? { title: "Nuevo plan", subtitle: target.scope }
    : { title: "Implementar la cola", subtitle: `${target.scope} · issues ready-for-agent sin asignar ni bloqueos, una por sesión` };
}

export function RunForm({ catalog, settings, models, action, target, candidates, runs, onRun, onProvision, onAddRepository, onSaveDefaults, onClose }: RunFormProps) {
  const command = catalog.commands.find((candidate) => candidate.name === action);
  const [options, setOptions] = useState<RunOptions>(() => initialOptions(catalog, command, settings, action, target, candidates));
  const [rung, setRung] = useState<AgentChoice>({ cli: "", model: "", variant: "" });
  const [starting, setStarting] = useState(false);
  const update = (patch: Partial<RunOptions>) => setOptions((current) => ({ ...current, ...patch }));
  const prepared = useMemo(() => prepareRun(catalog, action, target, options), [catalog, action, target, options]);
  const errors = prepared?.issues.filter((issue) => issue.severity === "error") ?? [];
  const { title, subtitle } = heading(action, target);
  const azureCode = action === "code" && target.kind === "azure-hu";
  const children = useRead<unknown>(catalog, "hu-children-info", azureCode ? { "--hu": String(target.hu) } : null);
  // Null while loading; an unreadable list leaves the number field instead.
  const tasks: HuChild[] | null = children.value !== null ? deliveryChildren(children.value) : children.error || !can(catalog, "hu-children-info") ? [] : null;
  const githubPlan = action === "plan" && target.kind === "github-repository";
  const unitPlan = plansUnit(action, target);
  const others = settings.repositories.filter((repository) => !options.repositories.includes(repository));
  const pending = (tasks ?? []).filter((task) => !isDone(task.state));

  const submit = async () => {
    if (!prepared || errors.length > 0) return;
    setStarting(true);
    try {
      if (await onRun(prepared.command, prepared.args)) onClose();
    } finally { setStarting(false); }
  };

  const saveDefaults = () => {
    const stored: Record<string, FlagDefault> = {};
    const keep = (flag: string, value: FlagDefault | "" | false) => { if (value !== "" && value !== false && !(Array.isArray(value) && value.length === 0)) stored[flag] = value; };
    keep("--cli", options.cli); keep("--model", options.model); keep("--variant", options.variant);
    keep("--interview", action === "plan" && options.interview ? "http" : ""); keep("--number-of-questions", action === "plan" ? options.questions : "");
    keep("--normas-sag", options.normasSag); keep("--idle-timeout", options.idleTimeout); keep("--verbose", options.verbose); keep("--fallback", options.fallbacks);
    onSaveDefaults({ ...settings, commandDefaults: { ...settings.commandDefaults, [action]: stored } });
  };

  if (!prepared) return <section className="panel-card"><p>Este lz no ofrece {action}. Actualízalo con <code>lz update</code>.</p><button type="button" className="button" onClick={onClose}>Volver</button></section>;

  return (
    <form className="panel-card run-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header className="panel-header">
        <button type="button" className="link-button back" aria-label="Volver" onClick={onClose}>← Volver</button>
        <div className="grow"><h2>{title}</h2><p className="muted small">{subtitle}</p></div>
      </header>

      {unitPlan && (target.kind === "azure-hu" || target.kind === "github-epic") && (
        <WorkspaceChooser catalog={catalog} target={target} candidates={candidates} saved={settings.repositories} chosen={options.repositories}
          onChange={(repositories) => update({ repositories })} runs={runs} onProvision={onProvision} onAddRepository={onAddRepository} />
      )}

      {azureCode && (
        <fieldset className="field">
          <legend className="field-label">Qué implementar</legend>
          <label className="choice"><input type="radio" name="ticket" checked={options.ticket === ""} onChange={() => update({ ticket: "" })} /><span>Todas las tareas pendientes{tasks ? ` (${pending.length})` : ""}</span></label>
          {tasks === null && <span className="muted small">Cargando tareas de la HU…</span>}
          {(tasks ?? []).map((task) => (
            <label key={task.id} className={`choice${isDone(task.state) ? " done" : ""}`}>
              <input type="radio" name="ticket" disabled={isDone(task.state)} checked={options.ticket === String(task.id)} onChange={() => update({ ticket: String(task.id) })} />
              <span className="grow">#{task.id} · {task.title ?? task.type}</span><span className="state-chip">{task.state}</span>
            </label>
          ))}
          {tasks !== null && (tasks ?? []).length === 0 && (
            <label className="choice"><span>Otra tarea por número</span><input className="input small-input" inputMode="numeric" aria-label="Número de tarea" value={options.ticket} onChange={(event) => update({ ticket: event.target.value.replace(/\D/g, "") })} /></label>
          )}
        </fieldset>
      )}

      <div className="field">
        <label className="field-label" htmlFor="run-prompt">{githubPlan ? "Qué quieres planificar" : "Indicaciones (opcional)"}</label>
        <textarea id="run-prompt" className="input textarea" rows={githubPlan ? 5 : 3} value={options.prompt} placeholder={githubPlan ? "Describe la funcionalidad o el cambio…" : action === "plan" ? "Contexto o restricciones para el plan…" : "Algo que el agente deba tener en cuenta…"} onChange={(event) => update({ prompt: event.target.value })} />
      </div>

      <AgentPicker catalog={catalog} models={models} id="run" value={{ cli: options.cli, model: options.model, variant: options.variant }} onChange={(choice) => update(choice)} />

      {action === "plan" && <label className="toggle"><input type="checkbox" checked={options.interview} onChange={(event) => update({ interview: event.target.checked })} /><span>Responder las preguntas del agente antes de planificar</span></label>}

      <details className="more-options">
        <summary>Más opciones</summary>
        <div className="stack-lg">
          {!unitPlan && (settings.repositories.length > 1 || options.repositories.length > 1) && (
            <div className="field">
              <span className="field-label">Repositorios</span>
              {options.repositories.map((repository, index) => (
                <div className="repo-chip" key={repository}>
                  <span className="order">{index + 1}</span><span className="grow ellipsis" title={repository}>{repositoryName(repository)}</span>
                  {index > 0 && <button type="button" className="icon-button" aria-label={`Quitar ${repositoryName(repository)}`} onClick={() => update({ repositories: options.repositories.filter((entry) => entry !== repository) })}>✕</button>}
                </div>
              ))}
              {others.length > 0 && (
                <select className="input" aria-label="Agregar repositorio" value="" onChange={(event) => { if (event.target.value) update({ repositories: [...options.repositories, event.target.value] }); }}>
                  <option value="">Agregar otro repositorio al mismo {action === "plan" ? "plan" : "trabajo"}…</option>
                  {others.map((repository) => <option key={repository} value={repository}>{repositoryName(repository)}</option>)}
                </select>
              )}
            </div>
          )}
          {azureCode && (
            <div className="field">
              <label className="field-label" htmlFor="run-base">Rama base</label>
              <input id="run-base" className="input mono" value={options.baseBranch} placeholder="main o master" onChange={(event) => update({ baseBranch: event.target.value })} />
              <span className="field-help">Solo se usa al crear la rama de la HU por primera vez.</span>
            </div>
          )}
          {action === "plan" && (
            <div className="field">
              <label className="field-label" htmlFor="run-questions">Máximo de preguntas</label>
              <input id="run-questions" className="input small-input" inputMode="numeric" value={options.questions} placeholder={String(command?.flags.find((flag) => flag.flag === "--number-of-questions")?.default ?? "")} onChange={(event) => update({ questions: event.target.value.replace(/\D/g, "") })} />
            </div>
          )}
          {command?.flags.some((flag) => flag.flag === "--normas-sag") && <label className="toggle"><input type="checkbox" checked={options.normasSag} onChange={(event) => update({ normasSag: event.target.checked })} /><span>Cargar las normas SAG del componente</span></label>}
          <div className="field">
            <span className="field-label">Agentes de respaldo</span>
            <span className="field-help">Si el agente principal agota su cuota o se queda inactivo, el trabajo sigue con estos, en orden.</span>
            {options.fallbacks.map((entry, index) => (
              <div className="repo-chip" key={entry}>
                <span className="order">{index + 1}</span><span className="grow ellipsis mono">{entry.split(":").map((part, position) => position === 0 ? cliLabel(part) : part).join(" · ")}</span>
                <button type="button" className="icon-button" aria-label="Quitar respaldo" onClick={() => update({ fallbacks: options.fallbacks.filter((_, position) => position !== index) })}>✕</button>
              </div>
            ))}
            <details className="add-fallback">
              <summary>Agregar respaldo</summary>
              <AgentPicker catalog={catalog} models={models} id="fallback" value={rung} onChange={setRung} />
              <button type="button" className="button" onClick={() => {
                const cli = cliOf(catalog, rung.cli);
                const entry = `${cli}:${rung.model || defaultModelOf(catalog, models, cli)}:${rung.variant || defaultVariant(catalog)}`;
                if (!options.fallbacks.includes(entry)) update({ fallbacks: [...options.fallbacks, entry] });
              }}>Agregar</button>
            </details>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="run-idle">Inactividad máxima (minutos)</label>
            <input id="run-idle" className="input small-input" inputMode="numeric" value={options.idleTimeout} placeholder={String(catalog.groups.find((group) => group.id === "agent")?.flags.find((flag) => flag.flag === "--idle-timeout")?.default ?? "")} onChange={(event) => update({ idleTimeout: event.target.value.replace(/\D/g, "") })} />
          </div>
          <label className="toggle"><input type="checkbox" checked={options.verbose} onChange={(event) => update({ verbose: event.target.checked })} /><span>Salida detallada</span></label>
          <button type="button" className="link-button" onClick={saveDefaults}>Usar estas opciones por defecto para {action === "plan" ? "Plan" : "Code"}</button>
        </div>
      </details>

      {errors.length > 0 && <ul className="form-errors">{errors.map((issue) => <li key={`${issue.flag}${issue.message}`}>{issue.message}</li>)}</ul>}
      <footer className="panel-footer">
        <button type="button" className="button ghost" onClick={onClose}>Cancelar</button>
        <button type="submit" className="button primary" disabled={errors.length > 0 || starting}>{starting ? "Iniciando…" : action === "plan" ? "Ejecutar Plan" : "Ejecutar Code"}</button>
      </footer>
    </form>
  );
}
