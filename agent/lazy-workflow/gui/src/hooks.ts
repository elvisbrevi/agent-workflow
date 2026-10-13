/** The reads the views share, each one a background `lz` read that never becomes an operator run. */
import { useCallback, useEffect, useState } from "react";
import type { CommandCatalog } from "../../src/cli/command-catalog-schema.ts";
import type { AssignedWork } from "../../src/workspace/assigned-work.ts";
import { backend, errorText, type RunLogDocument } from "./lib/backend.ts";
import { foldRuns, type HistoryRun } from "./lib/history.ts";
import type { AgentModels } from "./lib/models.ts";
import { readTool, repositoryName, type RepositoryWork } from "./lib/work.ts";

/** `work-assigned` once per saved repository; one that fails keeps its error beside the others. */
export function useAssignedWork(catalog: CommandCatalog | null, repositories: readonly string[], revision: number) {
  const [results, setResults] = useState<RepositoryWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const key = repositories.join("\n");
  useEffect(() => {
    if (!catalog) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all(repositories.map(async (repository): Promise<RepositoryWork> => {
      try {
        const work = await readTool<AssignedWork>(catalog, "work-assigned", { "--working-directory": repository });
        return {
          repository, tracker: work.tracker, scope: work.scope, truncated: work.truncated, error: null,
          items: work.items.map((item) => ({ ...item, tracker: work.tracker, scope: work.scope, repository })),
        };
      } catch (error) {
        return { repository, tracker: null, scope: repositoryName(repository), items: [], truncated: false, error: errorText(error) };
      }
    })).then((next) => {
      if (cancelled) return;
      setResults(next);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [catalog, key, revision, refresh]);
  return { results, loading, refresh: useCallback(() => setRefresh((value) => value + 1), []) };
}

/** The CLI's run log, folded per run: the record of every Plan, Code and setup, from the window or a terminal. */
export function useRunLog(revision: number) {
  const [document, setDocument] = useState<RunLogDocument | null>(null);
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    backend.readRunLog().then((next) => {
      if (cancelled) return;
      setDocument(next);
      setRuns(foldRuns(next.records));
      setError(null);
    }, (caught) => { if (!cancelled) setError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [revision, refresh]);
  return { document, runs, error, refresh: useCallback(() => setRefresh((value) => value + 1), []) };
}

/**
 * `lz agent-models`, read once: listing every provider is slow enough that the
 * menus open with the catalog defaults and fill in when it answers. Null while
 * unknown, which the menus treat as "every CLI, default models only".
 */
export function useAgentModels(catalog: CommandCatalog | null) {
  const [models, setModels] = useState<AgentModels[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!catalog || !catalog.commands.some((command) => command.name === "agent-models")) return;
    let cancelled = false;
    readTool<AgentModels[]>(catalog, "agent-models").then((next) => { if (!cancelled) setModels(next); }, () => undefined);
    return () => { cancelled = true; };
  }, [catalog, refresh]);
  return { models, refresh: useCallback(() => setRefresh((value) => value + 1), []) };
}

export const can = (catalog: CommandCatalog, name: string): boolean => catalog.commands.some((command) => command.name === name);

/**
 * A read a panel shows once it answers; its failure is a line in the panel, not a dead end. Null values skip it.
 * A new `revision` reads it again.
 */
export function useRead<T>(catalog: CommandCatalog, name: string, values: Record<string, string> | null, revision = 0): { value: T | null; error: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = values ? `${JSON.stringify(values)}#${revision}` : null;
  useEffect(() => {
    setValue(null);
    setError(null);
    if (!values || !can(catalog, name)) return;
    let cancelled = false;
    readTool<T>(catalog, name, values).then((next) => { if (!cancelled) setValue(next); }, (caught) => { if (!cancelled) setError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [catalog, name, key]);
  return { value, error };
}
