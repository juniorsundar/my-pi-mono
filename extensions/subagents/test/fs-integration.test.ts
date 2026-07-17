import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TaskWorkspace } from "../src/task-workspace.js"
import { WorkspaceStore } from "../src/workspace-store.js"
import { parseEventLine } from "../src/progress-event.js"
import type { ProgressEvent } from "../src/progress-event.js"

/**
 * Thin fs-integration suite (issue-06, PRD user story #19).
 *
 * Covers the one path the in-memory seam can't: the durable log and
 * cross-process reconstruction via the real filesystem.
 *
 * Kept deliberately small — two focused tests framing the cross-process
 * orphan-recovery contract (ADR-0001). Existing unit coverage in
 * task-workspace.test.ts covers the in-memory seam; this file exercises
 * the filesystem seam end-to-end through the public workspace/store API.
 */
describe("fs-integration — durable log and cross-process recovery", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fs-integration-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const makeEvent = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
    type: "lifecycle",
    text: "started",
    timestamp: "2026-06-25T00:00:00.000Z",
    ...overrides,
  })

  /**
   * Real appendEvent on the filesystem backing lands a parseable JSON line in
   * progress.jsonl on disk.
   *
   * Verifies the durable-log contract: appendEvent writes to the real tmpdir,
   * and a raw readFileSync from the same path yields a line that round-trips
   * through parseEventLine. This is the in-memory seam's complement — the path
   * the unit tests can't exercise.
   */
  it("real appendEvent on FsBacking lands a parseable line in progress.jsonl on disk", () => {
    const ws = TaskWorkspace.create(tempDir)
    const event = makeEvent({ text: "scout finished", type: "terminal", status: "completed" })

    ws.appendEvent(event)

    // Read the durable log directly from disk — not through the workspace API
    const raw = readFileSync(join(tempDir, "progress.jsonl"), "utf-8").trim()
    expect(raw).toBeTruthy()

    const lines = raw.split("\n")
    expect(lines).toHaveLength(1)

    // The line must round-trip through parseEventLine (the canonical parser)
    const result = parseEventLine(lines[0])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.text).toBe("scout finished")
      expect(result.event.type).toBe("terminal")
      expect(result.event.status).toBe("completed")
      expect(result.event.timestamp).toBe(event.timestamp)
    }
  })

  /**
   * open() reconstructs events + output from a directory written by a
   * simulated *different* process — the cross-process orphan-recovery path.
   *
   * A live process writes task.md, manifest.json, progress.jsonl, and output.md
   * via raw fs. A new WorkspaceStore then opens the agent directory and
   * reconstructs the full workspace state through public reads. This is the
   * contract that orphan recovery depends on: a crashed run's files are fully
   * legible to a fresh process via the workspace seam.
   */
  it("WorkspaceStore.open() reconstructs events + output from a foreign directory", () => {
    const agentId = "orphan-worker-abc123"

    // ── Simulate a different process writing run files via raw fs ──
    const agentDir = join(tempDir, agentId)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, "task.md"), "Analyze the codebase and report", "utf-8")

    writeFileSync(
      join(agentDir, "manifest.json"),
      JSON.stringify({
        agentId,
        taskDir: agentDir,
        command: ["pi", "analyze"],
        env: { MODEL: "gpt-4" },
      }),
      "utf-8",
    )

    // Write progress events as raw JSON lines (simulating the dead process's durable log)
    const events: ProgressEvent[] = [
      { type: "lifecycle", text: "started", timestamp: "2026-06-25T01:00:00.000Z" },
      { type: "tool", text: "reading files", timestamp: "2026-06-25T01:00:01.000Z", toolName: "read" },
      { type: "terminal", text: "completed", timestamp: "2026-06-25T01:00:05.000Z", status: "completed" },
    ]
    writeFileSync(
      join(agentDir, "progress.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8",
    )

    writeFileSync(
      join(agentDir, "output.md"),
      "# Analysis\n\nThe codebase is well-structured.",
      "utf-8",
    )

    // ── A fresh process opens via the workspace store ──
    const store = new WorkspaceStore(tempDir)
    const ws = store.open(agentId)

    // All run-file data must be reconstructed through workspace reads
    expect(ws.readTask()).toBe("Analyze the codebase and report")
    expect(ws.readManifest()?.agentId).toBe(agentId)
    expect(ws.readManifest()?.command).toEqual(["pi", "analyze"])
    expect(ws.hasOutput()).toBe(true)
    expect(ws.readOutput()).toBe("# Analysis\n\nThe codebase is well-structured.")

    // Events must round-trip from the durable log (buffer is empty → disk fallback)
    const recovered = ws.readProgressEvents()
    expect(recovered).toHaveLength(3)
    expect(recovered[0]).toEqual(events[0])
    expect(recovered[1]).toEqual(events[1])
    expect(recovered[2]).toEqual(events[2])

    // Must also be able to write a terminal event to the foreign workspace
    // (simulating orphan reap recording a terminal event after recovery)
    ws.appendEvent({
      type: "terminal",
      text: "Orphan process reaped during crash recovery",
      timestamp: "2026-06-25T02:00:00.000Z",
      status: "failed",
    })

    // The appended event must also be parseable from disk for other readers
    const rawAfter = readFileSync(join(agentDir, "progress.jsonl"), "utf-8").split("\n").filter(Boolean)
    expect(rawAfter).toHaveLength(4)

    const reapResult = parseEventLine(rawAfter[3])
    expect(reapResult.ok).toBe(true)
    if (reapResult.ok) {
      expect(reapResult.event.text).toBe("Orphan process reaped during crash recovery")
      expect(reapResult.event.status).toBe("failed")
    }
  })
})
