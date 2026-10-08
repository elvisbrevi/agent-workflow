import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { CatalogFlag, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { requirementMet, type FlagValue, type FlagValues } from "../lib/command-line.ts";

interface FlagFieldProps {
  readonly catalog: CommandCatalog;
  readonly flag: CatalogFlag;
  readonly value: FlagValue;
  readonly values: FlagValues;
  readonly repositories: readonly string[];
  readonly onChange: (value: FlagValue) => void;
}

async function pick(kind: "file" | "directory"): Promise<string | null> {
  const chosen = await open({ directory: kind === "directory", multiple: false });
  return typeof chosen === "string" ? chosen : null;
}

/** Model and effort suggestions follow the agent the form currently selects. */
function suggestions(catalog: CommandCatalog, flag: CatalogFlag, values: FlagValues): readonly string[] {
  const cli = typeof values["--cli"] === "string" && values["--cli"] ? values["--cli"] : catalog.defaultCli;
  const agent = catalog.agents.find((candidate) => candidate.cli === cli);
  if (flag.flag === "--model") return catalog.agents.map((candidate) => candidate.defaultModel);
  if (flag.flag === "--variant") return agent?.efforts ?? ["low", "medium", "high"];
  if (flag.flag === "--fallback") {
    return catalog.agents.filter((candidate) => candidate.cli !== cli).map((candidate) => `${candidate.cli}:${candidate.defaultModel}:high`);
  }
  return [];
}

function placeholderOf(catalog: CommandCatalog, flag: CatalogFlag, values: FlagValues): string {
  if (flag.flag === "--model") {
    const cli = typeof values["--cli"] === "string" && values["--cli"] ? values["--cli"] : catalog.defaultCli;
    return catalog.agents.find((agent) => agent.cli === cli)?.defaultModel ?? "";
  }
  if (flag.default !== undefined && flag.default !== false) return `${flag.default}`;
  return flag.placeholder ?? "";
}

function TextInput(props: { id: string; value: string; placeholder: string; list?: string; monospace?: boolean; onChange: (value: string) => void }) {
  return (
    <input
      id={props.id}
      className={props.monospace ? "input mono" : "input"}
      value={props.value}
      placeholder={props.placeholder}
      list={props.list}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function RepeatableField({ id, flag, value, placeholder, list, onChange }: { id: string; flag: CatalogFlag; value: readonly string[]; placeholder: string; list?: string; onChange: (value: string[]) => void }) {
  const entries = value.length > 0 ? [...value] : [""];
  const update = (index: number, entry: string) => onChange(entries.map((current, position) => (position === index ? entry : current)));
  return (
    <div className="stack">
      {entries.map((entry, index) => (
        <div className="row" key={index}>
          <TextInput id={`${id}-${index}`} value={entry} placeholder={placeholder} list={list} monospace onChange={(next) => update(index, next)} />
          <button type="button" className="icon-button" title="Quitar" onClick={() => onChange(entries.filter((_, position) => position !== index))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="link-button" onClick={() => onChange([...entries, ""])}>
        + Agregar {flag.label.toLowerCase()}
      </button>
    </div>
  );
}

/** The comma-separated workspace list, edited as an ordered list: its order is the delivery order. */
function DirectoriesField({ id, value, repositories, onChange }: { id: string; value: string; repositories: readonly string[]; onChange: (value: string) => void }) {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const set = (next: string[]) => onChange(next.join(","));
  const move = (index: number, delta: number) => {
    const next = [...entries];
    const [entry] = next.splice(index, 1);
    next.splice(index + delta, 0, entry!);
    set(next);
  };
  const add = (entry: string | null) => {
    if (entry && !entries.includes(entry)) set([...entries, entry]);
  };
  const available = repositories.filter((repository) => !entries.includes(repository));
  return (
    <div className="stack">
      {entries.length === 0 && <div className="muted small">Ningun repositorio seleccionado.</div>}
      {entries.map((entry, index) => (
        <div className="repo-chip" key={entry}>
          <span className="order">{index + 1}</span>
          <span className="mono grow ellipsis" title={entry}>{entry}</span>
          <button type="button" className="icon-button" disabled={index === 0} title="Subir" onClick={() => move(index, -1)}>↑</button>
          <button type="button" className="icon-button" disabled={index === entries.length - 1} title="Bajar" onClick={() => move(index, 1)}>↓</button>
          <button type="button" className="icon-button" title="Quitar" onClick={() => set(entries.filter((_, position) => position !== index))}>✕</button>
        </div>
      ))}
      <div className="row">
        {available.length > 0 && (
          <select id={id} className="input" value="" onChange={(event) => add(event.target.value || null)}>
            <option value="">Agregar repositorio guardado…</option>
            {available.map((repository) => <option key={repository} value={repository}>{repository}</option>)}
          </select>
        )}
        <button type="button" className="button" onClick={async () => add(await pick("directory"))}>Elegir carpeta…</button>
      </div>
    </div>
  );
}

export function FlagField({ catalog, flag, value, values, repositories, onChange }: FlagFieldProps) {
  const id = `flag-${flag.flag.slice(2)}`;
  const unmet = (flag.requires ?? []).filter((requirement) => !requirementMet(requirement, values));
  const list = suggestions(catalog, flag, values).length > 0 ? `${id}-list` : undefined;
  const placeholder = placeholderOf(catalog, flag, values);
  const text = typeof value === "string" ? value : "";

  let control: ReactNode;
  if (flag.repeatable) {
    control = <RepeatableField id={id} flag={flag} value={Array.isArray(value) ? value : []} placeholder={placeholder} list={list} onChange={onChange} />;
  } else if (flag.kind === "boolean" || (flag.kind === "secret" && flag.valueOptional)) {
    control = (
      <label className="toggle">
        <input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{flag.kind === "secret" ? "Si — la contraseña viene de LAZY_WORKFLOW_OFF_PASSWORD" : "Si"}</span>
      </label>
    );
  } else if (flag.kind === "choice") {
    const current = text || (flag.default !== undefined ? `${flag.default}` : "");
    control = (
      <select id={id} className="input" value={current} onChange={(event) => onChange(event.target.value)}>
        {flag.default === undefined && <option value="">Elegir…</option>}
        {(flag.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>{choice}{`${flag.default}` === choice ? " (default)" : ""}</option>
        ))}
      </select>
    );
  } else if (flag.kind === "text") {
    control = (
      <textarea id={id} className="input textarea" value={text} placeholder={placeholder} rows={flag.flag === "--prompt" ? 4 : 3} onChange={(event) => onChange(event.target.value)} />
    );
  } else if (flag.kind === "directories") {
    control = <DirectoriesField id={id} value={text} repositories={repositories} onChange={onChange} />;
  } else if (flag.kind === "file" || flag.kind === "directory") {
    const kind = flag.kind;
    const repoList = kind === "directory" && repositories.length > 0 ? `${id}-repos` : undefined;
    control = (
      <div className="row">
        <TextInput id={id} value={text} placeholder={placeholder || (kind === "directory" ? "/ruta/al/repositorio" : "/ruta/al/archivo")} list={repoList} monospace onChange={onChange} />
        <button type="button" className="button" onClick={async () => { const chosen = await pick(kind); if (chosen) onChange(chosen); }}>
          Elegir…
        </button>
        {repoList && (
          <datalist id={repoList}>
            {repositories.map((repository) => <option key={repository} value={repository} />)}
          </datalist>
        )}
      </div>
    );
  } else {
    control = <TextInput id={id} value={text} placeholder={placeholder} list={list} monospace={flag.kind === "commit" || flag.kind === "integer" || flag.kind === "number"} onChange={onChange} />;
  }

  return (
    <div className={`field${unmet.length > 0 ? " field-disabled" : ""}`}>
      <label className="field-label" htmlFor={id}>
        <span>{flag.label}</span>
        {flag.required && <span className="required" title="Obligatorio">*</span>}
        <code className="flag-name">{flag.flag}</code>
      </label>
      {control}
      {list && (
        <datalist id={list}>
          {suggestions(catalog, flag, values).map((suggestion) => <option key={suggestion} value={suggestion} />)}
        </datalist>
      )}
      <div className="field-help">
        {flag.description}
        {unmet.length > 0 && <span className="hint"> Solo aplica con {unmet.join(" y ")}.</span>}
      </div>
    </div>
  );
}
