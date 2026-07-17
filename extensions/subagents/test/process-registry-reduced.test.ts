import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EventEmitter } from "events"
import { WorkspaceStore } from "../src/workspace-store.js"
import {
  register,
  deregister,
  reapOrphans,
  _resetRegistry,
} from "../src/process-registry.js"

// Minimal ChildProcess stub using EventEmitter
function createChildStub(pid: number) {
  const child = new EventEmitter() as any
  child.pid = pid
  child.kill = () => true
  return child
}

describe("process-registry (reduced)", () => {
  let tempDir: string
  let store: WorkspaceStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "registry-test-"))
    store = new WorkspaceStore(join(tempDir, ".pi", "subagents"))
    _resetRegistry()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("register / deregister", () => {
    it("register and deregister round-trip does not throw", () => {
      const child = createChildStub(1234)
      register("agent-1", child)

      // deregister with the correct child should succeed silently
      expect(() => deregister("agent-1", child)).not.toThrow()
    })

    it("deregister ignores stale child references", () => {
      const child1 = createChildStub(100)
      const child2 = createChildStub(200)
      register("agent-1", child1)
      register("agent-1", child2) // overwrite

      // Trying to deregister the old child should not throw or affect the new one
      // (the new child remains registered; only the old reference is ignored)
      expect(() => deregister("agent-1", child1)).not.toThrow()
    })

    it("re-registering after deregister replaces the child", () => {
      const child1 = createChildStub(100)
      const child2 = createChildStub(200)
      register("agent-1", child1)
      deregister("agent-1", child1)
      register("agent-1", child2)

      // Deregistering child2 should now work (child2 is the registered one)
      expect(() => deregister("agent-1", child2)).not.toThrow()
    })
  })

  describe("reapOrphans", () => {
    it("walks store.list() and uses workspace operations for file access", () => {
      // Mock process.kill to simulate a live PID
      const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        // Signal 0 (liveness check): always say alive
        if (signal === 0) return true as any
        // SIGKILL: pretend success
        return true as any
      })

      // Create a workspace with process.json but no output.md
      const ws = store.create("orphan-agent")
      // No parentPid — so parent check is skipped, child is treated as orphan
      ws.writeProcessInfo({ pid: 99999 })
      ws.appendEvent({
        type: "lifecycle",
        text: "started",
        timestamp: "2026-01-01T00:00:00Z",
      })

      // reapOrphans should attempt to kill PID 99999 (which doesn't exist)
      // and write output.md + terminal event through workspace operations
      reapOrphans(store)

      // The orphan should have been reaped: output.md should exist
      expect(ws.hasOutput()).toBe(true)
      const output = ws.readOutput()
      expect(output).toContain("Orphan process")

      // Terminal event should be appended — re-open to read from disk
      // (reapOrphans used a different TaskWorkspace instance)
      const reopened = store.open("orphan-agent")
      const events = reopened.readProgressEvents()
      const terminal = events.find(e => e.type === "terminal")
      expect(terminal).toBeDefined()
      expect(terminal!.text).toContain("reaped")

      // Confirm SIGKILL was sent to the orphan child pid
      const killCalls = spy.mock.calls.filter(([p, s]) => s === "SIGKILL")
      expect(killCalls).toHaveLength(1)
      expect(killCalls[0][0]).toBe(99999)

      spy.mockRestore()
    })

    it("skips workspaces that already have output.md", () => {
      const ws = store.create("completed-agent")
      ws.writeProcessInfo({ pid: 88888, parentPid: process.pid })
      ws.writeOutput("already done")

      reapOrphans(store)

      // Should not have appended a terminal event
      const events = ws.readProgressEvents()
      const terminal = events.find(e => e.type === "terminal")
      expect(terminal).toBeUndefined()
    })

    it("skips workspace when parent session PID is still alive (SIGKILL-on-PID-reuse guard)", () => {
      // The live-parent-PID guard: if the parent session is still alive,
      // the child is managed (not orphaned) and must not be reaped.
      // This test exercises the guard in isolation — no output.md, valid child pid,
      // parentPid points to a live process.
      const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        // Signal 0 (liveness check): both parent and child are alive
        if (signal === 0) return true as any
        // Should never reach SIGKILL — parent is alive, guard should skip
        throw new Error(`Unexpected SIGKILL on pid ${pid}`)
      })

      const ws = store.create("managed-agent")
      ws.writeProcessInfo({ pid: 55555, parentPid: process.pid })
      // No output.md — so hasOutput() guard does NOT trigger

      reapOrphans(store)

      // Guard must have kicked in: no output.md, no terminal event, no SIGKILL
      expect(ws.hasOutput()).toBe(false)
      const events = ws.readProgressEvents()
      const terminal = events.find(e => e.type === "terminal")
      expect(terminal).toBeUndefined()

      // Confirm kill was only called for liveness checks (signal 0), never SIGKILL
      const killCalls = spy.mock.calls.filter(([p, s]) => s === "SIGKILL")
      expect(killCalls).toHaveLength(0)

      spy.mockRestore()
    })

    it("treats EPERM on liveness check as alive, attempts kill, handles EPERM gracefully", () => {
      // isPidAlive returns true when process.kill(pid, 0) throws EPERM
      // (process exists but caller lacks permission). The code then attempts
      // SIGKILL, which also throws EPERM — caught by the try-catch, silently skipped.
      const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        const err = new Error("Operation not permitted") as NodeJS.ErrnoException
        err.code = "EPERM"
        throw err
      })

      const ws = store.create("eperm-agent")
      ws.writeProcessInfo({ pid: 77777 })

      reapOrphans(store)

      // EPERM on liveness check → treated as alive → code attempts SIGKILL
      // → EPERM on SIGKILL → caught by try-catch → return before writing output
      expect(ws.hasOutput()).toBe(false)
      const events = ws.readProgressEvents()
      const terminal = events.find(e => e.type === "terminal")
      expect(terminal).toBeUndefined()

      // Confirm kill was called (liveness check + SIGKILL attempt)
      const allKillCalls = spy.mock.calls
      expect(allKillCalls.length).toBeGreaterThanOrEqual(1)
      // First call should be signal 0 (liveness check)
      expect(allKillCalls[0][1]).toBe(0)
      // If there's a second call, it should be SIGKILL
      if (allKillCalls.length > 1) {
        expect(allKillCalls[1][1]).toBe("SIGKILL")
      }

      spy.mockRestore()
    })

    it("skips workspaces with no process.json", () => {
      store.create("no-process-agent") // no process.json written

      // Should not throw
      expect(() => reapOrphans(store)).not.toThrow()
    })

    it("skips workspaces with invalid PID", () => {
      const ws = store.create("bad-pid-agent")
      ws.writeProcessInfo({ pid: -1 })

      reapOrphans(store)

      // Should not have output.md (orphan not reaped)
      expect(ws.hasOutput()).toBe(false)
    })

    it("skips workspaces with corrupted process.json instead of crashing the spawner", () => {
      // A truncated process.json (partial write from a crashed process) must not
      // throw out of reapOrphans — it should be treated like a missing process.json
      // and skipped gracefully. Otherwise orphan recovery crashes the spawner at
      // startup, the opposite of what recovery is for.
      const ws = store.create("corrupted-agent")
      ws.writeProcessInfo({ pid: 12345 })

      // Overwrite process.json with truncated JSON (simulates a partial write)
      const { writeFileSync } = require("node:fs")
      const agentDir = join(tempDir, ".pi", "subagents", "corrupted-agent")
      writeFileSync(join(agentDir, "process.json"), '{"pid":12345,"parentPid":', "utf-8")

      // Should not throw — corrupted process.json is skipped gracefully
      expect(() => reapOrphans(store)).not.toThrow()

      // Should not have written output.md (reaping skipped)
      const reopened = store.open("corrupted-agent")
      expect(reopened.hasOutput()).toBe(false)
    })
  })
})
