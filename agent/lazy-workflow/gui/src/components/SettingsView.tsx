import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { Diagnostics, FlagDefault, GuiSettings, SettingsDocument } from "../lib/backend.ts";

interface SettingsViewProps {
  readonly catalog: CommandCatalog | null;
  readonly document: SettingsDocument;
  readonly diagnostics: Diagnostics | null;
  readonly onSave: (settings: GuiSettings) => Promise<void>;
  readonly onOpenCommand: (name: string, values?: Record<string, string>) => void;
  readonly onReloadEnvironment: () => void;
}

function ListEditor({ values, placeholder, pickDirectory, onChange }: { values: string[]; placeholder: string; pickDirectory?: boolean; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed]);
    setDraft("");
  };
  return (
    <div className="stack">
      {values.map((value) => (
        <div className="repo-chip" key={value}>
          <span className="mono grow ellipsis" title={value}>{value}</span>
          <button type="button" className="icon-button" title="Quitar" onClick={() => onChange(values.filter((entry) => entry !== value))}>✕</button>
        </div>
      ))}
      <div className="row">
        <input className="input mono grow" value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(draft); }} />
        <button type="button" className="button" onClick={() => add(draft)}>Agregar</button>
        {pickDirectory && (
          <button type="button" className="button" onClick={async () => { const chosen = await open({ directory: true }); if (typeof chosen === "string") add(chosen); }}>Elegir carpeta…</button>
        )}
      </div>
    </div>
  );
}

/** Names that belong in `secretEnvironment`, never in the file: the same rule as `utility/lz/scripts/gui-settings.ts`. */
const looksSecret = (name: string): boolean => /(PASSWORD|TOKEN|SECRET|_PAT$|API_KEY)/.test(name);

const asText = (value: FlagDefault | undefined): string => (value === undefined ? "" : Array.isArray(value) ? value.join(",") : String(value));

