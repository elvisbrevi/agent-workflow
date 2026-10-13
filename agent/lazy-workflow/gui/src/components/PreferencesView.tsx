import { useEffect, useState } from "react";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { Diagnostics, FlagDefault, GuiSettings, SettingsDocument } from "../lib/backend.ts";
import { cliLabel, type AgentModels } from "../lib/models.ts";
import { isDesktop } from "../lib/platform.ts";
import { repositoryName } from "../lib/work.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { DirectoryPicker } from "./DirectoryPicker.tsx";
import { AccountControl } from "./WebAccess.tsx";
import { SetupBanner, type SetupState } from "./SetupBanner.tsx";
import { prepareUpdate, updateBusy, type UpdateStatus } from "../lib/update.ts";
import type { RunState } from "../lib/runs.ts";
import { stripAnsi } from "../lib/output.ts";

interface PreferencesViewProps {
  readonly catalog: CommandCatalog;
  readonly document: SettingsDocument;
  readonly diagnostics: Diagnostics | null;
  readonly models: readonly AgentModels[] | null;
  readonly setup: SetupState;
  readonly onSave: (settings: GuiSettings) => Promise<void>;
  readonly onAddRepository: (path: string) => Promise<void>;
  readonly updateStatus: UpdateStatus | null;
  readonly updateError: string | null;
  readonly updating: boolean;
  readonly runs: readonly RunState[];
  readonly onUpdate: () => Promise<void>;
}

const text = (value: FlagDefault | undefined): string => (typeof value === "string" ? value : "");

const AGENT_FLAGS = ["--cli", "--model", "--variant"] as const;
/** The commands whose form can save an agent of its own, which wins over the default one. */
const AGENT_COMMANDS = [["plan", "Plan"], ["code", "Code"]] as const;

const agentOf = (flags: Record<string, FlagDefault> | undefined) =>
  ({ cli: text(flags?.["--cli"]), model: text(flags?.["--model"]), variant: text(flags?.["--variant"]) });

/** What the machine has, read-only: configuring it is the repair session's job, never a form here. */
function MachineStatus({ catalog, diagnostics, models }: { catalog: CommandCatalog; diagnostics: Diagnostics | null; models: readonly AgentModels[] | null }) {
  if (!diagnostics) return <p className="muted small" role="status">Revisando el equipo…</p>;
  const binary = (name: string) => diagnostics.binaries.find((entry) => entry.name === name);
  const organization = diagnostics.variables.find((variable) => variable.name === "LAZY_WORKFLOW_AZURE_ORGANIZATION");
  const rows: Array<{ label: string; ok: boolean; detail: string }> = [
    { label: "lz", ok: !diagnostics.lzError, detail: diagnostics.lzError ?? "Disponible" },
    { label: "git", ok: !!binary("git")?.path, detail: binary("git")?.path ? "Instalado" : "No encontrado" },
    { label: "GitHub CLI (gh)", ok: !!binary("gh")?.path, detail: binary("gh")?.path ? "Instalado" : "No encontrado" },
    { label: "Azure CLI (az)", ok: !!binary("az")?.path, detail: binary("az")?.path ? "Instalado" : "No encontrado" },
    { label: "Organización de Azure DevOps", ok: organization?.present === true, detail: organization?.present ? organization.value ?? "Configurada" : "Sin configurar" },
    ...catalog.agents.map((agent) => {
      const listed = models?.find((entry) => entry.cli === agent.cli);
      const installed = listed ? listed.installed : !!binary(agent.binary)?.path;
      return { label: cliLabel(agent.cli), ok: installed, detail: installed ? listed ? `${listed.models.length} modelos disponibles` : "Instalado" : "No instalado" };
    }),
  ];
  return (
    <ul className="status-list">
      {rows.map((row) => <li key={row.label} className={row.ok ? "ok" : "missing"}><span className="check" aria-hidden="true">{row.ok ? "✓" : "–"}</span><span className="grow">{row.label}</span><span className="muted small ellipsis">{row.detail}</span></li>)}
    </ul>
  );
}

