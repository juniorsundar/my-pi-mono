import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WorkspaceStore } from "../src/workspace-store.js"
import type { ManifestData } from "../src/task-workspace.js"

describe("WorkspaceStore", () => {
  let tempDir: string
  let store: WorkspaceStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "workspace-store-test-"))
    store = new WorkspaceStore(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("create", () => {
    it("creates the agent directory and returns a TaskWorkspace", () => {
      const ws = store.create("scout-a1b2c3")

      // Directory should exist
      const { existsSync } = require("node:fs")
      expect(existsSync(join(tempDir, "scout-a1b2c3"))).toBe(true)

      // Should be able to write through the workspace
      ws.writeTask("test task")
      const { readFileSync } = require("node:fs")
      expect(readFileSync(join(tempDir, "scout-a1b2c3", "task.md"), "utf-8")).toBe("test task")
    })

    it("creates nested directories if needed", () => {
      store.create("agent-1")
      store.create("agent-2")

      const { existsSync } = require("node:fs")
      expect(existsSync(join(tempDir, "agent-1"))).toBe(true)
      expect(existsSync(join(tempDir, "agent-2"))).toBe(true)
    })
  })

  describe("open", () => {
    it("opens an existing agent directory", () => {
      // First create one
      store.create("existing-agent").writeTask("original task")

      // Now open it
      const ws = store.open("existing-agent")
      expect(ws.readTask()).toBe("original task")
    })

    it("throws when the agent directory does not exist", () => {
      expect(() => store.open("missing-agent")).toThrow(
        "Task workspace does not exist for agent: missing-agent",
      )
    })
  })

  describe("remove", () => {
    it("deletes an existing agent directory", () => {
      store.create("agent-to-remove").writeTask("task")
      expect(existsSync(join(tempDir, "agent-to-remove"))).toBe(true)

      store.remove("agent-to-remove")

      expect(existsSync(join(tempDir, "agent-to-remove"))).toBe(false)
    })

    it("is a no-op when the agent directory does not exist", () => {
      expect(() => store.remove("never-created")).not.toThrow()
      expect(existsSync(join(tempDir, "never-created"))).toBe(false)
    })

    it("rejects an agentId containing path separators", () => {
      expect(() => store.remove("../escape")).toThrow(/agentId/)
      expect(() => store.remove("sub/dir")).toThrow(/agentId/)
    })

    it("rejects an agentId containing a parent-directory reference", () => {
      expect(() => store.remove("..")).toThrow(/agentId/)
      expect(() => store.remove("agent-1/..")).toThrow(/agentId/)
    })
  })

  describe("list", () => {
    it("returns empty array when no agents exist", () => {
      expect(store.list()).toEqual([])
    })

    it("returns TaskWorkspace instances for each agent directory", () => {
      store.create("alpha").writeManifest({ agentId: "alpha", taskDir: join(tempDir, "alpha"), command: ["pi"], env: {} } satisfies ManifestData)
      store.create("beta").writeManifest({ agentId: "beta", taskDir: join(tempDir, "beta"), command: ["pi"], env: {} } satisfies ManifestData)
      store.create("gamma").writeManifest({ agentId: "gamma", taskDir: join(tempDir, "gamma"), command: ["pi"], env: {} } satisfies ManifestData)

      const workspaces = store.list()
      expect(workspaces).toHaveLength(3)

      // Each should be reopened and usable through public reads
      expect(workspaces.map(ws => ws.readManifest()?.agentId).sort()).toEqual(["alpha", "beta", "gamma"])
    })

    it("ignores non-directory entries", () => {
      store.create("real-agent")
      // Create a file (not a directory) in the root
      const { writeFileSync } = require("node:fs")
      writeFileSync(join(tempDir, "not-a-directory.txt"), "hello", "utf-8")

      const workspaces = store.list()
      expect(workspaces).toHaveLength(1)
    })
  })

  describe("gcCompleted", () => {
    it("retains the N most-recent completed workspaces", () => {
      for (let i = 0; i < 5; i++) {
        store.create(`agent-${i}`).writeOutput(`output ${i}`)
      }

      store.gcCompleted(2)

      const remaining = store.list().map(ws => ws.agentId).sort()
      expect(remaining).toEqual(["agent-3", "agent-4"])
    })

    it("leaves uncompleted workspaces untouched", () => {
      for (let i = 0; i < 3; i++) {
        store.create(`done-${i}`).writeOutput(`output ${i}`)
      }
      for (let i = 0; i < 3; i++) {
        store.create(`pending-${i}`).writeTask("task")
      }

      store.gcCompleted(1)

      const remaining = store.list().map(ws => ws.agentId).sort()
      expect(remaining).toEqual(["done-2", "pending-0", "pending-1", "pending-2"])
    })

    it("orders by output.md mtime, not directory creation time", () => {
      store.create("older-dir").writeTask("task")
      store.create("newer-output").writeTask("task")
      // Write output to newer-output first, then older-dir, so older-dir is the
      // most-recently completed workspace.
      store.open("newer-output").writeOutput("first output")
      store.open("older-dir").writeOutput("second output")

      store.gcCompleted(1)

      const remaining = store.list().map(ws => ws.agentId)
      expect(remaining).toEqual(["older-dir"])
    })

    it("breaks timestamp ties by agentId ascending", () => {
      const sameTime = new Date("2026-01-01T00:00:00.000Z")
      for (let i = 0; i < 3; i++) {
        const id = `tie-${i}`
        store.create(id)
        const outputPath = join(tempDir, id, "output.md")
        writeFileSync(outputPath, "same time", "utf-8")
        utimesSync(outputPath, sameTime, sameTime)
      }

      store.gcCompleted(1)

      const remaining = store.list().map(ws => ws.agentId)
      expect(remaining).toEqual(["tie-2"])
    })

    it("evicts all completed workspaces when retain is 0", () => {
      store.create("a").writeOutput("out")
      store.create("b").writeOutput("out")

      store.gcCompleted(0)

      expect(store.list()).toEqual([])
    })

    it("throws when retain is negative or not an integer", () => {
      expect(() => store.gcCompleted(-1)).toThrow(/retain/)
      expect(() => store.gcCompleted(1.5)).toThrow(/retain/)
    })
  })

  describe("agentId sanitization (path-traversal guard)", () => {
    it("create rejects an agentId containing path separators", () => {
      expect(() => store.create("../escape")).toThrow(/agentId/)
      expect(() => store.create("sub/dir")).toThrow(/agentId/)
    })

    it("create rejects an agentId containing a parent-directory reference", () => {
      expect(() => store.create("..")).toThrow(/agentId/)
      expect(() => store.create("agent-1/..")).toThrow(/agentId/)
    })

    it("open rejects an agentId containing path separators", () => {
      expect(() => store.open("../escape")).toThrow(/agentId/)
      expect(() => store.open("sub/dir")).toThrow(/agentId/)
    })

    it("create/open accept a normal agentId (sanity check)", () => {
      expect(() => store.create("normal-agent-id")).not.toThrow()
      expect(() => store.open("normal-agent-id")).not.toThrow()
    })

    it("list() skips directories with unsafe names and returns valid workspaces", () => {
      store.create("valid-agent")
      // Manually create junk directories that would fail assertSafeAgentId
      // but are valid on the local filesystem (Linux allows backslash and leading dots)
      mkdirSync(join(tempDir, "..bad"))
      mkdirSync(join(tempDir, "normal..dotdot"))

      const workspaces = store.list()
      expect(workspaces).toHaveLength(1)
    })
  })
})