export function SettingsView({ catalog, document, diagnostics, onSave, onOpenCommand, onReloadEnvironment }: SettingsViewProps) {
  const [draft, setDraft] = useState<GuiSettings>(document.settings);
  const [saving, setSaving] = useState(false);
  const [base, setBase] = useState<GuiSettings>(document.settings);
  const [customName, setCustomName] = useState("");
  const [customValue, setCustomValue] = useState("");
  // A file changed from outside replaces the form only while it has no unsaved edits.
  useEffect(() => {
    setDraft((current) => (JSON.stringify(current) === JSON.stringify(base) ? document.settings : current));
    setBase(document.settings);
  }, [document.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(document.settings);
  const update = (patch: Partial<GuiSettings>) => setDraft({ ...draft, ...patch });
  const setEnvironment = (name: string, value: string) => {
    const environment = { ...draft.environment };
    if (value === "") delete environment[name];
    else environment[name] = value;
    update({ environment });
  };
  const setFlagDefault = (flag: string, value: FlagDefault | "") => {
    const flagDefaults = { ...draft.flagDefaults };
    if (value === "" || value === false) delete flagDefaults[flag];
    else flagDefaults[flag] = value;
    update({ flagDefaults });
  };
  const toggleSecret = (name: string, on: boolean) =>
    update({ secretEnvironment: on ? [...new Set([...draft.secretEnvironment, name])] : draft.secretEnvironment.filter((entry) => entry !== name) });

  const known = new Set(catalog?.environment.map((variable) => variable.name) ?? []);
  const custom = Object.entries(draft.environment).filter(([name]) => !known.has(name));
  const cli = asText(draft.flagDefaults["--cli"]) || catalog?.defaultCli || "opencode";
  const agent = catalog?.agents.find((candidate) => candidate.cli === cli);
  const probe = (name: string) => diagnostics?.variables.find((variable) => variable.name === name);

  return (
    <div className="page settings">
      <header className="page-header">
        <h1>Configuracion</h1>
        <p className="lead">
          Se guarda en <code className="mono">{document.path}</code>; la skill <code className="mono">lz</code> documenta el mismo archivo para configurarlo desde un agente.
        </p>
        {document.error && <div className="callout error">{document.error} — se muestran los valores por defecto; guardar reemplaza el archivo.</div>}
      </header>

      <section className="card">
        <h2>CLI</h2>
        <div className="field">
          <label className="field-label" htmlFor="lz-command">Comando lz</label>
          <input id="lz-command" className="input mono" value={draft.lzCommand} placeholder="lz" onChange={(event) => update({ lzCommand: event.target.value })} />
          <div className="field-help">
            <code>lz</code> en el PATH, la ruta del lanzador, o el <code>main.ts</code> de un checkout (se ejecuta con Bun).
            {diagnostics?.lzLauncher && <> Resuelto: <code className="mono">{diagnostics.lzLauncher}</code>.</>}
            {diagnostics?.lzError && <span className="error-text"> {diagnostics.lzError}</span>}
          </div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={draft.inheritShellEnvironment} onChange={(event) => update({ inheritShellEnvironment: event.target.checked })} />
          <span>Heredar el entorno del shell de login (PATH y variables exportadas en tu perfil)</span>
        </label>
        <div className="row">
          <span className="muted small grow">{diagnostics ? (diagnostics.shellEnvironment ? "Entorno del shell leido." : "No se leyo el entorno del shell.") : ""}</span>
          <button type="button" className="button" onClick={onReloadEnvironment}>Releer entorno</button>
        </div>
        <div className="field">
          <span className="field-label">Directorios extra del PATH</span>
          <ListEditor values={draft.extraPath} placeholder="~/.bun/bin" pickDirectory onChange={(extraPath) => update({ extraPath })} />
        </div>
      </section>

      <section className="card">
        <h2>Variables de entorno</h2>
        <p className="muted small">Cada run recibe estas variables sobre el entorno heredado. Los secretos nunca se guardan aqui: se leen con <code>lz credentials-get</code> al iniciar el run.</p>
        {/* NO_COLOR is the GUI's own: every run gets it, so the panel shows plain text. */}
        {catalog?.environment.filter((variable) => variable.name !== "NO_COLOR").map((variable) => {
          const state = probe(variable.name);
          return (
            <div className="field" key={variable.name}>
              <label className="field-label" htmlFor={`env-${variable.name}`}>
                <code className="mono">{variable.name}</code>
                {state && <span className={`pill ${state.present ? "ok" : "missing"}`}>{state.present ? state.source : "sin definir"}</span>}
              </label>
              {variable.secret ? (
                <div className="row">
                  <label className="toggle grow">
                    <input type="checkbox" checked={draft.secretEnvironment.includes(variable.name)} onChange={(event) => toggleSecret(variable.name, event.target.checked)} />
                    <span>Resolver desde el almacen de credenciales al iniciar cada run</span>
                  </label>
                  <button type="button" className="button" onClick={() => onOpenCommand("credentials-set", { "--name": variable.name })}>Guardar valor…</button>
                </div>
              ) : (
                <input
                  id={`env-${variable.name}`}
                  className="input mono"
                  value={draft.environment[variable.name] ?? ""}
                  placeholder={state?.value ? `heredado: ${state.value}` : ""}
                  onChange={(event) => setEnvironment(variable.name, event.target.value)}
                />
              )}
              <div className="field-help">{variable.description}</div>
            </div>
          );
        })}
        <div className="field">
          <span className="field-label">Otras variables</span>
          {custom.map(([name, value]) => (
            <div className="row" key={name}>
              <code className="mono env-name">{name}</code>
              <input className="input mono grow" value={value} onChange={(event) => setEnvironment(name, event.target.value)} />
              <button type="button" className="icon-button" title="Quitar" onClick={() => setEnvironment(name, "")}>✕</button>
            </div>
          ))}
          <div className="row">
            <input className="input mono" placeholder="NOMBRE" value={customName} onChange={(event) => setCustomName(event.target.value.toUpperCase())} />
            <input className="input mono grow" placeholder="valor" value={customValue} onChange={(event) => setCustomValue(event.target.value)} />
            <button
              type="button"
              className="button"
              disabled={!/^[A-Z_][A-Z0-9_]*$/.test(customName) || customValue === "" || looksSecret(customName)}
              onClick={() => { setEnvironment(customName, customValue); setCustomName(""); setCustomValue(""); }}
            >
              Agregar variable
            </button>
          </div>
          {looksSecret(customName) && (
            <div className="field-help hint">
              {customName} parece un secreto: guardalo con credentials-set y agregalo abajo, en «Otros secretos».
            </div>
          )}
        </div>
        <div className="field">
          <span className="field-label">Otros secretos</span>
          <ListEditor
            values={draft.secretEnvironment.filter((name) => !known.has(name))}
            placeholder="GITHUB_TOKEN"
            onChange={(names) => update({ secretEnvironment: [...draft.secretEnvironment.filter((name) => known.has(name)), ...names.map((name) => name.toUpperCase())] })}
          />
          <div className="field-help">Cada nombre se lee con <code>lz credentials-get --name NOMBRE --force</code> al iniciar el run; el valor nunca toca este archivo.</div>
        </div>
      </section>

      <section className="card">
        <h2>Valores por defecto de los formularios</h2>
        <p className="muted small">Se aplican a todo comando que acepte la opcion (<code>flagDefaults</code>). Cada formulario puede guardar los suyos con «Guardar como predeterminado».</p>
        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="default-cli">Agente <code className="flag-name">--cli</code></label>
            <select id="default-cli" className="input" value={asText(draft.flagDefaults["--cli"])} onChange={(event) => setFlagDefault("--cli", event.target.value)}>
              <option value="">Default del CLI ({catalog?.defaultCli})</option>
              {catalog?.agents.map((candidate) => <option key={candidate.cli} value={candidate.cli}>{candidate.cli}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="default-model">Modelo <code className="flag-name">--model</code></label>
            <input id="default-model" className="input mono" value={asText(draft.flagDefaults["--model"])} placeholder={agent?.defaultModel} onChange={(event) => setFlagDefault("--model", event.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="default-variant">Variante <code className="flag-name">--variant</code></label>
            <input id="default-variant" className="input mono" list="default-variant-list" value={asText(draft.flagDefaults["--variant"])} placeholder="high" onChange={(event) => setFlagDefault("--variant", event.target.value)} />
            <datalist id="default-variant-list">{(agent?.efforts ?? []).map((effort) => <option key={effort} value={effort} />)}</datalist>
          </div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={draft.flagDefaults["--verbose"] === true} onChange={(event) => setFlagDefault("--verbose", event.target.checked)} />
          <span>Salida detallada por defecto (<code>--verbose</code>)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={draft.confirmWrites} onChange={(event) => update({ confirmWrites: event.target.checked })} />
          <span>Confirmar antes de ejecutar comandos que escriben, abren sesiones o reinstalan</span>
        </label>
        {Object.keys(draft.commandDefaults).length > 0 && (
          <div className="field">
            <span className="field-label">Predeterminados por comando</span>
            {Object.entries(draft.commandDefaults).map(([name, values]) => (
              <div className="repo-chip" key={name}>
                <span className="mono">{name}</span>
                <span className="mono small grow ellipsis">{Object.entries(values).map(([flag, value]) => `${flag} ${asText(value)}`).join(" ")}</span>
                <button type="button" className="icon-button" title="Quitar" onClick={() => { const { [name]: _, ...rest } = draft.commandDefaults; update({ commandDefaults: rest }); }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Repositorios</h2>
        <ListEditor values={draft.repositories} placeholder="/ruta/al/repositorio" pickDirectory onChange={(repositories) => update({ repositories, activeRepository: repositories.includes(draft.activeRepository ?? "") ? draft.activeRepository : (repositories[0] ?? null) })} />
      </section>

      <section className="card">
        <h2>Apariencia</h2>
        <select className="input" value={draft.theme} onChange={(event) => update({ theme: event.target.value as GuiSettings["theme"] })}>
          <option value="system">Seguir al sistema</option>
          <option value="light">Claro</option>
          <option value="dark">Oscuro</option>
        </select>
      </section>

      <div className="settings-actions">
        <button type="button" className="button" onClick={() => revealItemInDir(document.path).catch(() => undefined)}>Mostrar archivo</button>
        <button type="button" className="button ghost" disabled={!dirty} onClick={() => setDraft(document.settings)}>Descartar</button>
        <button type="button" className="button primary" disabled={!dirty || saving} onClick={async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } }}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}
