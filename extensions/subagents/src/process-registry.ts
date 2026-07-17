import type { ChildProcess } from "child_process"
import type { WorkspaceStore } from "./workspace-store.js"
import type { TaskWorkspace } from "./task-workspace.js"

let registry = new Map<string, ChildProcess>()

/** Resets the in-memory registry. Exposed for testing only. */
export function _resetRegistry(): void {
  registry = new Map<string, ChildProcess>()
}

/**
 * Register a live child process. No file I/O — the spawner writes process.json
 * through the workspace.
 */
export function register(
  agentId: string,
  child: ChildProcess,
): void {
  registry.set(agentId, child)
}

export function deregister(agentId: string, child: ChildProcess): void {
  // Only remove if the registered child matches — prevents stale deregistration
  // from removing a newer child that was registered under the same agent ID.
  if (registry.get(agentId) === child) {
    registry.delete(agentId)
  }
}

/**
 * Orphan recovery: walk all workspaces in the store, check PID liveness,
 * kill orphans, and record terminal events through workspace operations.
 */
export function reapOrphans(store: WorkspaceStore): void {
  for (const ws of store.list()) {
    reapSingleOrphan(ws)
  }
}

function reapSingleOrphan(ws: TaskWorkspace): void {
  // Skip if already has output.md — subagent completed normally
  if (ws.hasOutput()) return

  const processData = ws.readProcessInfo()
  if (!processData) return

  const { pid, parentPid } = processData as { pid?: number; parentPid?: number }

  // Validate PID
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return

  // If parent session is still alive, the child is managed, not orphaned.
  // NOTE: this is a best-effort local guard. It does not verify process
  // identity — if the parent PID was reused by a different process after
  // the original parent exited, this check will incorrectly spare the child.
  // PID reuse is rare in practice for short-lived local agent sessions,
  // so this trade-off is acceptable for a local subagent runtime.
  if (typeof parentPid === "number" && Number.isInteger(parentPid) && parentPid > 0) {
    if (isPidAlive(parentPid)) return
  }

  if (!isPidAlive(pid)) return

  // Kill the orphan (best-effort; both the liveness check and this kill are
  // racy — the process may exit between check and signal).
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Process already exited — skip
    return
  }

  // Write termination error to output.md through workspace
  const timestamp = new Date().toISOString()
  ws.writeOutput(
    `[ERROR] Orphan process (PID ${pid}) was reaped during crash recovery at ${timestamp}.`,
  )

  // Append terminal event to progress.jsonl through workspace
  ws.appendEvent({
    type: "terminal",
    text: `Orphan process (PID ${pid}) reaped after crash recovery`,
    timestamp,
    status: "failed",
  })
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    // EPERM means the process exists but caller lacks permission to signal it
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}


