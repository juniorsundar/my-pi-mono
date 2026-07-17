/**
 * btw — Spinning List Widget tests.
 *
 * Tests verify the rendered output of SpinningListComponent given controlled
 * registry states.  The component is an opaque text renderer — we test what
 * render(width) returns, not how it builds lines internally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BtwRegistry, RunningEntry, CompletedEntry } from "./registry.js";
import { createRegistry } from "./registry.js";
import { SpinningListComponent, SPINNER_FRAMES } from "./spinning-list.js";

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockRegistry(
  running: RunningEntry[] = [],
  completed: CompletedEntry[] = [],
): BtwRegistry {
  return {
    addRunning: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    getRunning: () => running,
    getCompleted: () => completed,
    getCompletedCount: () => completed.length,
    killAll: vi.fn(),
    clear: vi.fn(),
  };
}

function createMockTui(rows = 24) {
  return {
    requestRender: vi.fn(),
    terminal: { rows },
  };
}

// ── Slice 2: Empty state — no running entries ─────────────────────

describe("Slice 2: Empty state — no running BTW entries", () => {
  it("render(width) returns empty array when no running entries", () => {
    const registry = createMockRegistry([], []);
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    expect(component.render(80)).toEqual([]);
  });

  it("render(width) returns empty array when running list is empty but completed has entries", () => {
    const registry = createMockRegistry(
      [],
      [{ id: "btw-1", query: "Old Q?", result: { type: "success", text: "42" }, completedAt: new Date() }],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    // The spinning list only shows RUNNING entries; completed alone → no widget
    expect(component.render(80)).toEqual([]);
  });
});

// ── Slice 6: Update on registry change ─────────────────────────

describe("Slice 6: Spinning List reflects registry changes", () => {
  it("completing a running entry removes it from the next render", () => {
    const registry = createRegistry();
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    registry.addRunning("btw-1", "First Q", { pid: 1, kill: () => {} } as any);
    registry.addRunning("btw-2", "Second Q", { pid: 2, kill: () => {} } as any);

    const before = component.render(80);
    expect(before).toHaveLength(3); // header + 2 items

    registry.complete("btw-1", { type: "success", text: "Answer" });

    const after = component.render(80);
    expect(after).toHaveLength(2); // header + 1 remaining item
    expect(after[1]).toContain("Second Q");
    expect(after[1]).not.toContain("First Q");
  });

  it("failing a running entry removes it from the next render", () => {
    const registry = createRegistry();
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any);
    registry.addRunning("btw-2", "Q2", { pid: 2, kill: () => {} } as any);

    registry.fail("btw-1", "Error");

    const after = component.render(80);
    expect(after).toHaveLength(2);
    expect(after[1]).toContain("Q2");
  });

  it("clearing the registry returns empty render", () => {
    const registry = createRegistry();
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any);
    expect(component.render(80).length).toBeGreaterThan(0);

    registry.clear();

    expect(component.render(80)).toEqual([]);
  });

  it("completing only the last running entry results in empty render", () => {
    const registry = createRegistry();
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    registry.addRunning("btw-1", "Only Q", { pid: 1, kill: () => {} } as any);
    registry.complete("btw-1", { type: "success", text: "Answer" });

    expect(component.render(80)).toEqual([]);
  });

  it("adding a new running entry after completion appears in render", () => {
    const registry = createRegistry();
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    registry.addRunning("btw-1", "First", { pid: 1, kill: () => {} } as any);
    registry.complete("btw-1", { type: "success", text: "A" });
    registry.addRunning("btw-2", "Second", { pid: 2, kill: () => {} } as any);

    const lines = component.render(80);
    expect(lines).toHaveLength(2); // header + 1 running
    expect(lines[0]).toBe("○ btw (1/2)");
    expect(lines[1]).toContain("Second");
  });
});

// ── Slice 5: Text truncation ─────────────────────────────────────

describe("Slice 5: Long question text is truncated", () => {
  const LONG_QUERY = "What is the capital of France and what is its population density and what are the best museums to visit there?";

  it("render(width) truncates question text that exceeds available space", () => {
    const registry = createMockRegistry(
      [{ id: "btw-1", query: LONG_QUERY, childProcess: {} as any, startedAt: new Date() }],
      [],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    // Narrow width so text must be truncated
    const lines = component.render(30);
    const itemLine = lines[1];

    // Line should not contain the full query
    expect(itemLine).not.toContain(LONG_QUERY);
    // Line should be shorter than the full query
    expect(itemLine.length).toBeLessThan(LONG_QUERY.length);
  });

  it("short question text is not truncated", () => {
    const registry = createMockRegistry(
      [{ id: "btw-1", query: "Short Q?", childProcess: {} as any, startedAt: new Date() }],
      [],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);
    const itemLine = lines[1];

    expect(itemLine).toContain("Short Q?");
  });
});

// ── Slice 4: Progress count in header ────────────────────────────

describe("Slice 4: Header shows BTW progress count", () => {
  it("header shows 0 completed when no entries have finished", () => {
    const registry = createMockRegistry(
      [{ id: "btw-1", query: "Q?", childProcess: {} as any, startedAt: new Date() }],
      [],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);
    expect(lines[0]).toBe("○ btw (0/1)");
  });

  it("header shows completed/total ratio when some have finished", () => {
    const registry = createMockRegistry(
      [
        { id: "btw-3", query: "Still running 1?", childProcess: {} as any, startedAt: new Date() },
        { id: "btw-4", query: "Still running 2?", childProcess: {} as any, startedAt: new Date() },
      ],
      [
        { id: "btw-1", query: "Done Q1", result: { type: "success", text: "42" }, completedAt: new Date() },
        { id: "btw-2", query: "Done Q2", result: { type: "success", text: "hello" }, completedAt: new Date() },
        { id: "btw-5", query: "Done Q3", result: { type: "error", error: "fail" }, completedAt: new Date() },
      ],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);
    // 3 completed + 2 running = 5 total
    expect(lines[0]).toBe("○ btw (3/5)");
    // Only running entries are shown as items
    expect(lines).toHaveLength(3); // header + 2 running items
  });

  it("header uses the count from getCompleted() which returns newest-first", () => {
    // getCompleted() returns newest-first, but we only need the count
    const registry = createMockRegistry(
      [{ id: "btw-3", query: "Still running?", childProcess: {} as any, startedAt: new Date() }],
      [
        { id: "btw-2", query: "Done last", result: { type: "success", text: "B" }, completedAt: new Date() },
        { id: "btw-1", query: "Done first", result: { type: "success", text: "A" }, completedAt: new Date() },
      ],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);
    // .length works regardless of order
    expect(lines[0]).toBe("○ btw (2/3)");
  });
});

// ── Slice 3: Multiple running entries ────────────────────────────

describe("Slice 3: Multiple running BTW entries", () => {
  const THREE_ENTRIES: RunningEntry[] = [
    { id: "btw-1", query: "First query", childProcess: {} as any, startedAt: new Date() },
    { id: "btw-2", query: "Second query", childProcess: {} as any, startedAt: new Date() },
    { id: "btw-3", query: "Third query", childProcess: {} as any, startedAt: new Date() },
  ];

  it("render(width) produces one spinner line per running entry", () => {
    const registry = createMockRegistry(THREE_ENTRIES, []);
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);

    // Header + 3 items = 4 lines
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("○ btw");
    expect(lines[1]).toContain("First query");
    expect(lines[2]).toContain("Second query");
    expect(lines[3]).toContain("Third query");
  });

  it("uses ├─ for non-last items and └─ for the last item", () => {
    const registry = createMockRegistry(THREE_ENTRIES, []);
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);

    expect(lines[1].trimStart()).toMatch(/^├─ /);
    expect(lines[2].trimStart()).toMatch(/^├─ /);
    expect(lines[3].trimStart()).toMatch(/^└─ /);
  });

  it("each spinner line includes a spinner frame character", () => {
    const registry = createMockRegistry(THREE_ENTRIES, []);
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);

    // Every item line (indices 1,2,3) should contain a spinner frame
    for (let i = 1; i < lines.length; i++) {
      expect(SPINNER_FRAMES.some((f) => lines[i].includes(f))).toBe(true);
    }
  });
});

// ── Slice 1: Tracer Bullet — one running entry ──────────────────────

describe("Slice 1: Tracer bullet — one running BTW entry", () => {
  it("render(width) includes header with correct progress count", () => {
    const registry = createMockRegistry(
      [{ id: "btw-1", query: "What is the capital of France?", childProcess: {} as any, startedAt: new Date() }],
      [],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("○ btw");
    expect(lines[0]).toContain("(0/1)");
  });

  it("render(width) includes one spinner line with the question text", () => {
    const registry = createMockRegistry(
      [{ id: "btw-1", query: "What is the capital of France?", childProcess: {} as any, startedAt: new Date() }],
      [],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);

    // Expect a line with tree connector + spinner frame + question text
    const questionLine = lines.find((l) => l.includes("What is the capital of France?"));
    expect(questionLine).toBeDefined();
    expect(questionLine).toMatch(/[├└]─/); // tree connector
    // Should contain one of the spinner frames
    expect(SPINNER_FRAMES.some((f) => questionLine!.includes(f))).toBe(true);
  });

  it("render(width) uses a single-entry tree connector (└─)", () => {
    const registry = createMockRegistry(
      [{ id: "btw-1", query: "Hi?", childProcess: {} as any, startedAt: new Date() }],
      [],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);

    const questionLine = lines.find((l) => l.includes("Hi?"))!;
    expect(questionLine.trimStart()).toMatch(/^└─ /);
  });

  it("render(width) returns non-empty array when entries exist", () => {
    const registry = createMockRegistry(
      [{ id: "btw-1", query: "Q?", childProcess: {} as any, startedAt: new Date() }],
      [],
    );
    const tui = createMockTui();
    const component = new SpinningListComponent(registry, tui);

    const lines = component.render(80);

    expect(lines.length).toBeGreaterThan(0);
  });
});
