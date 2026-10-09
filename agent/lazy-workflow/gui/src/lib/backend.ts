/**
 * The window's only door to the machine: the Rust commands in `src-tauri`.
 * Every call is typed here once, so a component never spells a command name.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop } from "./platform.ts";
import { createHttpTransport } from "./http-transport.ts";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";

export type FlagDefault = string | number | boolean | string[];

/** `~/.config/lazy-workflow/gui.json`; documented for the skill in `utility/lz/GUI.md`. */
export interface GuiSettings {
  schemaVersion: number;
  lzCommand: string;
  inheritShellEnvironment: boolean;
  extraPath: string[];
  environment: Record<string, string>;
  secretEnvironment: string[];
  repositories: string[];
  activeRepository: string | null;
  flagDefaults: Record<string, FlagDefault>;
  commandDefaults: Record<string, Record<string, FlagDefault>>;
  confirmWrites: boolean;
  theme: "system" | "light" | "dark";
  [unknown: string]: unknown;
}

export interface SettingsDocument {
  path: string;
  settings: GuiSettings;
  error: string | null;
}

export interface RunStarted {
  id: number;
  program: string;
  args: string[];
  cwd: string;
  startedAt: number;
}

export interface RunOutput {
  id: number;
  stream: "stdout" | "stderr";
  line: string;
}

export interface RunExit {
  id: number;
  code: number | null;
  signal: number | null;
  durationMs: number;
  cancelled: boolean;
  error: string | null;
}

export interface Diagnostics {
  settingsPath: string;
  runLogPath: string;
  lzLauncher: string | null;
  lzError: string | null;
  shellEnvironment: boolean;
  binaries: Array<{ name: string; path: string | null }>;
  variables: Array<{ name: string; present: boolean; value: string | null; source: "settings" | "environment" | "credentials" | "missing" }>;
}

export interface RunLogDocument {
  path: string;
  exists: boolean;
  records: unknown[];
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const webTransport = createHttpTransport((...args) => fetch(...args), () => window.dispatchEvent(new Event("lz:unauthorized")));
async function command<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  if (isDesktop) return (await import("@tauri-apps/api/core")).invoke<T>(name, body);
  return webTransport.rpc<T>(name, body);
}

export const backend = {
  getSettings: () => command<SettingsDocument>("get_settings"),
  saveSettings: (settings: GuiSettings) => command<SettingsDocument>("save_settings", { settings }),
  loadCatalog: () => command<CommandCatalog>("load_catalog"),
  startRun: (args: string[], options: { stdin?: string; cwd?: string } = {}) =>
    command<RunStarted>("start_run", { request: { args, stdin: options.stdin ?? null, cwd: options.cwd ?? null } }),
  cancelRun: (id: number) => command<boolean>("cancel_run", { id }),
  readRunLog: (limit?: number) => command<RunLogDocument>("read_run_log", { limit: limit ?? null }),
  diagnose: (variables: Array<{ name: string; secret: boolean }>) => command<Diagnostics>("diagnose", { variables }),
  reloadEnvironment: () => command<void>("reload_environment"),
  captureLz: (args: string[]) => command<Captured>("capture_lz", { args }),
  uploadText: (content: string) => webTransport.rpc<{ path: string }>("upload_file", { content }),
};

type FeedEvent = { sequence: number; event: string; payload: unknown };
const handlers = new Map<string, Set<(payload: unknown) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
function startFeed() {
  const activeGeneration = ++generation;
  let cursor = 0;
  let instance: string | null = null;
  const poll = async () => {
    if (activeGeneration !== generation) return;
    try {
      const feed = await webTransport.request<{ events: FeedEvent[]; cursor: number; instance: string }>(`/api/events?after=${cursor}`);
      if (activeGeneration !== generation) return;
      if (instance !== null && instance !== feed.instance) { window.location.reload(); return; }
      if (instance === null) {
        const runs = await webTransport.request<Array<{ started: RunStarted; args: string[]; exit: RunExit | null }>>("/api/runs");
        if (activeGeneration !== generation) return;
        for (const run of runs) {
          for (const handler of handlers.get("lz://run-started") ?? []) handler({ started: run.started, args: run.args });
          if (run.exit) for (const handler of handlers.get("lz://run-exit") ?? []) handler(run.exit);
        }
      }
      instance = feed.instance;
      for (const event of feed.events) for (const handler of handlers.get(event.event) ?? []) handler(event.payload);
      cursor = feed.cursor;
    } catch { /* Network errors retry; session expiry unmounts the app through the auth gate. */ }
    if (activeGeneration === generation) timer = setTimeout(() => { void poll(); }, 1000);
  };
  void poll();
}
async function subscribe<T>(name: string, handler: (value: T) => void): Promise<UnlistenFn> {
  if (isDesktop) return (await import("@tauri-apps/api/event")).listen<T>(name, (event) => handler(event.payload));
  const wasEmpty = handlers.size === 0;
  const values = handlers.get(name) ?? new Set();
  const listener = (value: unknown) => handler(value as T);
  values.add(listener); handlers.set(name, values);
  if (wasEmpty) startFeed();
  return () => {
    values.delete(listener); if (values.size === 0) handlers.delete(name);
    if (handlers.size === 0) { generation++; if (timer) clearTimeout(timer); timer = null; }
  };
}
export function onRunOutput(handler: (output: RunOutput) => void): Promise<UnlistenFn> {
  return subscribe("lz://run-output", handler);
}

export function onRunExit(handler: (exit: RunExit) => void): Promise<UnlistenFn> {
  return subscribe("lz://run-exit", handler);
}

export function onRunStarted(handler: (run: { started: RunStarted; args: string[] }) => void): Promise<UnlistenFn> {
  return isDesktop ? Promise.resolve(() => {}) : subscribe("lz://run-started", handler);
}

/** Tauri rejects with the Rust `Err(String)` itself; anything else is stringified. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}
