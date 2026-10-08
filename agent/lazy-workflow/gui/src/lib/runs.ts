/**
 * The runs the window started, as one reducer. Output events can arrive before
 * `start_run` answers — a fast tool prints and exits while the IPC reply is in
 * flight — so lines and exits for an id nobody has registered yet wait in
 * `orphans` and join the run when it is registered.
 */

import type { CatalogEffect, CatalogOutput } from "../../../src/cli/command-catalog-schema.ts";
import type { RunExit, RunOutput, RunStarted } from "./backend.ts";
import { stripAnsi } from "./output.ts";

/** Enough for a long verbose run; older lines are dropped and counted. */
export const MAX_LINES = 20000;

export type RunStatus = "running" | "cancelling" | "success" | "failure" | "interrupted" | "error";

export interface RunState {
  readonly id: number;
  readonly command: string;
  /** The arguments after `lz`, as the form built them: what a rerun sends again. */
  readonly args: readonly string[];
  readonly line: string;
  readonly effect: CatalogEffect;
  readonly output: CatalogOutput;
  readonly startedAt: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** Lines dropped from the front of either stream once `MAX_LINES` was reached. */
  readonly dropped: number;
  readonly status: RunStatus;
  readonly exit: RunExit | null;
}

interface Orphan {
  stdout: string[];
  stderr: string[];
  exit: RunExit | null;
}

export interface RunsState {
  readonly runs: readonly RunState[];
  readonly activeId: number | null;
  readonly orphans: Readonly<Record<number, Orphan>>;
}

export type RunsAction =
  | { type: "started"; started: RunStarted; args: readonly string[]; command: string; line: string; effect: CatalogEffect; output: CatalogOutput }
  | { type: "output"; lines: readonly RunOutput[] }
  | { type: "exit"; exit: RunExit }
  | { type: "cancelling"; id: number }
  | { type: "focus"; id: number }
  | { type: "close"; id: number };

export const initialRunsState: RunsState = { runs: [], activeId: null, orphans: {} };

/** SIGINT through the CLI's own handler exits 130 and records `interrupted`. */
export function statusOf(exit: RunExit): RunStatus {
  if (exit.error) return "error";
  if (exit.code === 0) return "success";
  if (exit.cancelled || exit.code === 130 || exit.signal !== null) return "interrupted";
  return "failure";
}

function append(lines: readonly string[], added: readonly string[]): { lines: string[]; dropped: number } {
  const all = [...lines, ...added];
  const dropped = Math.max(0, all.length - MAX_LINES);
  return { lines: dropped > 0 ? all.slice(dropped) : all, dropped };
}

export function runsReducer(state: RunsState, action: RunsAction): RunsState {
  switch (action.type) {
    case "started": {
      const orphan = state.orphans[action.started.id];
      const { [action.started.id]: _, ...orphans } = state.orphans;
      const run: RunState = {
        id: action.started.id,
        command: action.command,
        args: action.args,
        line: action.line,
        effect: action.effect,
        output: action.output,
        startedAt: action.started.startedAt,
        stdout: orphan?.stdout ?? [],
        stderr: orphan?.stderr ?? [],
        dropped: 0,
        status: orphan?.exit ? statusOf(orphan.exit) : "running",
        exit: orphan?.exit ?? null,
      };
      return { runs: [...state.runs, run], activeId: run.id, orphans };
    }
    case "output": {
      const known = new Set(state.runs.map((run) => run.id));
      const orphans = { ...state.orphans };
      const byRun = new Map<number, { stdout: string[]; stderr: string[] }>();
      for (const output of action.lines) {
        const line = stripAnsi(output.line);
        if (!known.has(output.id)) {
          const orphan = orphans[output.id] ?? { stdout: [], stderr: [], exit: null };
          orphans[output.id] = { ...orphan, [output.stream]: [...orphan[output.stream], line] };
          continue;
        }
        const entry = byRun.get(output.id) ?? { stdout: [], stderr: [] };
        entry[output.stream].push(line);
        byRun.set(output.id, entry);
      }
      const runs = state.runs.map((run) => {
        const added = byRun.get(run.id);
        if (!added) return run;
        const stdout = append(run.stdout, added.stdout);
        const stderr = append(run.stderr, added.stderr);
        return { ...run, stdout: stdout.lines, stderr: stderr.lines, dropped: run.dropped + stdout.dropped + stderr.dropped };
      });
      return { ...state, runs, orphans };
    }
    case "exit": {
      if (!state.runs.some((run) => run.id === action.exit.id)) {
        const orphan = state.orphans[action.exit.id] ?? { stdout: [], stderr: [], exit: null };
        return { ...state, orphans: { ...state.orphans, [action.exit.id]: { ...orphan, exit: action.exit } } };
      }
      return {
        ...state,
        runs: state.runs.map((run) => (run.id === action.exit.id ? { ...run, exit: action.exit, status: statusOf(action.exit) } : run)),
      };
    }
    case "cancelling":
      return { ...state, runs: state.runs.map((run) => (run.id === action.id && run.status === "running" ? { ...run, status: "cancelling" } : run)) };
    case "focus":
      return { ...state, activeId: action.id };
    case "close": {
      const runs = state.runs.filter((run) => run.id !== action.id);
      const activeId = state.activeId === action.id ? (runs.at(-1)?.id ?? null) : state.activeId;
      return { ...state, runs, activeId };
    }
  }
}

export const isFinished = (run: RunState): boolean => run.status !== "running" && run.status !== "cancelling";
