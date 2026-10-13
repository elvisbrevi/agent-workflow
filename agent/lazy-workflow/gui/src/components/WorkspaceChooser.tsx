import { useEffect, useState } from "react";
import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { can, useRead } from "../hooks.ts";
import { errorText } from "../lib/backend.ts";
import type { RemoteRepository } from "../lib/plannable.ts";
import { defaultParent, folderName, joinPath, prepareProvision, trackerOf, type Provision, type RunTarget } from "../lib/run-request.ts";
import type { RunState } from "../lib/runs.ts";
import { lastLine, repositoryName } from "../lib/work.ts";
import { DirectoryPicker } from "./DirectoryPicker.tsx";

type Mode = "existing" | "repo-clone" | "repo-create";

interface WorkspaceChooserProps {
  readonly catalog: CommandCatalog;
  readonly target: Extract<RunTarget, { kind: "azure-hu" | "github-epic" }>;
  /** The saved repositories of the target's tracker. */
  readonly candidates: readonly string[];
  /** Every saved repository: a download lands beside them unless the operator picks a folder. */
  readonly saved: readonly string[];
  readonly chosen: readonly string[];
  readonly onChange: (chosen: string[]) => void;
  readonly runs: readonly RunState[];
  /** Starts `repo-clone` or `repo-create` without leaving the form; its run id, or null. */
  readonly onProvision: (command: CatalogCommand, args: string[]) => Promise<number | null>;
  readonly onAddRepository: (path: string) => Promise<void>;
}

const MODES: Record<Mode, string> = { existing: "Proyecto existente", "repo-clone": "Descargar repo", "repo-create": "Crear repo nuevo" };

/**
 * Where a plan of an HU, a Bug or an epic works (ADR-0049): saved folders, a
 * repository downloaded from its tracker, or a new one created there. The
 * download and the creation are `lz` runs of their own; once one succeeds its
 * folder is registered and becomes the one chosen, and the plan runs there like
 * in any other.
 */
