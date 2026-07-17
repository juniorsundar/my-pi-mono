import { writeFileSync, readFileSync, existsSync, appendFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { parseEventLine } from "./progress-event.js"
import type { ProgressEvent } from "./progress-event.js"

export interface ManifestData {
  agentId: string
  taskDir: string
  command: string[]
  env: Record<string, string>
}

// ── Backing strategy ──

/**
 * Storage strategy behind a TaskWorkspace. All file I/O flows through this
 * interface — TaskWorkspace never touches `fs` or constructs paths directly.
 *
 * Backing contract (one named file at a time):
 *   write(name, content)  — create or overwrite
 *   read(name)            — return content, or null if absent
 *   exists(name)          — true if present
 *   append(name, content) — append content (caller includes trailing newline)
 */
export interface TaskWorkspaceBacking {
  write(name: string, content: string): void
  read(name: string): string | null
  exists(name: string): boolean
  append(name: string, content: string): void
  mtime(name: string): Date | null
}

/**
 * Optional initial file contents for an in-memory task workspace.
 *
 * Used by TaskWorkspace.inMemory(seed) to pre-populate the backing store only;
 * the live event buffer remains empty so recovery-style reads still parse the
 * seeded durable log through parseEventLine.
 */
export type InMemoryWorkspaceSeed = Record<string, string>

/**
 * In-memory backing. Default for unit tests (PRD user story #16).
 * No disk, no paths, no timers — pure synchronous Map-based storage.
 */
export class InMemoryBacking implements TaskWorkspaceBacking {
  private files = new Map<string, string>()
  private mtimes = new Map<string, Date>()

  write(name: string, content: string): void {
    this.files.set(name, content)
    this.mtimes.set(name, new Date())
  }

  read(name: string): string | null {
    return this.files.get(name) ?? null
  }

  exists(name: string): boolean {
    return this.files.has(name)
  }

  append(name: string, content: string): void {
    this.files.set(name, (this.files.get(name) ?? "") + content)
    this.mtimes.set(name, new Date())
  }

  mtime(name: string): Date | null {
    return this.mtimes.get(name) ?? null
  }
}

/**
 * Filesystem-backed storage. Used in production (via WorkspaceStore) and for
 * fs-integration tests that verify cross-process recovery paths (issue-06).
 */
export class FsBacking implements TaskWorkspaceBacking {
  constructor(private readonly dir: string) {}

  write(name: string, content: string): void {
    writeFileSync(join(this.dir, name), content, "utf-8")
  }

  read(name: string): string | null {
    const full = join(this.dir, name)
    return existsSync(full) ? readFileSync(full, "utf-8") : null
  }

  exists(name: string): boolean {
    return existsSync(join(this.dir, name))
  }

  append(name: string, content: string): void {
    appendFileSync(join(this.dir, name), content, "utf-8")
  }

  mtime(name: string): Date | null {
    const path = join(this.dir, name)
    if (!existsSync(path)) return null
    return statSync(path).mtime
  }
}

// ── TaskWorkspace ──

/**
 * Owns one task workspace behind an operations interface — callers name files
 * by intent (`writeOutput`, `appendEvent`, `readProgressEvents`) and never see
 * a path or call `fs`.
 *
 * Deep module: small public interface hides the backing strategy, the durable
 * log, and the live-channel event buffer behind simple operations.
 *
 * Two backings (dual-seam design, PRD user stories #16/#19):
 *   - In-memory (default via `TaskWorkspace.inMemory()`) — fast, synchronous,
 *     no tmpdir. The unit-test seam.
 *   - Filesystem (via `TaskWorkspace.create(dir)` / `.open(dir)`) — durable,
 *     cross-process. The production and recovery seam.
 */
export class TaskWorkspace {
  private constructor(
    private readonly backing: TaskWorkspaceBacking,
    private readonly dir?: string,
  ) {}

  /**
   * The absolute path to this workspace directory.
   * Throws for in-memory workspaces (no directory to expose).
   */
  get directory(): string {
    if (this.dir === undefined) {
      throw new Error("In-memory workspace has no directory — use a filesystem-backed workspace via create() or open()")
    }
    return this.dir
  }

  /**
   * The agent id naming this task workspace's directory.
   * Throws for in-memory workspaces (no directory, hence no id).
   */
  get agentId(): string {
    if (this.dir === undefined) {
      throw new Error("In-memory workspace has no agentId — use a filesystem-backed workspace via create() or open()")
    }
    return basename(this.dir)
  }

  /** In-memory event buffer for the live channel (ADR-0001). */
  private eventBuffer: ProgressEvent[] = []

  /** Subscribers notified synchronously on each appendEvent (wakeup signal, no event value). */
  private eventSubscribers: Array<() => void> = []

  // ── Factories ──

  /**
   * Create an in-memory workspace (default for unit tests).
   * No directory, no fs — pure Map-backed storage for synchronous round-trips.
   *
   * Seed entries are written as named files in the backing store before the
   * workspace is constructed. They do not populate the live event buffer.
   */
  static inMemory(seed: InMemoryWorkspaceSeed = {}): TaskWorkspace {
    const backing = new InMemoryBacking()
    for (const [name, content] of Object.entries(seed)) {
      backing.write(name, content)
    }
    return new TaskWorkspace(backing)
  }

  /** Construct a filesystem-backed TaskWorkspace for a directory created or owned by the caller. */
  static create(dir: string): TaskWorkspace {
    return new TaskWorkspace(new FsBacking(dir), dir)
  }

  /** Reconstruct a filesystem-backed TaskWorkspace over an existing directory for recovery. */
  static open(dir: string): TaskWorkspace {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`Task workspace does not exist: ${dir}`)
    }
    return new TaskWorkspace(new FsBacking(dir), dir)
  }

  // ── File operations ──

  writeTask(content: string): void {
    this.backing.write("task.md", content)
  }

  writeManifest(manifest: ManifestData): void {
    this.backing.write("manifest.json", JSON.stringify(manifest))
  }

  readTask(): string | null {
    return this.backing.read("task.md")
  }

  readManifest(): ManifestData | null {
    const raw = this.backing.read("manifest.json")
    return raw ? (JSON.parse(raw) as ManifestData) : null
  }

  writeOutput(content: string): void {
    this.backing.write("output.md", content)
  }

  readOutput(): string | null {
    return this.backing.read("output.md")
  }

  hasOutput(): boolean {
    return this.backing.exists("output.md")
  }

  /**
   * Return the wall-clock moment this run finished, read as `output.md` mtime.
   * Null when `hasOutput()` is false. Pairs with `hasOutput()` ("did it finish?")
   * to answer "when did it finish?" — the ordering signal for GC.
   */
  completedAt(): Date | null {
    return this.backing.mtime("output.md")
  }

  writeProcessInfo(info: Record<string, unknown>): void {
    this.backing.write("process.json", JSON.stringify(info))
  }

  readProcessInfo(): Record<string, unknown> | null {
    const raw = this.backing.read("process.json")
    if (!raw) return null
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      // Corrupted/truncated process.json (e.g. partial write from a crashed
      // process). Treat as missing so orphan recovery skips it gracefully
      // instead of crashing the spawner at startup.
      return null
    }
  }

  log(message: string): void {
    this.backing.append("run.log", message + "\n")
  }

  readLog(): string | null {
    return this.backing.read("run.log")
  }

  /** Append a raw line to events.jsonl (the NDJSON stream log). */
  appendRawLine(line: string): void {
    this.backing.append("events.jsonl", line + "\n")
  }

  readRawEvents(): string[] {
    const raw = this.backing.read("events.jsonl")
    return raw ? raw.split("\n").filter(Boolean) : []
  }

  appendEvent(event: ProgressEvent): void {
    // Durable log (or in-memory log, depending on backing)
    this.backing.append("progress.jsonl", JSON.stringify(event) + "\n")
    // In-memory buffer (always in-memory, powers tailEvents)
    this.eventBuffer.push(event)
    // Wake up live subscribers (no event value — they read from the buffer)
    for (const subscriber of this.eventSubscribers) {
      subscriber()
    }
  }

  /**
   * Return progress events for this run.
   *
   * **Happy path** (buffer non-empty): returns events appended by *this*
   * instance via `appendEvent` — no disk read.
   *
   * **Recovery path** (buffer empty, e.g. after `TaskWorkspace.open()`):
   * parses from the durable log on disk.
   *
   * @note In multi-instance scenarios, events written by a *different*
   * TaskWorkspace instance are invisible when this instance's buffer is
   * non-empty. To see all events after cross-instance writes, call
   * `readProgressEvents()` on a fresh instance (empty buffer → disk fallback).
   */
  readProgressEvents(): ProgressEvent[] {
    // Happy path: return from in-memory buffer (populated by appendEvent)
    if (this.eventBuffer.length > 0) return [...this.eventBuffer]

    // Recovery path: parse from durable log (e.g. after TaskWorkspace.open())
    const raw = this.backing.read("progress.jsonl")
    if (!raw) return []

    const lines = raw.split("\n").filter(Boolean)
    const events: ProgressEvent[] = []
    for (const line of lines) {
      const result = parseEventLine(line)
      if (result.ok) events.push(result.event)
    }
    return events
  }

  // ── Live channel ──

  /**
   * Async iterable that replays the buffered backlog, then yields new events
   * as they arrive via appendEvent. Abort with the signal to stop.
   */
  tailEvents(signal?: AbortSignal): AsyncIterable<ProgressEvent> {
    const buffer = this.eventBuffer
    const subscribers = this.eventSubscribers
    const abortSignal = signal

    return {
      [Symbol.asyncIterator]() {
        let index = 0
        let pendingResolve: ((value: IteratorResult<ProgressEvent>) => void) | null = null
        let active = true

        const onEvent = () => {
          if (pendingResolve) {
            const resolve = pendingResolve
            pendingResolve = null
            if (index < buffer.length) {
              resolve({ value: buffer[index++], done: false })
            } else if (!active) {
              resolve({ value: undefined as unknown as ProgressEvent, done: true })
            }
          }
        }

        if (abortSignal?.aborted) {
          active = false
        } else {
          subscribers.push(onEvent)
          abortSignal?.addEventListener("abort", () => {
            active = false
            const idx = subscribers.indexOf(onEvent)
            if (idx !== -1) subscribers.splice(idx, 1)
            if (pendingResolve) {
              const resolve = pendingResolve
              pendingResolve = null
              resolve({ value: undefined as unknown as ProgressEvent, done: true })
            }
          })
        }

        return {
          next(): Promise<IteratorResult<ProgressEvent>> {
            if (index < buffer.length) {
              return Promise.resolve({ value: buffer[index++], done: false })
            }
            if (!active) {
              return Promise.resolve({ value: undefined as unknown as ProgressEvent, done: true })
            }
            return new Promise(resolve => {
              if (index < buffer.length) {
                resolve({ value: buffer[index++], done: false })
              } else {
                pendingResolve = resolve
              }
            })
          },
          return(): Promise<IteratorResult<ProgressEvent>> {
            active = false
            const idx = subscribers.indexOf(onEvent)
            if (idx !== -1) subscribers.splice(idx, 1)
            return Promise.resolve({ value: undefined as unknown as ProgressEvent, done: true })
          },
        }
      },
    }
  }
}
