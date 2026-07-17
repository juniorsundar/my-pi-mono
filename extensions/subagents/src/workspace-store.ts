import { mkdirSync, readdirSync, existsSync, statSync, rmSync } from "node:fs"
import { join } from "node:path"
import { TaskWorkspace } from "./task-workspace.js"

/**
 * Owns the subagents root (`.pi/subagents/`).
 * Creates, opens, and lists task workspaces.
 */
export class WorkspaceStore {
  constructor(private readonly root: string) {}

  /**
   * Returns true if the name is a valid agent id: a non-empty string with no
   * path separators or parent-directory references.
   */
  private static isSafeAgentId(name: string): boolean {
    return (
      typeof name === "string" &&
      name.length > 0 &&
      !name.includes("/") &&
      !name.includes("\\") &&
      !name.includes("..")
    )
  }

  /**
   * Reject an agentId that could escape the subagents root via path traversal.
   * Agent ids are opaque tokens (UUIDs) from the spawner; they must never carry
   * path separators or parent-directory references.
   */
  private assertSafeAgentId(agentId: string): void {
    if (!WorkspaceStore.isSafeAgentId(agentId)) {
      throw new Error(
        `Invalid agentId: must be a non-empty string without path separators or parent-directory references: ${agentId}`,
      )
    }
  }

  /**
   * Create a new agent directory and return its TaskWorkspace.
   */
  create(agentId: string): TaskWorkspace {
    this.assertSafeAgentId(agentId)
    const dir = join(this.root, agentId)
    mkdirSync(dir, { recursive: true })
    return TaskWorkspace.create(dir)
  }

  /**
   * Open an existing agent directory and return its TaskWorkspace.
   * Delegates the existence check to TaskWorkspace.open and augments the
   * error with the agent id for a clearer message.
   */
  open(agentId: string): TaskWorkspace {
    this.assertSafeAgentId(agentId)
    const dir = join(this.root, agentId)
    try {
      return TaskWorkspace.open(dir)
    } catch {
      throw new Error(`Task workspace does not exist for agent: ${agentId}`)
    }
  }

  /**
   * Remove an agent directory from the subagents root.
   * Uses `rmSync` with `recursive` and `force` so removing a missing id is a
   * no-op, and the same `assertSafeAgentId` guard as `create`/`open` prevents
   * path traversal out of the root.
   */
  remove(agentId: string): void {
    this.assertSafeAgentId(agentId)
    const dir = join(this.root, agentId)
    rmSync(dir, { recursive: true, force: true })
  }

  /**
   * Garbage-collect completed task workspaces, retaining the most-recent ones.
   *
   * Only workspaces where `hasOutput()` is true are eligible. Eligible workspaces
   * are ordered by `completedAt()` ascending (`null`/`missing` output is treated
   * as oldest), ties broken by `agentId` ascending. The oldest workspaces beyond
   * `retain` are removed via `remove()`.
   */
  gcCompleted(retain: number): void {
    if (!Number.isInteger(retain) || retain < 0) {
      throw new Error(`retain must be a non-negative integer, got ${retain}`)
    }

    const completed = this.list().filter(ws => ws.hasOutput())
    completed.sort((a, b) => {
      const ta = a.completedAt()?.getTime() ?? Number.NEGATIVE_INFINITY
      const tb = b.completedAt()?.getTime() ?? Number.NEGATIVE_INFINITY
      if (ta !== tb) return ta - tb
      return a.agentId.localeCompare(b.agentId)
    })

    const evictCount = Math.max(0, completed.length - retain)
    for (const ws of completed.slice(0, evictCount)) {
      this.remove(ws.agentId)
    }
  }

  /**
   * List all agent directories as TaskWorkspace instances.
   */
  list(): TaskWorkspace[] {
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) return []
    const entries = readdirSync(this.root, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && WorkspaceStore.isSafeAgentId(e.name))
      .map(e => TaskWorkspace.open(join(this.root, e.name)))
  }
}
