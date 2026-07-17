// ── Types ───────────────────────────────────────────────────────────

import type { BtwToolTraceEntry, BtwUsage } from "./types.js";

// Re-export shared types for backward compatibility
export type { BtwToolTraceEntry, BtwUsage } from "./types.js";

/**
 * Minimal child process interface that both Node's ChildProcess and
 * the spawner's ChildProcessLike satisfy.  Keeps the registry decoupled
 * from both modules' concrete types.
 */
export interface BtwChildProcess {
  pid?: number;
  kill(signal?: string): boolean;
}

export interface RunningEntry {
  id: string;
  query: string;
  childProcess: BtwChildProcess;
  startedAt: Date;
  abortController?: AbortController;
}

export interface CompletedSuccessResult {
  type: "success";
  text: string;
  toolTrace: BtwToolTraceEntry[];
  usage: BtwUsage;
  model?: string;
  stopReason?: string;
}

export interface CompletedErrorResult {
  type: "error";
  error: string;
  exitCode?: number;
  stderr?: string;
  toolTrace: BtwToolTraceEntry[];
  partialText?: string;
}

export type CompletedResult = CompletedSuccessResult | CompletedErrorResult;

export interface CompletedEntry {
  id: string;
  query: string;
  result: CompletedResult;
  completedAt: Date;
}

// ── Registry ────────────────────────────────────────────────────────

export interface BtwRegistry {
  addRunning(id: string, query: string, childProcess: BtwChildProcess, abortController?: AbortController): void;
  complete(id: string, result: CompletedSuccessResult): void;
  fail(id: string, error: string, details?: { exitCode?: number; stderr?: string; toolTrace?: BtwToolTraceEntry[]; partialText?: string }): void;
  abort(id: string): void;
  getRunning(): readonly RunningEntry[];
  getCompleted(): readonly CompletedEntry[];
  getCompletedCount(): number;
  killAll(): void;
  clear(): void;
}

// ── Factory ─────────────────────────────────────────────────────────

export function createRegistry(): BtwRegistry {
  const running = new Map<string, RunningEntry>();
  const completed: CompletedEntry[] = [];

  return {
    addRunning(id: string, query: string, childProcess: BtwChildProcess, abortController?: AbortController): void {
      running.set(id, { id, query, childProcess, startedAt: new Date(), abortController });
    },

    abort(id: string): void {
      const entry = running.get(id);
      if (entry?.abortController) {
        entry.abortController.abort();
      }
    },

    complete(id: string, result: CompletedSuccessResult): void {
      const entry = running.get(id);
      if (!entry) return;
      running.delete(id);
      completed.push({ id, query: entry.query, result, completedAt: new Date() });
    },

    fail(id: string, error: string, details?: { exitCode?: number; stderr?: string; toolTrace?: Array<{ toolName: string; args: Record<string, unknown> }>; partialText?: string }): void {
      const entry = running.get(id);
      if (!entry) return;
      running.delete(id);
      completed.push({
        id,
        query: entry.query,
        result: {
          type: "error",
          error,
          toolTrace: details?.toolTrace ?? [],
          exitCode: details?.exitCode,
          stderr: details?.stderr,
          partialText: details?.partialText,
        },
        completedAt: new Date(),
      });
    },

    getRunning(): readonly RunningEntry[] {
      return Array.from(running.values());
    },

    getCompleted(): readonly CompletedEntry[] {
      // Newest-first (reverse chronological)
      return [...completed].reverse();
    },

    getCompletedCount(): number {
      return completed.length;
    },

    killAll(): void {
      for (const [, entry] of running) {
        // Signal abort first so the spawner returns an abort error result
        try {
          entry.abortController?.abort();
        } catch {
          // Controller may already be aborted
        }
        try {
          entry.childProcess.kill("SIGTERM");
        } catch {
          // Process may already be dead
        }
      }
      running.clear();
    },

    clear(): void {
      running.clear();
      completed.length = 0;
    },
  };
}
