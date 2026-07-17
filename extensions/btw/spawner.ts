/**
 * btw — BTW Process spawner.
 *
 * Spawns an isolated child `pi` process with a forked session to resolve
 * side-questions without polluting the parent session's conversation history.
 * Parses the JSON event stream to produce structured results.
 */

// ── Types ───────────────────────────────────────────────────────────

import type { BtwToolTraceEntry, BtwUsage } from "./types.js";
import { parseBtwOutput } from "./parser.js";

// Re-export shared types for backward compatibility
export type { BtwToolTraceEntry, BtwUsage } from "./types.js";

export interface BtwSpawnOptions {
  /** Session file path to fork. Null for ephemeral (no history). */
  sessionFile: string | null;
  /** The side-question to ask. */
  query: string;
  /** Working directory for the child process. */
  cwd: string;
  /** Timeout in milliseconds. 0 = no timeout. */
  timeoutMs: number;
  /** Optional abort signal to cancel the process. */
  signal?: AbortSignal;
  /** Override pi binary path (for testing). */
  piPath?: string;
  /** Called immediately after spawn with the child process handle. */
  onSpawn?: (child: ChildProcessLike) => void;
}

export type BtwResult =
  | {
      ok: true;
      text: string;
      toolTrace: BtwToolTraceEntry[];
      usage: BtwUsage;
      model?: string;
      stopReason?: string;
    }
  | {
      ok: false;
      errorMessage: string;
      exitCode?: number;
      stderr?: string;
      toolTrace: BtwToolTraceEntry[];
      partialText?: string;
    };

// ── Pure functions (testable without spawning) ──────────────────────

export interface BuildBtwArgsOptions {
  sessionFile: string | null;
  query: string;
}

/**
 * Build the command-line arguments for the child `pi` process.
 *
 * For a real session: `pi --fork <session> --mode json --exclude-tools edit,write -p "query"`
 * For ephemeral:      `pi --no-session --mode json --exclude-tools edit,write -p "query"`
 */
export function buildBtwArgs(options: BuildBtwArgsOptions): string[] {
  const args: string[] = [];

  if (options.sessionFile !== null) {
    args.push("--fork", options.sessionFile);
  } else {
    args.push("--no-session");
  }

  args.push("--mode", "json");
  args.push("--exclude-tools", "edit,write");
  args.push("-p", options.query);

  return args;
}

/**
 * Build the environment variables for the child process.
 * Sets PI_BTW_CHILD=1 as a recursion guard.
 */
export function buildBtwEnv(): Record<string, string> {
  return { PI_BTW_CHILD: "1" };
}

// ── Process spawning ────────────────────────────────────────────────

/** Grace period after SIGTERM before escalating to SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

interface ChildProcessLike {
  pid?: number;
  stdout: import("stream").Readable | null;
  stderr: import("stream").Readable | null;
  kill(signal?: string): boolean;
  on(event: "close", handler: (code: number | null) => void): void;
  on(event: "error", handler: (err: Error) => void): void;
}

/** Injectable spawn function for testing. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: [string, string, string] },
) => ChildProcessLike | Promise<ChildProcessLike>;

/** Default spawn using node:child_process. */
async function defaultSpawnFn(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: [string, string, string] },
): Promise<ChildProcessLike> {
  const { spawn } = await import("child_process");
  return spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ChildProcessLike;
}

/**
 * Spawn a BTW child process with timeout and abort signal support.
 *
 * Lifecycle:
 * 1. Build command args and env
 * 2. Spawn child process
 * 3. Register timeout/abort handlers BEFORE stream collection
 * 4. Collect stdout lines (NDJSON) and stderr
 * 5. Wait for process to close
 * 6. Parse collected lines into structured result
 * 7. Return BtwResult
 */
export async function spawnBtwProcess(
  options: BtwSpawnOptions,
  spawnFn: SpawnFn = defaultSpawnFn,
): Promise<BtwResult> {
  const args = buildBtwArgs({ sessionFile: options.sessionFile, query: options.query });
  const env = buildBtwEnv();
  const piPath = options.piPath ?? "pi";

  let child: ChildProcessLike;
  try {
    child = await spawnFn(piPath, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage: `Failed to spawn BTW process: ${message}`,
      toolTrace: [],
    };
  }

  // ── Notify caller of child process handle ──
  if (options.onSpawn) {
    options.onSpawn(child);
  }

  // ── Register timeout/abort BEFORE stream collection ──
  // Captured flags avoid post-close races with clearTimeout/removeEventListener.
  let timedOut = false;
  let wasAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  if (options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate to SIGKILL after grace period
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, SIGTERM_GRACE_MS);
    }, options.timeoutMs);
  }

  const abortHandler = () => {
    wasAborted = true;
    child.kill("SIGTERM");
  };
  if (options.signal) {
    if (options.signal.aborted) {
      wasAborted = true;
      child.kill("SIGTERM");
    } else {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  // ── Collect stdout lines ──
  const stdoutLines: string[] = [];
  let stdoutBuffer = "";
  try {
    if (child.stdout) {
      child.stdout.setEncoding("utf-8");
      for await (const chunk of child.stdout) {
        stdoutBuffer += chunk;
        const parts = stdoutBuffer.split("\n");
        stdoutBuffer = parts.pop() ?? "";
        for (const part of parts) {
          if (part.length > 0) stdoutLines.push(part);
        }
      }
      // Flush remaining buffer
      if (stdoutBuffer.trim().length > 0) {
        stdoutLines.push(stdoutBuffer.trimEnd());
      }
    }
  } catch {
    // Stream error (e.g., pipe broken) — collect partial result
  }

  // ── Collect stderr ──
  let stderr = "";
  try {
    if (child.stderr) {
      child.stderr.setEncoding("utf-8");
      for await (const chunk of child.stderr) {
        stderr += chunk;
      }
    }
  } catch {
    // Stream error — ignore
  }

  // ── Wait for process to close ──
  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

  // ── Clean up timers ──
  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  if (options.signal) {
    options.signal.removeEventListener("abort", abortHandler);
  }

  // ── Build result ──
  const parsed = parseBtwOutput(stdoutLines);

  // Timeout takes priority — captured flag avoids post-close race
  if (timedOut) {
    return {
      ok: false,
      errorMessage: `BTW process timed out after ${options.timeoutMs / 1000}s`,
      toolTrace: parsed.toolTrace,
      stderr: stderr || undefined,
    };
  }

  // Abort takes priority — captured flag avoids post-close race
  if (wasAborted) {
    return {
      ok: false,
      errorMessage: "BTW process was aborted",
      toolTrace: parsed.toolTrace,
      stderr: stderr || undefined,
    };
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      errorMessage: `BTW process exited with code ${exitCode}`,
      exitCode,
      stderr: stderr || undefined,
      toolTrace: parsed.toolTrace,
      partialText: parsed.text || undefined,
    };
  }

  if (!parsed.text) {
    return {
      ok: false,
      errorMessage: "BTW process produced no assistant output",
      exitCode,
      stderr: stderr || undefined,
      toolTrace: parsed.toolTrace,
    };
  }

  return {
    ok: true,
    text: parsed.text,
    toolTrace: parsed.toolTrace,
    usage: parsed.usage,
    model: parsed.model,
    stopReason: parsed.stopReason,
  };
}
