import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync, writeFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { TaskWorkspace } from "../src/task-workspace.js"
import type { ManifestData } from "../src/task-workspace.js"
import type { ProgressEvent } from "../src/progress-event.js"

describe("TaskWorkspace", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "task-workspace-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("writeTask", () => {
    it("creates task.md with the given content", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeTask("You are a scout agent")

      const content = readFileSync(join(tempDir, "task.md"), "utf-8")
      expect(content).toBe("You are a scout agent")
    })

    it("overwrites existing task.md", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeTask("first")
      ws.writeTask("second")

      const content = readFileSync(join(tempDir, "task.md"), "utf-8")
      expect(content).toBe("second")
    })

    it("readTask returns the content of task.md", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeTask("recovered task")

      expect(ws.readTask()).toBe("recovered task")
    })
  })

  describe("writeManifest", () => {
    it("creates manifest.json with the given data", () => {
      const ws = TaskWorkspace.create(tempDir)
      const manifest: ManifestData = {
        agentId: "scout-a3f1b2c3",
        taskDir: join(tempDir),
        command: ["pi", "subagent", "--type", "scout"],
        env: { NODE_ENV: "test" },
      }

      ws.writeManifest(manifest)

      const content = readFileSync(join(tempDir, "manifest.json"), "utf-8")
      expect(JSON.parse(content)).toEqual(manifest)
    })

    it("overwrites existing manifest.json", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeManifest({ agentId: "first", taskDir: "", command: [], env: {} })
      ws.writeManifest({ agentId: "second", taskDir: "", command: [], env: {} })

      const content = readFileSync(join(tempDir, "manifest.json"), "utf-8")
      expect(JSON.parse(content).agentId).toBe("second")
    })

    it("readManifest returns the parsed manifest", () => {
      const ws = TaskWorkspace.create(tempDir)
      const manifest: ManifestData = {
        agentId: "scout-a3f1b2c3",
        taskDir: tempDir,
        command: ["pi", "subagent", "--type", "scout"],
        env: { NODE_ENV: "test" },
      }

      ws.writeManifest(manifest)

      expect(ws.readManifest()).toEqual(manifest)
    })
  })

  describe("writeOutput / readOutput / hasOutput", () => {
    it("writeOutput creates output.md with the given content", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeOutput("Task completed successfully")

      const content = readFileSync(join(tempDir, "output.md"), "utf-8")
      expect(content).toBe("Task completed successfully")
    })

    it("readOutput returns the content of output.md", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeOutput("Final result")

      expect(ws.readOutput()).toBe("Final result")
    })

    it("readOutput returns null when output.md does not exist", () => {
      const ws = TaskWorkspace.create(tempDir)
      expect(ws.readOutput()).toBeNull()
    })

    it("hasOutput returns true when output.md exists", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeOutput("done")
      expect(ws.hasOutput()).toBe(true)
    })

    it("hasOutput returns false when output.md does not exist", () => {
      const ws = TaskWorkspace.create(tempDir)
      expect(ws.hasOutput()).toBe(false)
    })

    it("completedAt returns output.md mtime when output exists", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeOutput("done")
      const completedAt = ws.completedAt()
      const expectedMtime = statSync(join(tempDir, "output.md")).mtime
      expect(completedAt).not.toBeNull()
      expect(completedAt!.getTime()).toBe(expectedMtime.getTime())
    })

    it("completedAt returns null when output.md does not exist", () => {
      const ws = TaskWorkspace.create(tempDir)
      expect(ws.completedAt()).toBeNull()
    })

    it("agentId returns the directory basename", () => {
      const ws = TaskWorkspace.create(tempDir)
      expect(ws.agentId).toBe(basename(tempDir))
    })
  })

  describe("writeProcessInfo / readProcessInfo", () => {
    it("writeProcessInfo creates process.json with the given data", () => {
      const ws = TaskWorkspace.create(tempDir)
      const info = { pid: 12345, agentType: "scout" }

      ws.writeProcessInfo(info)

      const content = JSON.parse(readFileSync(join(tempDir, "process.json"), "utf-8"))
      expect(content).toEqual(info)
    })

    it("readProcessInfo returns the parsed data", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeProcessInfo({ pid: 99, agentType: "worker" })

      expect(ws.readProcessInfo()).toEqual({ pid: 99, agentType: "worker" })
    })

    it("readProcessInfo returns null when process.json does not exist", () => {
      const ws = TaskWorkspace.create(tempDir)
      expect(ws.readProcessInfo()).toBeNull()
    })
  })

  describe("log", () => {
    it("appends lines to run.log", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.log("spawned pi child")
      ws.log("exit code 0")

      const content = readFileSync(join(tempDir, "run.log"), "utf-8")
      expect(content).toContain("spawned pi child")
      expect(content).toContain("exit code 0")
    })

    it("creates run.log on first call", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.log("first line")

      expect(existsSync(join(tempDir, "run.log"))).toBe(true)
    })

    it("readLog returns the log content", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.log("first line")
      ws.log("second line")

      expect(ws.readLog()).toContain("first line")
      expect(ws.readLog()).toContain("second line")
    })
  })

  describe("appendRawLine", () => {
    it("appends a line to events.jsonl", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.appendRawLine('{"type":"lifecycle","text":"started"}')

      const content = readFileSync(join(tempDir, "events.jsonl"), "utf-8").trim()
      expect(content).toBe('{"type":"lifecycle","text":"started"}')
    })

    it("accumulates multiple lines", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.appendRawLine("line1")
      ws.appendRawLine("line2")

      const lines = readFileSync(join(tempDir, "events.jsonl"), "utf-8").trim().split("\n")
      expect(lines).toHaveLength(2)
      expect(lines[1]).toBe("line2")
    })

    it("readRawEvents returns all raw lines", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.appendRawLine("line1")
      ws.appendRawLine("line2")

      expect(ws.readRawEvents()).toEqual(["line1", "line2"])
    })
  })

  describe("appendEvent / readProgressEvents", () => {
    const makeEvent = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
      type: "lifecycle",
      text: "started",
      timestamp: "2026-06-24T00:00:00.000Z",
      ...overrides,
    })

    it("appendEvent writes one JSON line to progress.jsonl", () => {
      const ws = TaskWorkspace.create(tempDir)
      const event = makeEvent()

      ws.appendEvent(event)

      const lines = readFileSync(join(tempDir, "progress.jsonl"), "utf-8")
        .trim()
        .split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toEqual(event)
    })

    it("appendEvent accumulates multiple events", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.appendEvent(makeEvent({ text: "first" }))
      ws.appendEvent(makeEvent({ text: "second" }))
      ws.appendEvent(makeEvent({ text: "third" }))

      const lines = readFileSync(join(tempDir, "progress.jsonl"), "utf-8")
        .trim()
        .split("\n")
      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0]).text).toBe("first")
      expect(JSON.parse(lines[2]).text).toBe("third")
    })

    it("readProgressEvents returns parsed events from progress.jsonl", () => {
      const ws = TaskWorkspace.create(tempDir)
      const e1 = makeEvent({ text: "hello", type: "tool" })
      const e2 = makeEvent({ text: "world", type: "assistant_text" })
      ws.appendEvent(e1)
      ws.appendEvent(e2)

      const events = ws.readProgressEvents()
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual(e1)
      expect(events[1]).toEqual(e2)
    })

    it("readProgressEvents returns empty array when file does not exist", () => {
      const ws = TaskWorkspace.create(tempDir)
      expect(ws.readProgressEvents()).toEqual([])
    })

    it("readProgressEvents returns from buffer, not disk, when buffer is non-empty", () => {
      const ws = TaskWorkspace.create(tempDir)
      const e1 = makeEvent({ text: "from-buffer" })
      ws.appendEvent(e1)

      // Overwrite the file with different events — simulates another writer
      writeFileSync(
        join(tempDir, "progress.jsonl"),
        JSON.stringify(makeEvent({ text: "from-disk" })) + "\n",
        "utf-8",
      )

      // readProgressEvents should return the buffer's event, not the file's
      const events = ws.readProgressEvents()
      expect(events).toHaveLength(1)
      expect(events[0].text).toBe("from-buffer")
    })

    it("readProgressEvents falls back to disk when buffer is empty (recovery)", () => {
      // Write events directly to disk (simulating a previous run)
      const e1 = makeEvent({ text: "recovered" })
      writeFileSync(
        join(tempDir, "progress.jsonl"),
        JSON.stringify(e1) + "\n",
        "utf-8",
      )

      // Open a fresh workspace — buffer is empty, should read from disk
      const reopened = TaskWorkspace.open(tempDir)
      const events = reopened.readProgressEvents()
      expect(events).toHaveLength(1)
      expect(events[0].text).toBe("recovered")
    })

    it("readProgressEvents skips invalid lines", () => {
      const ws = TaskWorkspace.create(tempDir)
      writeFileSync(join(tempDir, "progress.jsonl"),
        JSON.stringify(makeEvent()) + "\nnot-json\n" + JSON.stringify(makeEvent({ text: "after" })) + "\n",
        "utf-8")

      const events = ws.readProgressEvents()
      expect(events).toHaveLength(2)
      expect(events[0].text).toBe("started")
      expect(events[1].text).toBe("after")
    })
  })

  describe("tailEvents", () => {
    const makeEvent = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
      type: "lifecycle",
      text: "started",
      timestamp: "2026-06-24T00:00:00.000Z",
      ...overrides,
    })

    it("replays buffered backlog then yields live events", async () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.appendEvent(makeEvent({ text: "backlog-1" }))
      ws.appendEvent(makeEvent({ text: "backlog-2" }))

      const controller = new AbortController()
      const collected: ProgressEvent[] = []

      // Start tailing — should yield backlog immediately
      const tail = ws.tailEvents(controller.signal)
      for await (const event of tail) {
        collected.push(event)
        // After collecting backlog, append a live event and stop
        if (collected.length === 2) {
          ws.appendEvent(makeEvent({ text: "live-1" }))
          // Give the live event time to arrive
          await new Promise(r => setTimeout(r, 20))
          controller.abort()
        }
      }

      expect(collected.map(e => e.text)).toEqual(["backlog-1", "backlog-2", "live-1"])
    })

    it("returns empty iterable when no events exist", async () => {
      const ws = TaskWorkspace.create(tempDir)
      const controller = new AbortController()

      // Abort immediately so the iterator doesn't hang
      controller.abort()

      const collected: ProgressEvent[] = []
      for await (const event of ws.tailEvents(controller.signal)) {
        collected.push(event)
      }

      expect(collected).toEqual([])
    })

    it("late subscriber sees full ordered sequence — synchronous, no fake timers", async () => {
      // In-memory workspace: no tmpdir, no fs, no timers
      const ws = TaskWorkspace.inMemory()

      // Append events BEFORE subscribing — simulates a subscriber attaching late
      ws.appendEvent(makeEvent({ text: "backlog-1", type: "lifecycle" }))
      ws.appendEvent(makeEvent({ text: "backlog-2", type: "tool" }))
      ws.appendEvent(makeEvent({ text: "backlog-3", type: "usage", input: 10, output: 5 }))

      // Subscribe after all appends — tailEvents replays from buffer index 0
      const controller = new AbortController()
      const iter = ws.tailEvents(controller.signal)[Symbol.asyncIterator]()

      // Collect backlog: each next() returns a resolved promise (buffer already populated)
      const e1 = await iter.next()
      const e2 = await iter.next()
      const e3 = await iter.next()

      expect(e1.done).toBe(false)
      expect(e1.value.text).toBe("backlog-1")
      expect(e1.value.type).toBe("lifecycle")

      expect(e2.done).toBe(false)
      expect(e2.value.text).toBe("backlog-2")
      expect(e2.value.type).toBe("tool")

      expect(e3.done).toBe(false)
      expect(e3.value.text).toBe("backlog-3")
      expect(e3.value.type).toBe("usage")

      // Cleanup: abort to unsubscribe
      controller.abort()
    })

    it("cancellation while pending resolves iterator with done:true", async () => {
      const ws = TaskWorkspace.inMemory()
      const controller = new AbortController()

      // Subscribe with empty buffer — iterator will pend on next()
      const iter = ws.tailEvents(controller.signal)[Symbol.asyncIterator]()

      // Start a pending next() — it will hang until abort or append
      const pending = iter.next()

      // Abort while the iterator is pending — should resolve with done:true
      controller.abort()

      const result = await pending
      expect(result.done).toBe(true)
    })
  })

  describe("TaskWorkspace.open", () => {
    it("reconstructs a workspace over an existing directory", () => {
      // First, create a workspace and write some files
      const ws = TaskWorkspace.create(tempDir)
      ws.writeTask("existing task")
      ws.writeManifest({ agentId: "recovery-id", taskDir: tempDir, command: ["pi"], env: {} })

      // Now, open it as a new instance (simulating recovery)
      const reopened = TaskWorkspace.open(tempDir)

      // Should be able to read the existing files
      expect(reopened.readTask()).toBe("existing task")
      expect(reopened.readManifest()).toMatchObject({ agentId: "recovery-id", taskDir: tempDir })
    })

    it("can read existing progress events after open", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.appendEvent({ type: "lifecycle", text: "started", timestamp: "2026-01-01T00:00:00Z" })
      ws.appendEvent({ type: "terminal", text: "done", timestamp: "2026-01-01T00:00:01Z" })

      const reopened = TaskWorkspace.open(tempDir)
      const events = reopened.readProgressEvents()
      expect(events).toHaveLength(2)
      expect(events[0].text).toBe("started")
      expect(events[1].text).toBe("done")
    })

    it("can read existing output after open", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeOutput("final result")

      const reopened = TaskWorkspace.open(tempDir)
      expect(reopened.readOutput()).toBe("final result")
      expect(reopened.hasOutput()).toBe(true)
    })

    it("can read existing process info after open", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.writeProcessInfo({ pid: 42, agentType: "worker" })

      const reopened = TaskWorkspace.open(tempDir)
      expect(reopened.readProcessInfo()).toEqual({ pid: 42, agentType: "worker" })
    })

    it("can append terminal event to existing workspace", () => {
      const ws = TaskWorkspace.create(tempDir)
      ws.appendEvent({ type: "lifecycle", text: "started", timestamp: "2026-01-01T00:00:00Z" })

      const reopened = TaskWorkspace.open(tempDir)
      // Before appending, buffer is empty — reads from disk (recovery path)
      expect(reopened.readProgressEvents()).toHaveLength(1)

      reopened.appendEvent({ type: "terminal", text: "killed", timestamp: "2026-01-01T00:00:02Z" })

      // After appending, buffer is non-empty — returns from buffer (this instance only)
      const events = reopened.readProgressEvents()
      expect(events).toHaveLength(1)
      expect(events[0].text).toBe("killed")
    })

    it("throws when opening a missing directory", () => {
      expect(() => TaskWorkspace.open(join(tempDir, "missing-agent"))).toThrow(
        `Task workspace does not exist: ${join(tempDir, "missing-agent")}`,
      )
    })
  })

  // ── In-memory seam (issue-02: dual-seam design) ──
  // These tests exercise TaskWorkspace through its public interface using the
  // in-memory backing — no tmpdir, no fs. They pin the unit-test seam
  // (PRD user story #16).

  describe("in-memory seam — writeOutput / readOutput / hasOutput", () => {
    it("writeOutput + readOutput round-trip", () => {
      const ws = TaskWorkspace.inMemory()
      ws.writeOutput("Hello from in-memory workspace")
      expect(ws.readOutput()).toBe("Hello from in-memory workspace")
    })

    it("readOutput returns null when nothing written", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.readOutput()).toBeNull()
    })

    it("hasOutput is true after writeOutput, false before", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.hasOutput()).toBe(false)
      ws.writeOutput("done")
      expect(ws.hasOutput()).toBe(true)
    })

    it("writeOutput overwrites previous content", () => {
      const ws = TaskWorkspace.inMemory()
      ws.writeOutput("first")
      ws.writeOutput("second")
      expect(ws.readOutput()).toBe("second")
    })

    it("completedAt returns a Date after writeOutput, null before", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.completedAt()).toBeNull()
      ws.writeOutput("done")
      const completedAt = ws.completedAt()
      expect(completedAt).toBeInstanceOf(Date)
      expect(completedAt!.getTime()).toBeLessThanOrEqual(Date.now())
    })
  })

  describe("in-memory seam — writeTask / readTask", () => {
    it("writeTask + readTask round-trip", () => {
      const ws = TaskWorkspace.inMemory()
      ws.writeTask("You are a scout agent")
      expect(ws.readTask()).toBe("You are a scout agent")
    })

    it("readTask returns null when nothing written", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.readTask()).toBeNull()
    })
  })

  describe("in-memory seam — writeManifest / readManifest", () => {
    it("writeManifest + readManifest round-trip", () => {
      const ws = TaskWorkspace.inMemory()
      const manifest: ManifestData = {
        agentId: "scout-a3f1b2c3",
        taskDir: "/tmp/test-dir",
        command: ["pi", "subagent", "--type", "scout"],
        env: { NODE_ENV: "test" },
      }
      ws.writeManifest(manifest)
      expect(ws.readManifest()).toEqual(manifest)
    })

    it("readManifest returns null when nothing written", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.readManifest()).toBeNull()
    })

    it("writeManifest overwrites previous content", () => {
      const ws = TaskWorkspace.inMemory()
      ws.writeManifest({ agentId: "first", taskDir: "", command: [], env: {} })
      ws.writeManifest({ agentId: "second", taskDir: "", command: [], env: {} })
      expect(ws.readManifest()?.agentId).toBe("second")
    })
  })

  describe("in-memory seam — writeProcessInfo / readProcessInfo", () => {
    it("writeProcessInfo + readProcessInfo round-trip", () => {
      const ws = TaskWorkspace.inMemory()
      const info = { pid: 12345, parentPid: 1, agentType: "scout" }
      ws.writeProcessInfo(info)
      expect(ws.readProcessInfo()).toEqual(info)
    })

    it("readProcessInfo returns null when nothing written", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.readProcessInfo()).toBeNull()
    })
  })

  describe("in-memory seam — appendRawLine / readRawEvents", () => {
    it("appendRawLine accumulates lines, readRawEvents returns all", () => {
      const ws = TaskWorkspace.inMemory()
      ws.appendRawLine('{"type":"lifecycle","text":"started"}')
      ws.appendRawLine('{"type":"lifecycle","text":"finished"}')
      expect(ws.readRawEvents()).toEqual([
        '{"type":"lifecycle","text":"started"}',
        '{"type":"lifecycle","text":"finished"}',
      ])
    })

    it("readRawEvents returns empty array when nothing appended", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.readRawEvents()).toEqual([])
    })
  })

  describe("in-memory seam — appendEvent / readProgressEvents", () => {
    const makeEvent = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
      type: "lifecycle",
      text: "started",
      timestamp: "2026-06-24T00:00:00.000Z",
      ...overrides,
    })

    it("appendEvent + readProgressEvents round-trip", () => {
      const ws = TaskWorkspace.inMemory()
      const e1 = makeEvent({ text: "hello", type: "tool" })
      const e2 = makeEvent({ text: "world", type: "assistant_text" })
      ws.appendEvent(e1)
      ws.appendEvent(e2)

      const events = ws.readProgressEvents()
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual(e1)
      expect(events[1]).toEqual(e2)
    })

    it("append→read preserves insertion order across mixed event types", () => {
      const ws = TaskWorkspace.inMemory()
      const lifecycle = makeEvent({ type: "lifecycle", text: "started" })
      const tool = makeEvent({ type: "tool", text: "reading file" })
      const usage = makeEvent({ type: "usage", text: "done", input: 100, output: 50 })
      const terminal = makeEvent({ type: "terminal", text: "completed" })

      ws.appendEvent(lifecycle)
      ws.appendEvent(tool)
      ws.appendEvent(usage)
      ws.appendEvent(terminal)

      const events = ws.readProgressEvents()
      expect(events).toHaveLength(4)
      expect(events.map(e => e.type)).toEqual(["lifecycle", "tool", "usage", "terminal"])
      expect(events.map(e => e.text)).toEqual(["started", "reading file", "done", "completed"])
    })

    it("readProgressEvents returns empty array when nothing appended", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.readProgressEvents()).toEqual([])
    })

    it("readProgressEvents skips malformed lines when seeded through the in-memory seam", () => {
      const valid = JSON.stringify(makeEvent({ text: "before" }))
      const malformed = '{"type":"lifecycle","text":'
      const after = JSON.stringify(makeEvent({ text: "after" }))

      const ws = TaskWorkspace.inMemory({ "progress.jsonl": `${valid}\n${malformed}\n${after}\n` })

      const events = ws.readProgressEvents()
      expect(events).toHaveLength(2)
      expect(events[0].text).toBe("before")
      expect(events[1].text).toBe("after")
    })
  })

  describe("in-memory seam — log / readLog", () => {
    it("log accumulates lines, readLog returns all", () => {
      const ws = TaskWorkspace.inMemory()
      ws.log("spawned pi child")
      ws.log("exit code 0")

      const content = ws.readLog()
      expect(content).toContain("spawned pi child")
      expect(content).toContain("exit code 0")
    })

    it("readLog returns null when nothing logged", () => {
      const ws = TaskWorkspace.inMemory()
      expect(ws.readLog()).toBeNull()
    })
  })

  describe("in-memory seam — identity accessors", () => {
    it("directory getter throws for in-memory workspace", () => {
      const ws = TaskWorkspace.inMemory()
      expect(() => ws.directory).toThrow("In-memory workspace has no directory")
    })

    it("agentId getter throws for in-memory workspace", () => {
      const ws = TaskWorkspace.inMemory()
      expect(() => ws.agentId).toThrow("In-memory workspace has no agentId")
    })
  })

  describe("in-memory seam — tailEvents", () => {
    const makeEvent = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
      type: "lifecycle",
      text: "started",
      timestamp: "2026-06-24T00:00:00.000Z",
      ...overrides,
    })

    it("replays backlog then yields live events — in-memory", async () => {
      const ws = TaskWorkspace.inMemory()
      ws.appendEvent(makeEvent({ text: "backlog-1" }))
      ws.appendEvent(makeEvent({ text: "backlog-2" }))

      const controller = new AbortController()
      const collected: ProgressEvent[] = []

      for await (const event of ws.tailEvents(controller.signal)) {
        collected.push(event)
        if (collected.length === 2) {
          ws.appendEvent(makeEvent({ text: "live-1" }))
          await new Promise(r => setTimeout(r, 20))
          controller.abort()
        }
      }

      expect(collected.map(e => e.text)).toEqual(["backlog-1", "backlog-2", "live-1"])
    })

    it("returns empty iterable when no events exist — in-memory", async () => {
      const ws = TaskWorkspace.inMemory()
      const controller = new AbortController()
      controller.abort()

      const collected: ProgressEvent[] = []
      for await (const event of ws.tailEvents(controller.signal)) {
        collected.push(event)
      }

      expect(collected).toEqual([])
    })

    it("multiple subscribers receive same ordered sequence under concurrent appends", async () => {
      const ws = TaskWorkspace.inMemory()
      const c1 = new AbortController()
      const c2 = new AbortController()

      const collected1: ProgressEvent[] = []
      const collected2: ProgressEvent[] = []

      // Both subscribers attach before any appends
      const tail1 = ws.tailEvents(c1.signal)
      const tail2 = ws.tailEvents(c2.signal)

      // Run both consumers concurrently
      const consumer1 = (async () => {
        for await (const event of tail1) collected1.push(event)
      })()
      const consumer2 = (async () => {
        for await (const event of tail2) collected2.push(event)
      })()

      // Append events — appendEvent walks eventSubscribers synchronously
      ws.appendEvent(makeEvent({ text: "a" }))
      ws.appendEvent(makeEvent({ text: "b" }))
      ws.appendEvent(makeEvent({ text: "c" }))

      // Events are buffered synchronously — abort immediately
      c1.abort()
      c2.abort()
      await Promise.all([consumer1, consumer2])

      // Both must see the same ordered sequence
      expect(collected1.map(e => e.text)).toEqual(["a", "b", "c"])
      expect(collected2.map(e => e.text)).toEqual(["a", "b", "c"])
    })
  })
})
