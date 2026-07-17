import { parseAgentDefinitionFile } from "./agent-definition-parser.js";
import { buildCommand, type BuildCommandOverrides } from "./command-builder.js";
import { spawn } from "child_process";
import { readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { formatActivityFeed, type ActivityFeedOutput } from "./activity-feed-formatter.js";
import type { ProgressEvent } from "./progress-event.js";
import { processStream, type StreamResult } from "./stream-processor.js";
import * as registry from "./process-registry.js";
import { WorkspaceStore } from "./workspace-store.js";
import type { TaskWorkspace } from "./task-workspace.js";
import type { Readable } from "stream";

export const TIMEOUT_DEFAULTS: Record<string, number> = {
  scout: 120_000,
  planner: 300_000,
  worker: 600_000,
};
export const DEFAULT_TIMEOUT = 300_000;
/** Number of completed task workspaces to retain after garbage collection. */
export const GC_RETAIN = 20;

export type ProgressCallback = (feed: ActivityFeedOutput) => void;

export interface SpawnSubagentOptions {
  agentType: string;
  task: string;
  agentsDir: string;
  workDir?: string;
  overrides?: BuildCommandOverrides;
  /** For testing: override the pi binary path. */
  piPath?: string;
  /** For testing: inject a deterministic id generator. */
  generateId?: () => string;
  /** Optional callback for progress updates during subagent execution. */
  onProgress?: ProgressCallback;
  /** Optional signal to cancel the subagent (kills child + stops progress tailing). */
  signal?: AbortSignal;
}

export interface SpawnSubagentResult {
  output: string;
  agentId: string;
  /** The agent type that was spawned (e.g. "scout", "worker"). */
  agentType: string;
  /** Wall-clock duration from spawn to completion, in milliseconds. */
  duration: number;
  /** Resolved model (overrides.model ?? definition.model). */
  model?: string;
  /** Final usage snapshot captured from progress events. */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Final activity feed snapshot at the moment the subagent finishes. */
  activityFeed?: ActivityFeedOutput;
}

export class UnknownAgentError extends Error {
  constructor(
    public readonly agentType: string,
    public readonly availableAgents: string[],
  ) {
    const list = availableAgents.length > 0
      ? availableAgents.join(", ")
      : "(none found)";
    super(
      `Unknown agent type "${agentType}". Available types: ${list}`,
    );
    this.name = "UnknownAgentError";
  }
}

export class SubagentTimeoutError extends Error {
  /** @deprecated Use returned error output, not thrown exceptions. */
  constructor(
    public readonly agentType: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Subagent "${agentType}" timed out after ${timeoutMs / 1000}s`,
    );
    this.name = "SubagentTimeoutError";
  }
}

/** List available agent types from a directory of .md agent definitions. */
export function listAvailableAgents(agentsDir: string): string[] {
  try {
    return readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

export async function spawnSubagent(
  options: SpawnSubagentOptions,
): Promise<SpawnSubagentResult> {
  const {
    agentType,
    task,
    agentsDir,
    workDir = process.cwd(),
    overrides,
    piPath: piPathOverride,
    generateId,
    onProgress,
    signal,
  } = options;

  // 1. Generate unique agent-id
  const agentId = generateId
    ? generateId()
    : `${agentType}-${randomUUID().slice(0, 8)}`;

  // 2. Create task workspace via store (replaces mkdirSync + join)
  const store = new WorkspaceStore(join(workDir, ".pi", "subagents"));

  // 2a. Reap any orphan processes from previous runs
  registry.reapOrphans(store);

  // 2b. Prune completed workspaces so the subagents root does not grow unbounded
  store.gcCompleted(GC_RETAIN);

  // 2c. Create the new task workspace
  const ws: TaskWorkspace = store.create(agentId);

  // 2c. Track latest usage from progress events
  let latestUsage: SpawnSubagentResult["usage"] | undefined;

  // 2d. Notify progress observer with initial empty feed
  const wrappedOnProgress = onProgress
    ? (feed: ActivityFeedOutput) => {
        if (feed.usage) {
          latestUsage = { ...feed.usage };
        }
        try {
          onProgress(feed);
        } catch {
          console.warn("[pi-subagents] Progress callback threw during initial feed");
        }
      }
    : undefined;

  if (wrappedOnProgress) {
    try {
      wrappedOnProgress(formatActivityFeed([]));
    } catch {
      console.warn("[pi-subagents] Progress callback threw during initial feed");
    }
  }

  // 3. Write task.md
  ws.writeTask(task);

  // 4. Load agent definition (catch parse error → throw UnknownAgentError)
  let definition;
  try {
    definition = parseAgentDefinitionFile(agentType, agentsDir);
  } catch {
    throw new UnknownAgentError(agentType, listAvailableAgents(agentsDir));
  }

  // 5. Build command args and env
  const { args, env } = buildCommand(definition, task, overrides);

  // 5a. Resolve model for metadata: overrides take precedence over definition
  const resolvedModel: string | undefined = overrides?.model ?? definition.model;

  // 6. Write manifest.json
  const manifest = {
    agentId,
    taskDir: ws.directory,
    command: ["pi", ...args],
    env,
  };
  ws.writeManifest(manifest);

  // 7. Determine pi path (default: find "pi" in PATH)
  const resolvedPiPath = piPathOverride ?? "pi";

  // 8. Spawn pi directly (no shell wrapper)
  const child = spawn(resolvedPiPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  // Capture stderr for diagnostics (model-not-found, API key errors, crashes etc.)
  let childStderr = "";
  child.stderr.on("data", (data: Buffer) => {
    childStderr += data.toString();
  });

  // 8a. Write process.json for orphan recovery, then register the child
  ws.writeProcessInfo({ pid: child.pid!, parentPid: process.pid })
  registry.register(agentId, child);

  // 8b. Record start time for duration measurement (after spawn for wall-clock accuracy)
  const startTime = Date.now();

  // 8b. Start progress tailing via workspace live channel
  let tailAbort: AbortController | null = null;
  let tailDone: Promise<void> | null = null;
  let tailEvents: ProgressEvent[] = [];

  if (wrappedOnProgress) {
    tailAbort = new AbortController();
    tailDone = (async () => {
      try {
        for await (const event of ws.tailEvents(tailAbort.signal)) {
          tailEvents.push(event);
          try {
            wrappedOnProgress(formatActivityFeed(tailEvents));
          } catch {
            console.warn("[pi-subagents] Progress callback threw during event delivery");
          }
        }
      } catch {
        // Tailing stopped (aborted or error) — silently ignore
      }
    })();
  }

  // 8c. Initialize run.log via workspace
  ws.log(`spawner started, agentId=${agentId}`);

  // 8d. Consume stream processor: pipe child stdout through typed NDJSON pipeline.
  // Raw lines are persisted to events.jsonl via workspace.
  const stream = processStream(withRawLines(child.stdout, ws));
  let streamResult: StreamResult | null = null;
  let timedOut = false;

  const streamConsumer = (async () => {
    try {
      let result: IteratorResult<ProgressEvent, StreamResult>;
      while (!(result = await stream.next()).done) {
        const event = result.value as ProgressEvent;
        // Append every event to progress.jsonl via workspace
        ws.appendEvent(event);
        // Track latest usage from progress events
        if (event.type === "usage" && event.input !== undefined) {
          latestUsage = {
            input: event.input,
            output: event.output,
            cacheRead: event.cacheRead,
            cacheWrite: event.cacheWrite,
          };
        }
      }
      streamResult = result.value;
    } catch (err) {
      console.warn("[pi-subagents] Stream processor error:", err);
    }
  })();

  // 9. Compute timeout: explicit agent timeout (seconds→ms) > type default > global default
  const timeoutMs =
    definition.timeout !== undefined
      ? definition.timeout * 1000
      : (TIMEOUT_DEFAULTS[agentType] ?? DEFAULT_TIMEOUT);

  // 10. Race: child exit vs timeout vs cancellation. Timeout is returned as
  // tool output, not thrown, so the LLM receives a clear error message in-context.
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        // Stop progress tailing before killing child
        tailAbort?.abort();
        child.kill("SIGTERM");
        // Write timeout error to output.md via workspace
        ws.writeOutput(
          `[ERROR] Subagent "${agentType}" timed out after ${timeoutMs / 1000}s.${childStderr.trim() ? `\n\n--- Child stderr ---\n${childStderr.trim()}` : ""}`,
        );
        finish();
      }, timeoutMs);

      child.on("close", () => {
        if (!timedOut) {
          clearTimeout(timer);
        }
        // Deregister from process registry
        registry.deregister(agentId, child);
        // Stop progress tailing
        tailAbort?.abort();
        finish();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        // Deregister from process registry
        registry.deregister(agentId, child);
        // Stop progress tailing on crash
        tailAbort?.abort();
        fail(err);
      });

      // Cancellation signal: deregister, abort tailer, and kill child
      if (signal) {
        const cancel = () => {
          clearTimeout(timer);
          registry.deregister(agentId, child);
          tailAbort?.abort();
          child.kill("SIGTERM");
          finish();
        };
        if (signal.aborted) {
          cancel();
        } else {
          signal.addEventListener("abort", cancel, { once: true });
        }
      }
    });
  } finally {
    // Wait for stream consumer to finish (pipe broke, no more events will arrive)
    await streamConsumer;
    // Wait for progress tailer to finish
    if (tailDone) {
      await tailDone;
    }
  }

  // 11. Write output.md from stream result if not already written (e.g. by timeout)
  const completedStreamResult = streamResult as StreamResult | null;
  if (!timedOut && completedStreamResult) {
    if (completedStreamResult.done) {
      ws.writeOutput(completedStreamResult.finalText);
      ws.log("completed");
    } else {
      const errorResult = completedStreamResult as Extract<StreamResult, { done: false }>;
      const stderrNote = childStderr.trim()
        ? `\n\n--- Child stderr ---\n${childStderr.trim()}`
        : "";
      ws.writeOutput(`[ERROR] ${errorResult.error}${stderrNote}`);
      ws.log(`error: ${errorResult.error}`);
      if (childStderr.trim()) {
        ws.log(`child stderr: ${childStderr.trim()}`);
      }
    }
  }

  // 12. Read all buffered events once — used for both usage extraction and final feed.
  const allEvents = ws.readProgressEvents();

  if (!latestUsage) {
    latestUsage = extractUsageFromEvents(allEvents);
  }

  // 12.5 Generate final activity feed from progress events
  let activityFeed: ActivityFeedOutput | undefined;
  try {
    if (allEvents.length > 0) {
      activityFeed = formatActivityFeed(allEvents);
    }
  } catch {
    // If formatting fails, activityFeed remains undefined — don't throw
  }

  // 13. Read output.md and return
  let output: string;
  try {
    output = ws.readOutput() ?? "";
  } catch {
    output = `[ERROR] Subagent completed but no output.md was produced.`;
    ws.writeOutput(output);
  }

  return { output, agentId, agentType, duration: Date.now() - startTime, model: resolvedModel, usage: latestUsage, activityFeed };
}

/**
 * Pass-through async generator that writes raw NDJSON lines to events.jsonl.
 * Yields the same chunks as the input so the stream processor can process them.
 */
async function* withRawLines(
  stream: Readable,
  ws: TaskWorkspace,
): AsyncIterable<string> {
  let pending = "";
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");
    // Flush complete lines to events.jsonl via workspace
    pending += text;
    while (pending.includes("\n")) {
      const nlIndex = pending.indexOf("\n");
      const line = pending.slice(0, nlIndex);
      if (line.length > 0) {
        ws.appendRawLine(line);
      }
      pending = pending.slice(nlIndex + 1);
    }
    yield text;
  }
  // Flush trailing content
  if (pending.trim().length > 0) {
    ws.appendRawLine(pending.trimEnd());
  }
}

/**
 * Extract the last usage event from in-memory progress events.
 * Returns undefined if no usage events exist.
 */
function extractUsageFromEvents(
  events: ProgressEvent[],
): SpawnSubagentResult["usage"] | undefined {
  // Scan backwards for the last usage event
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "usage") {
      return {
        input: event.input,
        output: event.output,
        cacheRead: event.cacheRead,
        cacheWrite: event.cacheWrite,
      };
    }
  }
  return undefined;
}
