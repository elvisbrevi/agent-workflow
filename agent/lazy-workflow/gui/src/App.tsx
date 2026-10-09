import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ask, isDesktop } from "./lib/platform.ts";
import type { CatalogCommand, CommandCatalog } from "../../src/cli/command-catalog-schema.ts";
import { backend, errorText, onRunExit, onRunOutput, onRunStarted, type Diagnostics, type FlagDefault, type GuiSettings, type RunOutput, type SettingsDocument } from "./lib/backend.ts";
import { applicableFlags, isSet, renderCommandLine, type FlagValues } from "./lib/command-line.ts";
import { initialValues } from "./lib/form-defaults.ts";
import { initialRunsState, runsReducer, type RunState } from "./lib/runs.ts";
import { CommandView } from "./components/CommandView.tsx";
import { EFFECT_CONFIRMATION } from "./components/EffectBadge.tsx";
import { HistoryView } from "./components/HistoryView.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { RunDock } from "./components/RunDock.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar, type View } from "./components/Sidebar.tsx";

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

/** What `commandDefaults` keeps from a form: everything but the repository, which follows the active one. */
function storableDefaults(catalog: CommandCatalog, command: CatalogCommand, values: FlagValues): Record<string, FlagDefault> {
  const stored: Record<string, FlagDefault> = {};
  for (const flag of applicableFlags(catalog, command)) {
    const value = values[flag.flag];
    if (flag.flag === "--working-directory" || flag.kind === "secret" || !isSet(value)) continue;
    stored[flag.flag] = Array.isArray(value) ? value.filter((entry) => entry.trim()) : (value as string | boolean);
  }
  return stored;
}

