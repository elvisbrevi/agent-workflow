import { useMemo, useState } from "react";
import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { buildArgs, renderCommandLine, validateFlags, type FlagValue, type FlagValues } from "../lib/command-line.ts";
import { FlagField } from "./FlagField.tsx";
import { EffectBadge } from "./EffectBadge.tsx";

interface CommandViewProps {
  readonly catalog: CommandCatalog;
  readonly command: CatalogCommand;
  readonly values: FlagValues;
  readonly repositories: readonly string[];
  readonly onChange: (values: FlagValues) => void;
  readonly onReset: () => void;
  readonly onSaveDefaults: (values: FlagValues) => void;
  readonly onRun: (args: string[], stdin?: string) => void;
}

export function CommandView({ catalog, command, values, repositories, onChange, onReset, onSaveDefaults, onRun }: CommandViewProps) {
  const [secret, setSecret] = useState("");
  const [revealSecret, setRevealSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const family = catalog.families.find((candidate) => candidate.id === command.family);
  const stdinFlag = command.stdinFlag;

  // The value `credentials-set` stores never enters the form values: it is
  // written to the child's stdin, and the command line only says `--stdin`.
  const effective: FlagValues = useMemo(
    () => (stdinFlag && secret ? { ...values, [stdinFlag]: true } : values),
    [values, stdinFlag, secret],
  );
  const args = useMemo(() => buildArgs(catalog, command, effective), [catalog, command, effective]);
  const issues = useMemo(() => validateFlags(catalog, command, effective), [catalog, command, effective]);
  const line = renderCommandLine(catalog, command, args, catalog.binary);
  const errors = issues.filter((issue) => issue.severity === "error");
  const setValue = (flag: string) => (value: FlagValue) => onChange({ ...values, [flag]: value });

  const copy = async () => {
    await navigator.clipboard.writeText(line);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="command-view">
      <header className="command-header">
        <div className="eyebrow">{family?.title}</div>
        <div className="row baseline">
          <h1 className="mono">{command.name}</h1>
          <EffectBadge effect={command.effect} />
        </div>
        <p className="lead">{command.summary}</p>
        {(command.notes ?? []).map((note) => <div className="callout" key={note}>{note}</div>)}
      </header>

      <section className="form-section">
        {command.flags.length === 0 && !stdinFlag && <p className="muted">Este comando no recibe opciones propias.</p>}
        <div className="field-grid">
          {command.flags.filter((flag) => flag.flag !== stdinFlag).map((flag) => (
            <FlagField key={flag.flag} catalog={catalog} flag={flag} value={values[flag.flag]} values={effective} repositories={repositories} onChange={setValue(flag.flag)} />
          ))}
          {stdinFlag && (
            <div className="field">
              <label className="field-label" htmlFor="credential-value">
                <span>Valor</span>
                <code className="flag-name">stdin</code>
              </label>
              <div className="row">
                <input
                  id="credential-value"
                  className="input mono"
                  type={revealSecret ? "text" : "password"}
                  value={secret}
                  autoComplete="off"
                  placeholder="Se envia por stdin; nunca aparece en el comando ni se guarda"
                  onChange={(event) => setSecret(event.target.value)}
                />
                <button type="button" className="button" onClick={() => setRevealSecret(!revealSecret)}>{revealSecret ? "Ocultar" : "Mostrar"}</button>
              </div>
              <div className="field-help">Vacio: el CLI pediria el valor en una terminal, que la GUI no tiene.</div>
            </div>
          )}
        </div>
      </section>

      {command.groups.map((groupId) => {
        const group = catalog.groups.find((candidate) => candidate.id === groupId);
        if (!group) return null;
        const declared = group.flags.filter((flag) => values[flag.flag] !== undefined && values[flag.flag] !== "" && values[flag.flag] !== false).length;
        return (
          <details className="group" key={group.id} open={group.id === "agent" || group.id === "interview" ? true : undefined}>
            <summary>
              <span>{group.title}</span>
              {declared > 0 && <span className="pill">{declared}</span>}
            </summary>
            <div className="field-grid">
              {group.flags.map((flag) => (
                <FlagField key={flag.flag} catalog={catalog} flag={flag} value={values[flag.flag]} values={effective} repositories={repositories} onChange={setValue(flag.flag)} />
              ))}
            </div>
          </details>
        );
      })}

      <footer className="command-footer">
        <div className="preview">
          <code className="mono preview-line" title={line}>{line}</code>
          <button type="button" className="button" onClick={copy}>{copied ? "Copiado" : "Copiar"}</button>
        </div>
        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((issue) => <li key={`${issue.flag}-${issue.message}`} className={issue.severity}>{issue.message}</li>)}
          </ul>
        )}
        <div className="row end">
          <button type="button" className="button ghost" onClick={() => { setSecret(""); onReset(); }}>Restablecer</button>
          <button type="button" className="button ghost" title="Guarda estos valores en commandDefaults de gui.json" onClick={() => onSaveDefaults(values)}>
            Guardar como predeterminado
          </button>
          <button
            type="button"
            className={`button primary${command.effect === "read" ? "" : " warn"}`}
            disabled={errors.length > 0 || (stdinFlag !== undefined && secret.length === 0)}
            onClick={() => onRun(args, stdinFlag && secret ? secret : undefined)}
          >
            Ejecutar
          </button>
        </div>
      </footer>
    </div>
  );
}
