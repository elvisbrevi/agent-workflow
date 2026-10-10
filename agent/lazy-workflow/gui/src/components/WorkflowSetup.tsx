import { useEffect, useRef, useState } from "react";
import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { AssignedWork } from "../../../src/workspace/assigned-work.ts";
import { applicableFlags, type FlagValues, type FlagValue } from "../lib/command-line.ts";
import { readTool, repositoryName } from "../lib/work.ts";
import { errorText } from "../lib/backend.ts";
import { FlagField } from "./FlagField.tsx";

interface Props {
  catalog: CommandCatalog;
  command: CatalogCommand;
  values: FlagValues;
  repositories: readonly string[];
  step: number;
  onChange: (values: FlagValues) => void;
  onScopeReady: (ready: boolean) => void;
  onSaveDefaults: () => void;
}

const BASIC = new Set(["--working-directory", "--hu", "--ticket", "--prompt", "--cli", "--model", "--variant", "--interview"]);
const asText = (value: FlagValue): string => typeof value === "string" ? value : "";

export function WorkflowSetup({ catalog, command, values, repositories, step, onChange, onScopeReady, onSaveDefaults }: Props) {
  const [tracker, setTracker] = useState<"github" | "azure">(values["--hu"] ? "azure" : "github");
  const trackerChosen = useRef(!!values["--hu"]);
  const [chosen, setChosen] = useState(!!values["--hu"]);
  const [assigned, setAssigned] = useState<AssignedWork | null>(null);
  const [children, setChildren] = useState<Array<{ id: number; type: string; title?: string; state: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!values["--working-directory"]);
  const [manualHu, setManualHu] = useState(false);
  const [manualTicket, setManualTicket] = useState(false);
  const repository = asText(values["--working-directory"]).split(",")[0]?.trim() ?? "";
  const hu = asText(values["--hu"]);
  const flags = applicableFlags(catalog, command);
  const set = (flag: string) => (value: FlagValue) => onChange({ ...values, [flag]: value, ...(flag === "--cli" ? { "--model": "", "--variant": "" } : {}), ...(flag === "--hu" ? { "--ticket": "" } : {}) });
  const field = (name: string, label?: string) => {
    const flag = flags.find((flag) => flag.flag === name);
    return flag ? <FlagField key={name} catalog={catalog} flag={label ? { ...flag, label } : flag} value={values[name]} values={values} repositories={repositories} onChange={set(name)} /> : null;
  };

  useEffect(() => { onScopeReady((chosen || !loading) && (tracker === "github" || /^[1-9]\d*$/.test(hu))); }, [tracker, hu, loading, chosen, onScopeReady]);
  useEffect(() => { if (hu) { trackerChosen.current = true; setChosen(true); setTracker("azure"); } }, [hu]);
  useEffect(() => {
    let cancelled = false;
    setAssigned(null); setError(null);
    if (!repository) { setLoading(false); return; }
    setLoading(true);
    void readTool<AssignedWork>(catalog, "work-assigned", { "--working-directory": repository }).then((result) => {
      if (cancelled) return;
      setAssigned(result);
      // Origin supplies an initial suggestion; an explicit HU always wins.
      if (!trackerChosen.current) setTracker(result.tracker);
    }, (error) => { if (!cancelled) setError(errorText(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [catalog, repository]);
  useEffect(() => {
    let cancelled = false;
    setChildren([]);
    if (!/^[1-9]\d*$/.test(hu) || command.name !== "code") return;
    void readTool<Array<{ id: number; type: string; title?: string; state: string }>>(catalog, "hu-children-info", { "--hu": hu }).then((items) => { if (!cancelled) setChildren(items.filter((item) => item.type === "Task" || item.type === "Bug")); }, (error) => { if (!cancelled) setError(errorText(error)); });
    return () => { cancelled = true; };
  }, [catalog, hu, command.name]);

  const stories = new Map<number, string>();
  for (const item of assigned?.tracker === "azure" ? assigned.items : []) {
    if (["User Story", "Product Backlog Item", "Requirement"].includes(item.type)) stories.set(item.id, item.title);
    if (item.hu && !stories.has(item.hu)) stories.set(item.hu, `HU de ${item.title}`);
  }
  const ticket = asText(values["--ticket"]);
  return <div className="workflow-setup">
    {step === 0 && <section className="card">
      <h2>1. Elige dónde y qué trabajar</h2>
      {field("--working-directory", "Carpetas de trabajo")}
      <fieldset className="tracker-choice"><legend>Plataforma</legend><div className="segmented">{(["github", "azure"] as const).map((source) => <button key={source} type="button" aria-pressed={tracker === source} className={tracker === source ? "selected" : ""} onClick={() => { trackerChosen.current = true; setChosen(true); setTracker(source); onChange({ ...values, "--hu": "", "--ticket": "", "--base-branch": "" }); }}>{source === "github" ? "GitHub" : "Azure DevOps"}</button>)}</div></fieldset>
      {tracker === "github" ? <div className="scope-info"><strong>{command.name === "code" ? "Procesar la cola elegible" : "Crear un plan para este repositorio"}</strong><p>{command.name === "code" ? "Code entrega las issues ready-for-agent que estén sin asignar y sin bloqueos, una tras otra. Las issues asignadas a una persona quedan fuera de esa cola." : "Describe la idea y Plan publicará las issues con sus dependencias."}</p></div> : <>
        <div className="field"><label className="field-label" htmlFor="workflow-hu">Historia de usuario (HU)</label>
          <select className="input" id="workflow-hu" value={manualHu ? "manual" : hu} onChange={(event) => { setManualHu(event.target.value === "manual"); if (event.target.value !== "manual") set("--hu")(event.target.value); }}>
            <option value="">Selecciona una HU…</option>{[...stories].map(([id, title]) => <option key={id} value={id}>#{id} · {title}</option>)}
            {hu && !stories.has(Number(hu)) && <option value={hu}>HU #{hu}</option>}<option value="manual">Buscar otra HU por número…</option>
          </select>{manualHu && field("--hu", "Número de HU")}
        </div>
        {command.name === "code" && hu && <div className="field"><label className="field-label" htmlFor="workflow-ticket">Qué quieres implementar</label>
          <select className="input" id="workflow-ticket" value={manualTicket ? "manual" : ticket} onChange={(event) => { setManualTicket(event.target.value === "manual"); if (event.target.value !== "manual") set("--ticket")(event.target.value); }}><option value="">Todas las tareas elegibles de la HU</option>{children.map((item) => <option key={item.id} value={item.id}>#{item.id} · {item.title ?? item.type} · {item.state}</option>)}{ticket && !children.some((item) => String(item.id) === ticket) && <option value={ticket}>Task #{ticket}</option>}<option value="manual">Otra tarea por número…</option></select>{manualTicket && field("--ticket", "Número de tarea")}
        </div>}
      </>}
      {loading && <p className="muted small" role="status">Consultando tareas asignadas…</p>}
      {error && <p className="query-errors" role="status">{error} Puedes indicar el número de HU manualmente.</p>}
      {command.name === "plan" && field("--prompt", "Qué quieres planificar")}
    </section>}
    {step === 1 && <section className="card"><h2>2. Ajusta la ejecución</h2><p className="muted">Los valores predeterminados sirven para empezar. Cambia solo lo que necesites.</p>
      <div className="field-grid">{field("--cli", "Asistente")}{field("--model", "Modelo")}{field("--variant", "Esfuerzo")}{command.name === "plan" && field("--interview", "Preguntas antes de planificar")}</div>
      {command.name === "code" && field("--prompt", "Indicaciones adicionales (opcional)")}
      <details className="workflow-advanced"><summary>Opciones avanzadas</summary><div className="field-grid">{flags.filter((flag) => !BASIC.has(flag.flag)).map((flag) => <FlagField key={flag.flag} catalog={catalog} flag={flag} value={values[flag.flag]} values={values} repositories={repositories} onChange={set(flag.flag)} />)}</div><button type="button" className="button ghost" onClick={onSaveDefaults}>Usar estas opciones por defecto</button></details>
    </section>}
    {step === 2 && <section className="card"><h2>3. Revisa y ejecuta</h2><dl className="run-summary"><dt>Acción</dt><dd>{command.name === "plan" ? "Planificar y publicar tareas" : "Implementar, verificar y entregar"}</dd><dt>Plataforma</dt><dd>{tracker === "github" ? "GitHub" : "Azure DevOps"}</dd><dt>Trabajo</dt><dd>{tracker === "github" ? command.name === "code" ? "Cola ready-for-agent completa" : "Nuevo plan de issues" : `HU #${hu}${ticket ? ` · Task #${ticket}` : command.name === "code" ? " · Todas sus tareas elegibles" : ""}`}</dd><dt>Carpetas</dt><dd>{asText(values["--working-directory"]).split(",").map((path) => <span key={path} title={path}>{repositoryName(path)}<small>{path}</small></span>)}</dd><dt>Asistente</dt><dd>{asText(values["--cli"]) || catalog.defaultCli} · {asText(values["--model"]) || "Modelo predeterminado"}</dd></dl>
      {asText(values["--prompt"]) && <div className="scope-info"><strong>Tus indicaciones</strong><p>{asText(values["--prompt"])}</p></div>}
      <div className="callout">{command.name === "plan" ? "Plan publicará las tareas. Después podrás revisarlas y preparar Code." : "Code modifica los repositorios y el tracker; puede publicar y completar entregas."}</div>
    </section>}
  </div>;
}
