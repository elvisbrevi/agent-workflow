import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ask, isDesktop } from "./lib/platform.ts";
import type { CatalogCommand, CommandCatalog } from "../../src/cli/command-catalog-schema.ts";
import { backend, errorText, onRunExit, onRunOutput, onRunStarted, webTransport, type Diagnostics, type GuiSettings, type RunOutput, type SettingsDocument } from "./lib/backend.ts";
import { matchesPendingUpdate, prepareUpdate, updateBusy, type UpdateStatus } from "./lib/update.ts";
import { HttpError } from "./lib/http-transport.ts";
import { renderCommandLine } from "./lib/command-line.ts";
import { initialRunsState, isFinished, runsReducer, type RunState } from "./lib/runs.ts";
import { interviewUrl } from "./lib/output.ts";
import { cliOf } from "./lib/models.ts";
import { prepareSetup } from "./lib/run-request.ts";
import { repairCli, repairPrompt, setupProblems } from "./lib/setup-check.ts";
import { runTitle } from "./lib/work.ts";
import { useAgentModels, useAssignedWork, useRunLog } from "./hooks.ts";
import { ActivityView } from "./components/ActivityView.tsx";
import { PreferencesView } from "./components/PreferencesView.tsx";
import { Sidebar, type View } from "./components/Sidebar.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { WorkView } from "./components/WorkView.tsx";

type CatalogState = { kind: "loading" } | { kind: "ready"; catalog: CommandCatalog } | { kind: "error"; message: string };

/** Output arrives a line per event; applying it once per frame keeps a verbose run from re-rendering per line. */
function useBatchedOutput(dispatch: (lines: RunOutput[]) => void) {
  const queue = useRef<RunOutput[]>([]);
  const frame = useRef<number | null>(null);
  return useCallback((output: RunOutput) => {
    queue.current.push(output);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const lines = queue.current;
      queue.current = [];
      dispatch(lines);
    });
  }, [dispatch]);
}

/** What the operator confirms before a session opens: what it may change, in their terms. */
const CONFIRMATION: Record<string, string> = {
  plan: "Plan abre una sesión del agente que puede editar la documentación del repositorio y publicará las tareas resultantes.",
  code: "Code abre sesiones del agente que implementan, empujan, mergean y cierran tareas.",
  setup: "Una sesión del agente revisará y reparará la configuración de este equipo. No edita repositorios ni el tracker.",
  "repo-clone": "Descarga el repositorio en una carpeta nueva, con las credenciales de lz.",
  "repo-create": "Crea un repositorio privado en el tracker, con un primer commit en main, y lo descarga en una carpeta nueva.",
  update: "Actualiza desde main el CLI, las skills, el escritorio y la web instalada. La web se reiniciará; al terminar tendrás que reiniciar la app de escritorio.",
};