export function App() {
  const [settingsDocument, setSettingsDocument] = useState<SettingsDocument | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: "loading" });
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [forms, setForms] = useState<Record<string, FlagValues>>({});
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [state, dispatch] = useReducer(runsReducer, initialRunsState);
  const pendingStart = useRef(false);
  const settings = settingsDocument?.settings ?? null;
  const catalog = catalogState.kind === "ready" ? catalogState.catalog : null;

  const loadCatalog = useCallback(async () => {
    setCatalogState({ kind: "loading" });
    try {
      setCatalogState({ kind: "ready", catalog: await backend.loadCatalog() });
    } catch (error) {
      setCatalogState({ kind: "error", message: errorText(error) });
    }
  }, []);

  const refreshDiagnostics = useCallback(async (current: CommandCatalog | null) => {
    try {
      setDiagnostics(await backend.diagnose(current?.environment.map(({ name, secret }) => ({ name, secret })) ?? []));
    } catch (error) {
      setNotice(errorText(error));
    }
  }, []);

  useEffect(() => {
    void backend.getSettings().then(setSettingsDocument, (error) => setNotice(errorText(error)));
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => { void refreshDiagnostics(catalog); }, [catalog, refreshDiagnostics]);

  // The skill edits gui.json from outside the window; rereading it on focus picks
  // that up without a restart. An identical file leaves the state untouched.
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
      const command = catalog?.commands.find((command) => command.name === args[0]);
      if (catalog && command) dispatch({ type: "started", started, args, command: command.name, line: renderCommandLine(catalog, command, args, catalog.binary), effect: command.effect, output: command.output });
    })];
    return () => { for (const promise of unlisten) void promise.then((stop) => stop()); };
  }, [pushOutput, !!catalog]);

  useEffect(() => {
    const theme = settings?.theme ?? "system";
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [settings?.theme]);

  const saveSettings = useCallback(async (next: GuiSettings) => {
    try {
      const saved = await backend.saveSettings(next);
      const lzChanged = saved.settings.lzCommand !== settingsDocument?.settings.lzCommand
        || JSON.stringify(saved.settings.extraPath) !== JSON.stringify(settingsDocument?.settings.extraPath)
        || saved.settings.inheritShellEnvironment !== settingsDocument?.settings.inheritShellEnvironment;
      setSettingsDocument(saved);
      setNotice("Configuracion guardada.");
      if (lzChanged || catalogState.kind === "error") void loadCatalog();
      else void refreshDiagnostics(catalog);
    } catch (error) {
      setNotice(errorText(error));
    }
  }, [settingsDocument, catalogState.kind, catalog, loadCatalog, refreshDiagnostics]);

  const valuesFor = (command: CatalogCommand): FlagValues =>
    forms[command.name] ?? (catalog && settings ? initialValues(catalog, command, settings) : {});

  const openCommand = (name: string, preset?: Record<string, string>) => {
    if (preset && catalog && settings) {
      const command = catalog.commands.find((candidate) => candidate.name === name);
      if (command) setForms((current) => ({ ...current, [name]: { ...(current[name] ?? initialValues(catalog, command, settings)), ...preset } }));
    }
    setView({ kind: "command", name });
  };

  const selectRepository = (repository: string) => {
    if (!settings || !repository) return;
    const previous = settings.activeRepository;
    setForms((current) => Object.fromEntries(Object.entries(current).map(([name, values]) => [
      name,
      values["--working-directory"] === previous ? { ...values, "--working-directory": repository } : values,
    ])));
    void saveSettings({ ...settings, activeRepository: repository });
  };

  const run = async (command: CatalogCommand, args: string[], stdin?: string) => {
    if (!catalog || !settings) return;
    if (!isDesktop && pendingStart.current) return;
    pendingStart.current = true;
    try {
      if (command.effect !== "read" && settings.confirmWrites) {
        const line = renderCommandLine(catalog, command, args, catalog.binary);
        const confirmed = await ask(`${EFFECT_CONFIRMATION[command.effect]}\n\n${line}`, { title: "¿Ejecutar?", kind: "warning", okLabel: "Ejecutar", cancelLabel: "Cancelar" });
        if (!confirmed) return;
      }
      const started = await backend.startRun(args, { stdin, cwd: settings.activeRepository ?? undefined });
      dispatch({ type: "started", started, args, command: command.name, line: renderCommandLine(catalog, command, args, catalog.binary), effect: command.effect, output: command.output });
      setDockCollapsed(false);
    } catch (error) {
      setNotice(errorText(error));
    } finally { pendingStart.current = false; }
  };

  const rerun = (previous: RunState) => {
    const command = catalog?.commands.find((candidate) => candidate.name === previous.command);
    if (!command) return;
    if (command.stdinFlag) {
      openCommand(command.name);
      return;
    }
    void run(command, [...previous.args]);
  };

  const cancel = async (id: number) => {
    dispatch({ type: "cancelling", id });
    try {
      await backend.cancelRun(id);
    } catch (error) {
      setNotice(errorText(error));
    }
  };

  const running = state.runs.filter((entry) => entry.status === "running" || entry.status === "cancelling").length;

  let main: ReactNode;
  if (!settingsDocument) {
    main = <div className="page muted">Cargando…</div>;
  } else if (view.kind === "settings") {
    main = (
      <SettingsView
        catalog={catalog}
        document={settingsDocument}
        diagnostics={diagnostics}
        onSave={saveSettings}
        onOpenCommand={openCommand}
        onReloadEnvironment={() => { void backend.reloadEnvironment().then(() => refreshDiagnostics(catalog)); }}
      />
    );
  } else if (view.kind === "history") {
    main = <HistoryView focusRunId={view.runId} />;
  } else if (catalogState.kind === "loading") {
    main = <div className="page muted">Leyendo <code>lz catalog</code>…</div>;
  } else if (catalogState.kind === "error") {
    main = (
      <div className="page">
        <h1>No se pudo leer el CLI</h1>
        <div className="callout error">{catalogState.message}</div>
        <p>
          La GUI dibuja lo que <code>lz catalog</code> describe. Instala o actualiza lz (<code>install.sh --all-global</code> o <code>lz update</code>),
          o apunta <code>lzCommand</code> al <code>main.ts</code> de un checkout.
        </p>
        <div className="row">
          <button type="button" className="button primary" onClick={loadCatalog}>Reintentar</button>
          <button type="button" className="button" onClick={() => setView({ kind: "settings" })}>Configuracion</button>
        </div>
      </div>
    );
  } else if (view.kind === "command" && catalog && settings) {
    const command = catalog.commands.find((candidate) => candidate.name === view.name);
    main = command ? (
      <CommandView
        key={command.name}
        catalog={catalog}
        command={command}
        values={valuesFor(command)}
        repositories={settings.repositories}
        onChange={(values) => setForms((current) => ({ ...current, [command.name]: values }))}
        onReset={() => setForms((current) => ({ ...current, [command.name]: initialValues(catalog, command, settings) }))}
        onSaveDefaults={(values) => void saveSettings({ ...settings, commandDefaults: { ...settings.commandDefaults, [command.name]: storableDefaults(catalog, command, values) } })}
        onRun={(args, stdin) => void run(command, args, stdin)}
      />
    ) : <div className="page">El comando {view.name} no esta en el catalogo de este lz.</div>;
  } else if (catalog && settings) {
    main = (
      <HomeView
        catalog={catalog}
        diagnostics={diagnostics}
        repositories={settings.repositories}
        activeRepository={settings.activeRepository}
        onOpenCommand={openCommand}
        onRefreshDiagnostics={() => void refreshDiagnostics(catalog)}
        onOpenSettings={() => setView({ kind: "settings" })}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        catalog={catalog}
        view={view}
        running={running}
        repositories={settings?.repositories ?? []}
        activeRepository={settings?.activeRepository ?? null}
        onNavigate={setView}
        onSelectRepository={selectRepository}
      />
      <div className="workspace">
        {notice && (
          <div className="notice" role="status">
            <span className="grow">{notice}</span>
            <button type="button" className="icon-button" onClick={() => setNotice(null)}>✕</button>
          </div>
        )}
        {settingsDocument?.error && view.kind !== "settings" && (
          <div className="notice error">
            <span className="grow">{settingsDocument.error}</span>
            <button type="button" className="link-button" onClick={() => setView({ kind: "settings" })}>Revisar</button>
          </div>
        )}
        <main className="main">{main}</main>
        <RunDock
          runs={state.runs}
          activeId={state.activeId}
          collapsed={dockCollapsed}
          onToggle={() => setDockCollapsed(!dockCollapsed)}
          onFocus={(id) => { dispatch({ type: "focus", id }); setDockCollapsed(false); }}
          onCancel={cancel}
          onClose={(id) => dispatch({ type: "close", id })}
          onRerun={rerun}
          onOpenHistory={(runId) => setView({ kind: "history", runId })}
        />
      </div>
    </div>
  );
}