export function PreferencesView({ catalog, document, diagnostics, models, setup, onSave, onAddRepository, updateStatus, updateError, updating, runs, onUpdate }: PreferencesViewProps) {
  const [draft, setDraft] = useState<GuiSettings>(document.settings);
  const [saving, setSaving] = useState(false);
  // A file changed from outside replaces the form only while it has no unsaved edits.
  const [base, setBase] = useState<GuiSettings>(document.settings);
  useEffect(() => {
    // In the browser the server alone registers repositories, so its list always wins.
    setDraft((current) => (JSON.stringify(current) === JSON.stringify(base) ? document.settings : isDesktop ? current : { ...current, repositories: document.settings.repositories }));
    setBase(document.settings);
  }, [document.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(document.settings);
  const updateRun = runs.findLast((run) => run.command === "update");
  const active = runs.some((run) => run.status === "running" || run.status === "cancelling") || (updateStatus?.activeRuns ?? 0) > 0;
  const busy = updating || updateBusy(updateStatus);
  const update = (patch: Partial<GuiSettings>) => setDraft({ ...draft, ...patch });
  const setAgent = (choice: { cli: string; model: string; variant: string }) => {
    const flagDefaults = { ...draft.flagDefaults };
    for (const [flag, value] of [["--cli", choice.cli], ["--model", choice.model], ["--variant", choice.variant]] as const) {
      if (value) flagDefaults[flag] = value;
      else delete flagDefaults[flag];
    }
    update({ flagDefaults });
  };
  const ownAgent = (command: string): boolean => AGENT_FLAGS.some((flag) => draft.commandDefaults[command]?.[flag] !== undefined);
  /**
   * A command's own agent, saved from its form with "Usar estas opciones por defecto", wins
   * over the default one: shown here, so a changed default is never silently shadowed.
   * Null removes it; the command's other saved options stay.
   */
  const setCommandAgent = (command: string, choice: { cli: string; model: string; variant: string } | null) => {
    const own = { ...(draft.commandDefaults[command] ?? {}) };
    for (const flag of AGENT_FLAGS) delete own[flag];
    if (choice) {
      // An agent left entirely at its defaults still has to be recorded as this command's own.
      own["--cli"] = choice.cli || catalog.defaultCli;
      if (choice.model) own["--model"] = choice.model;
      if (choice.variant) own["--variant"] = choice.variant;
    }
    const commandDefaults = { ...draft.commandDefaults };
    if (Object.keys(own).length > 0) commandDefaults[command] = own;
    else delete commandDefaults[command];
    update({ commandDefaults });
  };

  return (
    <div className="page preferences-page">
      <header className="work-toolbar"><h1 className="grow">Ajustes</h1></header>
      {document.error && <div className="callout error">{document.error} — se muestran los valores por defecto; guardar reemplaza el archivo.</div>}

      <section className="panel-card">
        <h2>Estado del equipo</h2>
        <SetupBanner setup={setup} expanded />
        <MachineStatus catalog={catalog} diagnostics={diagnostics} models={models} />
        {!isDesktop && <p className="muted small">Lz se ejecuta en el servidor, con su configuración y sus cuentas.</p>}
      </section>

      <section className="panel-card">
        <h2>Actualización</h2>
        <p className="muted small">Commit instalado: <code>{updateStatus?.installedCommit?.slice(0, 12) ?? "No disponible"}</code></p>
        <button type="button" className="button primary" disabled={!updateStatus || busy || active || (isDesktop && !prepareUpdate(catalog))} onClick={() => { void onUpdate(); }}>{busy || updateRun?.status === "running" ? "Actualizando…" : "Actualizar"}</button>
        {active && <p className="muted small">Espera a que terminen las ejecuciones para actualizar.</p>}
        {updateError && <p className="callout error" role="alert">{updateError}</p>}
        {!isDesktop && updateStatus?.job && <p role="status">{updateStatus.job.message}</p>}
        {!isDesktop && busy && updateStatus?.job?.status !== "failed" && <p className="muted small">Si el servicio se reinicia, esta página se reconectará y cargará la versión nueva.</p>}
        {isDesktop && updateRun?.exit && <p role="status">{updateRun.status === "success" ? "Actualización terminada. Cierra lz desde el menú de la app y vuelve a abrirla con lz gui para usar la versión nueva." : "La actualización no terminó correctamente. Revisa el progreso antes de reintentar."}</p>}
        {(updateStatus?.log || (isDesktop && updateRun)) && <details open={busy || updateRun?.status === "running"}><summary>Progreso de la actualización</summary><pre className="update-progress">{isDesktop && updateRun ? [...updateRun.stdout, ...updateRun.stderr].join("\n") : stripAnsi(updateStatus?.log ?? "")}</pre></details>}
      </section>

      <section className="panel-card">
        <h2>Agente predeterminado</h2>
        <AgentPicker catalog={catalog} models={models} id="default" value={agentOf(draft.flagDefaults)} onChange={setAgent} />
        {AGENT_COMMANDS.filter(([command]) => catalog.commands.some((entry) => entry.name === command)).map(([command, label]) => (
          <div className="stack command-agent" key={command}>
            <label className="toggle">
              <input type="checkbox" checked={ownAgent(command)} onChange={(event) => setCommandAgent(command, event.target.checked ? agentOf(draft.flagDefaults) : null)} />
              <span>{label} usa otro agente</span>
            </label>
            {ownAgent(command)
              ? <AgentPicker catalog={catalog} models={models} id={`${command}-agent`} value={agentOf(draft.commandDefaults[command])} onChange={(choice) => setCommandAgent(command, choice)} />
              : <p className="muted small">{label} usa el agente predeterminado.</p>}
          </div>
        ))}
        <label className="toggle"><input type="checkbox" checked={draft.confirmWrites} onChange={(event) => update({ confirmWrites: event.target.checked })} /><span>Pedir confirmación antes de ejecutar Plan o Code</span></label>
      </section>

      <section className="panel-card">
        <h2>Repositorios</h2>
        {draft.repositories.length === 0 && <p className="muted small">Ninguno todavía.</p>}
        {draft.repositories.map((repository) => (
          <div className="repo-chip" key={repository}>
            <span className="grow ellipsis" title={repository}><strong>{repositoryName(repository)}</strong> <span className="muted small">{repository}</span></span>
            {isDesktop && <button type="button" className="icon-button" aria-label={`Quitar ${repositoryName(repository)}`} onClick={() => {
              const repositories = draft.repositories.filter((entry) => entry !== repository);
              update({ repositories, activeRepository: repositories.includes(draft.activeRepository ?? "") ? draft.activeRepository : repositories[0] ?? null });
            }}>✕</button>}
          </div>
        ))}
        <DirectoryPicker label="Agregar repositorio…" onPick={isDesktop ? (path) => { if (!draft.repositories.includes(path)) update({ repositories: [...draft.repositories, path], activeRepository: draft.activeRepository ?? path }); } : onAddRepository} />
      </section>

      {!isDesktop && <section className="panel-card account-card"><h2>Sesión</h2><AccountControl className="row" /></section>}

      <section className="panel-card">
        <h2>Apariencia</h2>
        <select className="input" aria-label="Tema" value={draft.theme} onChange={(event) => update({ theme: event.target.value as GuiSettings["theme"] })}>
          <option value="system">Seguir al sistema</option>
          <option value="light">Claro</option>
          <option value="dark">Oscuro</option>
        </select>
      </section>

      <div className="settings-actions">
        <button type="button" className="button ghost" disabled={!dirty} onClick={() => setDraft(document.settings)}>Descartar</button>
        <button type="button" className="button primary" disabled={!dirty || saving} onClick={async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } }}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}