export function WorkspaceChooser({ catalog, target, candidates, saved, chosen, onChange, runs, onProvision, onAddRepository }: WorkspaceChooserProps) {
  const tracker = trackerOf(target);
  const [mode, setMode] = useState<Mode>("existing");
  const [project, setProject] = useState(target.kind === "azure-hu" ? target.project ?? "" : "");
  const [repository, setRepository] = useState(target.kind === "github-epic" ? target.nameWithOwner : "");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [parent, setParent] = useState(defaultParent(saved));
  const [folder, setFolder] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: number; destination: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const provisioning = mode !== "existing";
  const projects = useRead<Array<{ name: string }>>(catalog, "azure-project-list", tracker === "azure" && provisioning ? {} : null);
  const repositories = useRead<RemoteRepository[]>(catalog, "azure-repo-list", tracker === "azure" && mode === "repo-clone" && project ? { "--project": project } : null);
  const owners = useRead<string[]>(catalog, "github-owner-list", tracker === "github" && mode === "repo-create" ? {} : null);
  useEffect(() => { if (!owner && owners.value?.length) setOwner(owners.value[0]!); }, [owners.value]);

  // What the run is given: GitHub names owner/name, Azure the name inside the project.
  const remote = mode === "repo-create" ? (tracker === "github" ? (owner && name.trim() ? `${owner}/${name.trim()}` : "") : name.trim()) : repository.trim();
  const destination = parent && (folder ?? folderName(remote)) ? joinPath(parent, folder ?? folderName(remote)) : "";
  const provision: Provision | null = provisioning ? { action: mode, tracker, project, repository: remote, destination } : null;
  const prepared = provision ? prepareProvision(catalog, provision) : null;
  const problems = [
    ...(provisioning && !remote ? [mode === "repo-clone" ? "Elige el repositorio que vas a descargar." : "Escribe el nombre del repositorio nuevo."] : []),
    ...(provisioning && !parent ? ["Elige la carpeta donde quedará."] : []),
    ...(prepared?.issues.filter((issue) => issue.severity === "error" && issue.flag !== "--destination" && issue.flag !== "--repository").map((issue) => issue.message) ?? []),
  ];

  // A provisioning run is followed here: success registers and chooses its folder, failure says why.
  useEffect(() => {
    if (!pending) return;
    const run = runs.find((entry) => entry.id === pending.id);
    if (!run || run.status === "running" || run.status === "cancelling") return;
    setPending(null);
    if (run.status !== "success") {
      setError(lastLine(run.stderr.join("\n")) || "No terminó bien; revisa la ejecución en Ejecuciones.");
      return;
    }
    // The folder was made for this plan: it becomes where it works, and others can be added back.
    onAddRepository(pending.destination).then(() => {
      onChange([pending.destination]);
      setMode("existing");
    }, (caught) => setError(errorText(caught)));
  }, [runs, pending]);

  const start = async () => {
    if (!prepared || problems.length > 0 || pending) return;
    setError(null);
    const id = await onProvision(prepared.command, prepared.args);
    if (id !== null) setPending({ id, destination });
  };

  const listed = [...new Set([...candidates, ...chosen])];
  const toggle = (path: string, on: boolean) => onChange(on ? [...chosen, path] : chosen.filter((entry) => entry !== path));
  const offered = (Object.keys(MODES) as Mode[]).filter((entry) => entry === "existing" || can(catalog, entry));
  const projectSelect = (
    <div className="field">
      <label className="field-label" htmlFor="provision-project">Proyecto de Azure DevOps</label>
      <select id="provision-project" className="input" value={project} onChange={(event) => { setProject(event.target.value); setRepository(""); setFolder(null); }}>
        {!project && <option value="">{projects.value ? "Elige un proyecto…" : "Cargando proyectos…"}</option>}
        {project && !projects.value?.some((entry) => entry.name === project) && <option value={project}>{project}</option>}
        {projects.value?.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
      </select>
      {projects.error && <p className="read-errors">{projects.error}</p>}
    </div>
  );

  return (
    <fieldset className="field workspace-chooser">
      <legend className="field-label">Dónde trabajar</legend>
      {offered.length > 1 && (
        <div className="segmented" role="radiogroup" aria-label="Dónde trabajar">
          {offered.map((entry) => (
            <button key={entry} type="button" role="radio" aria-checked={mode === entry} className={mode === entry ? "selected" : ""} disabled={pending !== null}
              onClick={() => { setMode(entry); setError(null); setFolder(null); }}>{MODES[entry]}</button>
          ))}
        </div>
      )}

      {mode === "existing" && (
        <>
          <span className="field-help">{target.kind === "github-epic"
            ? `Las issues se publican en el primer repositorio elegido, como sub-issues de la épica ${target.nameWithOwner}#${target.issue}. El orden es el de entrega.`
            : `La sesión lee y documenta en estos repositorios; las tareas se publican en ${target.bug ? "el Bug" : "la HU"}. El orden es el de entrega.`}</span>
          {listed.length === 0 && <p className="muted small">No hay repositorios de {tracker === "azure" ? "Azure DevOps" : "GitHub"} guardados: agrega una carpeta, descarga uno o crea uno nuevo.</p>}
          {listed.map((path) => {
            const position = chosen.indexOf(path);
            return (
              <label key={path} className="choice">
                <input type="checkbox" checked={position >= 0} onChange={(event) => toggle(path, event.target.checked)} />
                <span className="grow ellipsis" title={path}>{repositoryName(path)}</span>
                {position >= 0 && chosen.length > 1 && <span className="order" aria-label={`Orden ${position + 1}`}>{position + 1}</span>}
              </label>
            );
          })}
          <DirectoryPicker label="Agregar carpeta…" onPick={async (path) => { await onAddRepository(path); if (!chosen.includes(path)) onChange([...chosen, path]); }} />
        </>
      )}

      {provisioning && (
        <div className="stack">
          {mode === "repo-clone" && tracker === "azure" && (
            <>
              {projectSelect}
              <div className="field">
                <label className="field-label" htmlFor="provision-repository">Repositorio</label>
                <select id="provision-repository" className="input" value={repository} disabled={!project} onChange={(event) => { setRepository(event.target.value); setFolder(null); }}>
                  <option value="">{!project ? "Elige primero el proyecto" : repositories.value ? "Elige un repositorio…" : "Cargando repositorios…"}</option>
                  {repositories.value?.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
                </select>
                {repositories.error && <p className="read-errors">{repositories.error}</p>}
              </div>
            </>
          )}
          {mode === "repo-clone" && tracker === "github" && (
            <div className="field">
              <label className="field-label" htmlFor="provision-repository">Repositorio de GitHub</label>
              <input id="provision-repository" className="input mono" value={repository} placeholder="owner/nombre" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(event) => { setRepository(event.target.value); setFolder(null); }} />
              <span className="field-help">Por defecto, el de la épica.</span>
            </div>
          )}
          {mode === "repo-create" && tracker === "azure" && projectSelect}
          {mode === "repo-create" && tracker === "github" && (
            <div className="field">
              <label className="field-label" htmlFor="provision-owner">Cuenta u organización</label>
              <select id="provision-owner" className="input" value={owner} onChange={(event) => setOwner(event.target.value)}>
                {!owners.value && <option value="">Cargando cuentas…</option>}
                {owners.value?.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
              {owners.error && <p className="read-errors">{owners.error}</p>}
            </div>
          )}
          {mode === "repo-create" && (
            <div className="field">
              <label className="field-label" htmlFor="provision-name">Nombre del repositorio</label>
              <input id="provision-name" className="input mono" value={name} placeholder="mi-servicio" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(event) => { setName(event.target.value.replace(/\s+/g, "-")); setFolder(null); }} />
              <span className="field-help">{tracker === "github" ? "Privado, con un README para que exista main." : "Con un primer commit en main, desde donde Code crea la rama de la HU."}</span>
            </div>
          )}
          <div className="field">
            <span className="field-label">Carpeta donde queda</span>
            <div className="row destination">
              <span className="grow ellipsis mono small" title={parent}>{parent || "Sin elegir"}</span>
              <DirectoryPicker label="Elegir carpeta…" confirmLabel="Usar esta carpeta" onPick={(path) => setParent(path)} />
            </div>
            <input className="input mono" aria-label="Nombre de la carpeta" value={folder ?? folderName(remote)} placeholder="nombre-de-carpeta" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={(event) => setFolder(event.target.value.replace(/[\\/]/g, ""))} />
            {destination && <span className="field-help">Quedará en <span className="mono">{destination}</span>, que no debe existir.</span>}
          </div>
          {problems.length > 0 && <ul className="form-errors">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          <div className="row">
            <button type="button" className="button" disabled={!prepared || problems.length > 0 || pending !== null} onClick={() => void start()}>
              {pending ? (mode === "repo-clone" ? "Descargando…" : "Creando…") : mode === "repo-clone" ? "Descargar" : "Crear repositorio"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="read-errors" role="alert">{error}</p>}
    </fieldset>
  );
}