export function App() {
  const [settingsDocument, setSettingsDocument] = useState<SettingsDocument | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: "loading" });
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [view, setView] = useState<View>({ kind: sessionStorage.getItem("lz:update-result") || sessionStorage.getItem("lz:update-pending") ? "preferences" : "work" });
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [startingUpdate, setStartingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [state, dispatch] = useReducer(runsReducer, initialRunsState);
  const pendingStart = useRef(false);
  const settings = settingsDocument?.settings ?? null;
  const catalog = catalogState.kind === "ready" ? catalogState.catalog : null;
  // Every finished run can change the work, the history and what is configured.
  const finished = state.runs.filter((run) => run.exit !== null).length;
  const work = useAssignedWork(catalog, settings?.repositories ?? [], finished);
  const history = useRunLog(finished);
  const { models } = useAgentModels(catalog);

  const loadCatalog = useCallback(async () => {
    setCatalogState({ kind: "loading" });
    try {
      setCatalogState({ kind: "ready", catalog: await backend.loadCatalog() });
    } catch (error) {
      setCatalogState({ kind: "error", message: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void backend.getSettings().then(setSettingsDocument, (error) => setNotice(errorText(error)));
    void loadCatalog();
    const cancel = () => webTransport.cancelPendingRequests();
    if (!isDesktop) window.addEventListener("pagehide", cancel);
    return () => { window.removeEventListener("pagehide", cancel); };
  }, [loadCatalog]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let seenJob: string | null = null;
    const poll = async () => {
      try {
        const status = await backend.getUpdateStatus();
        if (stopped) return;
        setUpdateStatus(status);
        if (!isDesktop) {
          const pending = sessionStorage.getItem("lz:update-pending");
          webTransport.setUpdating(updateBusy(status) || pending !== null);
          if (status.job?.status === "queued" || status.job?.status === "running") seenJob = status.job.id;
          if (status.job?.status === "succeeded" && (matchesPendingUpdate(status.job.id, pending) || seenJob === status.job.id)) {
            sessionStorage.removeItem("lz:update-pending");
            sessionStorage.setItem("lz:update-result", status.job.id);
            window.location.reload(); return;
          }
          if (status.job?.status === "failed" && (pending === null || matchesPendingUpdate(status.job.id, pending))) {
            if (pending !== null || seenJob === status.job.id) sessionStorage.setItem("lz:update-result", status.job.id);
            sessionStorage.removeItem("lz:update-pending"); webTransport.setUpdating(status.updating);
          }
        }
      } catch { /* The update replaces and restarts the backend; keep the last progress. */ }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
    };
    if (!isDesktop && sessionStorage.getItem("lz:update-pending")) webTransport.setUpdating(true);
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!catalog) return;
    let cancelled = false;
    backend.diagnose(catalog.environment.map(({ name, secret }) => ({ name, secret })))
      .then((next) => { if (!cancelled) setDiagnostics(next); }, () => undefined);
    return () => { cancelled = true; };
  }, [catalog, finished]);

  // The `lz` skill edits gui.json from outside the window; rereading it on focus
  // picks that up without a restart. An identical file leaves the state untouched.
  useEffect(() => {
    const reread = () => {
      void backend.getSettings().then((next) => {
        setSettingsDocument((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      }, () => undefined);
    };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);

  const pushOutput = useBatchedOutput(useCallback((lines: RunOutput[]) => dispatch({ type: "output", lines }), []));
  useEffect(() => {
    if (!isDesktop && !catalog) return;
    const unlisten = [onRunOutput(pushOutput), onRunExit((exit) => dispatch({ type: "exit", exit })), onRunStarted(({ started, args }) => {
      const command = catalog?.commands.find((candidate) => candidate.name === args[0]);
      if (catalog && command) dispatch({ type: "started", started, args, command: command.name, line: renderCommandLine(catalog, command, args, catalog.binary), effect: command.effect, output: command.output });
    })];
    return () => { for (const promise of unlisten) void promise.then((stop) => stop()); };
  }, [pushOutput, !!catalog]);

  useEffect(() => {
    const theme = settings?.theme ?? "system";
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [settings?.theme]);

  const saveSettings = useCallback(async (next: GuiSettings, announce = true) => {
    try {
      setSettingsDocument(await backend.saveSettings(next));
      setNotice(announce ? "Ajustes guardados." : null);
    } catch (error) {
      setNotice(errorText(error));
    }
  }, []);

  const selectRepository = (repository: string) => {
    if (settings && repository && repository !== settings.activeRepository) void saveSettings({ ...settings, activeRepository: repository }, false);
  };

  /** Rejects when the server refuses a folder, so the picker shows why in its own dialog. */
  const addRepository = async (repository: string) => {
    if (!settings) return;
    // The server registers a folder within its configured roots; the page never writes the list.
    if (!isDesktop) { setSettingsDocument(await backend.addRepository(repository)); return; }
    if (settings.repositories.includes(repository)) { selectRepository(repository); return; }
    await saveSettings({ ...settings, repositories: [...settings.repositories, repository], activeRepository: repository }, false);
  };

  /** Starts a run; its id once it is running, or null when it did not start. */
  const start = async (command: CatalogCommand, args: string[], follow: boolean): Promise<number | null> => {
    if (!catalog || !settings || pendingStart.current) return null;
    pendingStart.current = true;
    try {
      if (command.name === "update" || (command.effect !== "read" && settings.confirmWrites)) {
        const confirmed = await ask(`${runTitle(command.name, args)}\n\n${CONFIRMATION[command.name] ?? "Este comando modifica el repositorio o el tracker."}`, { title: "¿Ejecutar?", kind: "warning", okLabel: "Ejecutar", cancelLabel: "Cancelar" });
        if (!confirmed) return null;
      }
      const directoryIndex = args.indexOf("--working-directory");
      const cwd = directoryIndex >= 0 ? args[directoryIndex + 1]?.split(",")[0]?.trim() : settings.activeRepository ?? undefined;
      const started = await backend.startRun(args, { cwd });
      dispatch({ type: "started", started, args, command: command.name, line: renderCommandLine(catalog, command, args, catalog.binary), effect: command.effect, output: command.output });
      // A run is followed where it is tracked: its progress opens in Ejecuciones.
      if (follow) setView({ kind: "activity", runId: null, liveId: started.id });
      return started.id;
    } catch (error) {
      setNotice(errorText(error));
      return null;
    } finally { pendingStart.current = false; }
  };
  /** Plan, Code and setup open where runs are followed; resolves true once running, so a form can close. */
  const run = async (command: CatalogCommand, args: string[]): Promise<boolean> => (await start(command, args, true)) !== null;
  /** A download or a creation stays in the form that started it, which follows it there. */
  const provision = (command: CatalogCommand, args: string[]): Promise<number | null> => start(command, args, false);

  const update = async () => {
    if (!catalog || startingUpdate) return;
    setStartingUpdate(true); setUpdateError(null);
    try {
      if (isDesktop) {
        const prepared = prepareUpdate(catalog);
        if (prepared) await start(prepared.command, prepared.args, false);
      } else {
        if (!await ask(CONFIRMATION.update!, { title: "¿Actualizar?", kind: "warning", okLabel: "Actualizar", cancelLabel: "Cancelar" })) return;
        // Persist before scheduling: the response itself may be interrupted by restart.
        sessionStorage.setItem("lz:update-pending", `scheduling:${updateStatus?.job?.id ?? "none"}`);
        webTransport.setUpdating(true);
        const status = await backend.startUpdate();
        if (status.job) sessionStorage.setItem("lz:update-pending", status.job.id);
        setUpdateStatus(status);
      }
    } catch (error) {
      if (error instanceof HttpError) { sessionStorage.removeItem("lz:update-pending"); webTransport.setUpdating(false); }
      setUpdateError(errorText(error));
    }
    finally { setStartingUpdate(false); }
  };

  const rerun = (previous: RunState) => {
    const command = catalog?.commands.find((candidate) => candidate.name === previous.command);
    if (command) void run(command, [...previous.args]);
  };

  const cancel = async (id: number) => {
    dispatch({ type: "cancelling", id });
    try {
      await backend.cancelRun(id);
    } catch (error) {
      setNotice(errorText(error));
    }
  };

  const preferredCli = catalog ? cliOf(catalog, typeof settings?.flagDefaults["--cli"] === "string" ? settings.flagDefaults["--cli"] : undefined) : "";
  const problems = catalog && settings ? setupProblems({ catalog, diagnostics, models, repositories: work.loading ? [] : work.results, preferredCli }) : [];
  const repairing = state.runs.some((entry) => entry.command === "setup" && (entry.status === "running" || entry.status === "cancelling"));
  const repairWith = catalog ? repairCli(catalog, models, diagnostics, preferredCli) : null;
  const canRepair = !!catalog?.commands.some((command) => command.name === "setup") && repairWith !== null && problems.some((problem) => problem.fixable);
  const repair = () => {
    if (!catalog || !settings || !repairWith) return;
    const prepared = prepareSetup(catalog, settings.activeRepository, repairPrompt(problems), repairWith);
    if (prepared) void run(prepared.command, prepared.args);
  };
  const setup = { problems, canRepair, repairing, onRepair: repair };

  const running = state.runs.filter((entry) => entry.status === "running" || entry.status === "cancelling").length;
  const openRun = (id: number) => setView({ kind: "activity", runId: null, liveId: id });
  // A plan waiting for answers is announced everywhere but on its own page.
  const waiting = state.runs.find((entry) => !isFinished(entry) && interviewUrl(entry.stderr) !== null
    && !(view.kind === "activity" && view.liveId === entry.id));

  let main: ReactNode;
  if (!settingsDocument) {
    main = <div className="page muted">Cargando…</div>;
  } else if (catalogState.kind === "loading") {
    main = <div className="page muted">Conectando con lz…</div>;
  } else if (catalogState.kind === "error") {
    main = (
      <div className="page">
        <h1>No se pudo iniciar lz</h1>
        <div className="callout error">{catalogState.message}</div>
        <p>Instala o actualiza lz con <code>lz update</code> (o <code>install.sh --all-global</code>) en {isDesktop ? "este equipo" : "el servidor"} y vuelve a intentar.</p>
        <div className="row"><button type="button" className="button primary" onClick={loadCatalog}>Reintentar</button></div>
      </div>
    );
  } else if (catalog && settings && view.kind === "activity") {
    main = (
      <ActivityView runs={state.runs} history={history} selected={view.liveId} focusRunId={view.runId}
        onSelect={(id) => setView({ kind: "activity", runId: null, liveId: id })}
        onCancel={cancel} onRerun={rerun} onDismiss={(id) => dispatch({ type: "close", id })}
        onOpenHistory={(runId) => setView({ kind: "activity", runId, liveId: null })} />
    );
  } else if (catalog && settings && view.kind === "plan") {
    main = (
      <PlanView catalog={catalog} settings={settings} work={work} runs={state.runs} models={models} setup={setup}
        onRun={run} onProvision={provision} onSaveSettings={saveSettings} onAddRepository={addRepository} />
    );
  } else if (catalog && settings && view.kind === "preferences") {
    main = <PreferencesView catalog={catalog} document={settingsDocument} diagnostics={diagnostics} models={models} setup={setup} onSave={saveSettings} onAddRepository={addRepository}
      updateStatus={updateStatus} updateError={updateError} updating={startingUpdate} runs={state.runs} onUpdate={update} />;
  } else if (catalog && settings) {
    main = (
      <WorkView
        catalog={catalog}
        settings={settings}
        work={work}
        history={history.runs}
        runs={state.runs}
        models={models}
        setup={setup}
        onRun={run}
        onProvision={provision}
        onSaveSettings={saveSettings}
        onAddRepository={addRepository}
        onOpenActivity={(runId) => setView({ kind: "activity", runId, liveId: null })}
        onFocusRun={openRun}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        view={view}
        running={running}
        attention={problems.length}
        repositories={settings?.repositories ?? []}
        activeRepository={settings?.activeRepository ?? null}
        onNavigate={setView}
        onSelectRepository={selectRepository}
        onAddRepository={addRepository}
      />
      <div className="workspace">
        {notice && (
          <div className="notice" role="status">
            <span className="grow">{notice}</span>
            <button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={() => setNotice(null)}>✕</button>
          </div>
        )}
        {waiting && (
          <div className="notice attention" role="status">
            <span className="grow"><strong>{runTitle(waiting.command, waiting.args)}</strong> espera tus respuestas.</span>
            <button type="button" className="button primary small" onClick={() => openRun(waiting.id)}>Responder</button>
          </div>
        )}
        {settingsDocument?.error && view.kind !== "preferences" && (
          <div className="notice error">
            <span className="grow">{settingsDocument.error}</span>
            <button type="button" className="link-button" onClick={() => setView({ kind: "preferences" })}>Revisar</button>
          </div>
        )}
        <main className="main">{main}</main>
      </div>
    </div>
  );
}
