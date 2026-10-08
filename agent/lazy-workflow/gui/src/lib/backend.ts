/**
 * The window's only door to the machine: the Rust commands in `src-tauri`.
 * Every call is typed here once, so a component never spells a command name.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

export const backend = {
  getSettings: () => invoke<SettingsDocument>("get_settings"),
  saveSettings: (settings: GuiSettings) => invoke<SettingsDocument>("save_settings", { settings }),
  loadCatalog: () => invoke<CommandCatalog>("load_catalog"),
  startRun: (args: string[], options: { stdin?: string; cwd?: string } = {}) =>
    invoke<RunStarted>("start_run", { request: { args, stdin: options.stdin ?? null, cwd: options.cwd ?? null } }),
  cancelRun: (id: number) => invoke<boolean>("cancel_run", { id }),
  readRunLog: (limit?: number) => invoke<RunLogDocument>("read_run_log", { limit: limit ?? null }),
  diagnose: (variables: Array<{ name: string; secret: boolean }>) => invoke<Diagnostics>("diagnose", { variables }),
  reloadEnvironment: () => invoke<void>("reload_environment"),
  captureLz: (args: string[]) => invoke<Captured>("capture_lz", { args }),
};

export function onRunOutput(handler: (output: RunOutput) => void): Promise<UnlistenFn> {
  return listen<RunOutput>("lz://run-output", (event) => handler(event.payload));
}

export function onRunExit(handler: (exit: RunExit) => void): Promise<UnlistenFn> {
  return listen<RunExit>("lz://run-exit", (event) => handler(event.payload));
}

/** Tauri rejects with the Rust `Err(String)` itself; anything else is stringified. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}
