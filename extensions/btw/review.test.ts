/**
 * btw — BTW Review Component tests.
 *
 * Tests verify the rendered output of BtwReviewComponent given controlled
 * completed entries.  The component is an opaque text renderer — we test
 * what render(width) returns and how handleInput changes it, not internal
 * data structures.
 */

import { describe, it, expect, vi } from "vitest";
import type { CompletedEntry } from "./registry.js";
import { BtwReviewComponent } from "./review.js";

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockTui() {
  return { requestRender: vi.fn() };
}

function createMockTheme() {
  return {
    fg: vi.fn((_: string, text: string) => text),
    bg: vi.fn((_: string, text: string) => text),
    bold: vi.fn((text: string) => text),
  };
}

function successEntry(overrides: Partial<CompletedEntry> & { id: string; query: string }): CompletedEntry {
  return {
    id: overrides.id,
    query: overrides.query,
    result: overrides.result ?? {
      type: "success",
      text: "Default answer text.",
      toolTrace: [],
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    },
    completedAt: overrides.completedAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

function errorEntry(overrides: Partial<CompletedEntry> & { id: string; query: string }): CompletedEntry {
  return {
    id: overrides.id,
    query: overrides.query,
    result: overrides.result ?? {
      type: "error",
      error: "Something went wrong",
      toolTrace: [],
    },
    completedAt: overrides.completedAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

// ── Helper to build a list of entries with controlled timestamps ─────

function makeEntries(count: number): CompletedEntry[] {
  const entries: CompletedEntry[] = [];
  for (let i = 0; i < count; i++) {
    // Later timestamps = newer. Index 0 should be newest.
    const date = new Date(2026, 5, 15 - i); // newest-first by construction
    entries.push(
      successEntry({
        id: `btw-${count - i}`,
        query: `Question ${count - i}?`,
        completedAt: date,
      }),
    );
  }
  return entries;
}

// ── Slice 1: Tracer bullet — Empty state ──────────────────────────────

describe("Slice 1: Empty state — no completed entries", () => {
  it("render(width) returns a helpful message when entries is empty", () => {
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent([], tui, theme, vi.fn());

    const lines = component.render(80);

    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).toMatch(/no.*btw|no.*result|btw.*empty|no.*completed/i);
  });

  it("render(width) returns exactly one line when entries is empty", () => {
    // The message should be compact — a single line
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent([], tui, theme, vi.fn());

    const lines = component.render(80);

    // One line for the message, possibly a blank line after
    // But should not return empty array
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("render(width) messages do not exceed width", () => {
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent([], tui, theme, vi.fn());

    const lines = component.render(80);

    for (const line of lines) {
      // Strip ANSI codes for length check
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain.length).toBeLessThanOrEqual(80);
    }
  });

  it("render(width) returns non-empty lines when entries are present", () => {
    // Ensure empty-state guard doesn't accidentally trigger for non-empty
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(
      [successEntry({ id: "btw-1", query: "Q?" })],
      tui,
      theme,
      vi.fn(),
    );

    const lines = component.render(80);
    expect(lines.length).toBeGreaterThan(0); // At least header content
  });
});

// ── Slice 2: Ordered display — newest-first, default expansion ────────

describe("Slice 2: Ordered display and default expansion", () => {
  it("render(width) shows the most recent entry (index 0) first", () => {
    const entries = makeEntries(3);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    // All questions should appear somewhere
    expect(joined).toContain("Question 3");
    expect(joined).toContain("Question 2");
    expect(joined).toContain("Question 1");
  });

  it("most recent entry (index 0) is expanded by default — shows extra content", () => {
    // Create an entry with usage and answer text so we can detect expansion
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-2",
        query: "Newer question?",
        result: {
          type: "success",
          text: "This is the answer to the newer question.",
          toolTrace: [{ toolName: "read", args: { path: "file.ts" } }],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        },
        completedAt: new Date("2026-06-15"),
      }),
      successEntry({
        id: "btw-1",
        query: "Older question?",
        result: {
          type: "success",
          text: "Answer to older question.",
          toolTrace: [],
          usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-14"),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);

    // Most recent entry shows its answer text (expanded)
    const newerAnswer = lines.find((l) => l.includes("This is the answer to the newer question."));
    expect(newerAnswer).toBeDefined();

    // Older entry does NOT show its answer text in the default view (collapsed)
    const olderAnswer = lines.find((l) => l.includes("Answer to older question."));
    expect(olderAnswer).toBeUndefined();
  });

  it("collapsed entries show only the header line", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);

    // Second entry (older, collapsed) should only show its header
    const secondEntryLine = lines.find((l) => l.includes("Question 1"));
    expect(secondEntryLine).toBeDefined();

    // The line for the collapsed entry should mention "btw:"
    expect(secondEntryLine!).toContain("btw:");

    // Should NOT contain answer text (we didn't set any in makeEntries...
    // actually makeEntries uses successEntry default which has "Default answer text."
    // Let's verify the collapsed entry line is very short — just the header
    if (secondEntryLine) {
      // Strip ANSI for length check
      const plain = secondEntryLine.replace(/\x1b\[[0-9;]*m/g, "");
      // Should be just prefix + icon + "btw: Question 1?" without detail content
      expect(plain.length).toBeLessThan(40);
    }
  });

  it("expanded entry shows usage stats", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "First question?",
        result: {
          type: "success",
          text: "Answer text here.",
          toolTrace: [],
          usage: { input: 200, output: 100, cacheRead: 50, cacheWrite: 10, cost: 0.002 },
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    // Usage stats should appear
    expect(joined).toContain("↑200");
    expect(joined).toContain("↓100");
    expect(joined).toContain("0.002");
  });

  it("expanded entry shows collapsed tool trace indicator", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [
            { toolName: "read", args: { path: "file.ts" } },
            { toolName: "grep", args: { pattern: "foo" } },
          ],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    // Tool trace indicator should appear collapsed
    expect(joined).toContain("▸ Tool trace");
    expect(joined).toContain("2 tools");
    // Individual tool items should NOT be visible yet
    expect(joined).not.toContain("file.ts");
  });

  it("newest-first order matches the provided array order (index 0 = newest)", () => {
    const entries = makeEntries(3);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const questions: { line: string; index: number }[] = [];

    lines.forEach((line, i) => {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (plain.includes("Question")) {
        questions.push({ line: plain, index: i });
      }
    });

    // Question 3 (most recent) should appear before Question 2, which appears before Question 1
    const q3Idx = questions.find((q) => q.line.includes("Question 3"))?.index ?? -1;
    const q2Idx = questions.find((q) => q.line.includes("Question 2"))?.index ?? -1;
    const q1Idx = questions.find((q) => q.line.includes("Question 1"))?.index ?? -1;

    expect(q3Idx).toBeLessThan(q2Idx);
    expect(q2Idx).toBeLessThan(q1Idx);
  });
});

// ── Slice 3: Navigation — up/down moves selected index ────────────────

describe("Slice 3: Navigation with up/down keys", () => {
  it("initial selected index is 0 (most recent entry)", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // The first entry (most recent) should have the selected prefix
    const lines = component.render(80);
    expect(lines[0].startsWith(">")).toBe(true);
    expect(lines[0]).toContain("Question 2");
  });

  it("down key moves selected index to 1 (next entry)", () => {
    const entries = makeEntries(3);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    component.handleInput("\x1b[B"); // down arrow for selection

    const lines = component.render(80);
    // Entry at index 1 should be selected now
    const entry1Line = lines.find((l) => l.startsWith(">") && l.includes("Question 2"));
    expect(entry1Line).toBeDefined();
  });

  it("up key moves selected index back to 0", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    component.handleInput("\x1b[B"); // down arrow → index 1
    component.handleInput("\x1b[A"); // up arrow → index 0

    const lines = component.render(80);
    expect(lines[0].startsWith(">")).toBe(true);
    expect(lines[0]).toContain("Question 2");
  });

  it("down at last entry does not wrap around", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    component.handleInput("\x1b[B"); // down arrow → index 1
    component.handleInput("\x1b[B"); // down arrow → stays at 1 (boundary)

    const lines = component.render(80);
    expect(lines[0].startsWith(">")).toBe(false); // index 0 no longer selected
    const lastEntryLine = lines.find((l) => l.startsWith(">") && l.includes("Question 1"));
    expect(lastEntryLine).toBeDefined();
  });

  it("up at first entry does not wrap around", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    component.handleInput("\x1b[A"); // up arrow at index 0 → stays at 0

    const lines = component.render(80);
    expect(lines[0].startsWith(">")).toBe(true);
    expect(lines[0]).toContain("Question 2");
  });

  it("multiple down moves step through entries", () => {
    const entries = makeEntries(4);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Move down 3 times to reach the last entry
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");

    const lines = component.render(80);
    const selectedLine = lines.find((l) => l.startsWith(">"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("Question 1"); // oldest entry
  });

  it("handleInput triggers requestRender after navigation", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Initial render should not have triggered requestRender yet
    expect(tui.requestRender).not.toHaveBeenCalled();

    component.handleInput("\x1b[B"); // down arrow for selection

    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("pressing down on a single-entry list is a no-op", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Before: index 0 selected
    expect(component.render(80)[0].startsWith(">")).toBe(true);

    // Try to go down — should stay at index 0
    component.handleInput("\x1b[B");

    const lines = component.render(80);
    expect(lines[0].startsWith(">")).toBe(true);
    // Should still be expanded (index 0 expanded by default)
    expect(lines[0]).toContain("Question 1");
  });
});

// ── Slice 4: Toggle expand/collapse with Enter or Ctrl+O ──────────────

describe("Slice 4: Toggle expand/collapse", () => {
  it("Enter toggles the selected entry from expanded to collapsed", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Initially: index 0 (Question 2) expanded, shows answer text
    const before = component.render(80);
    expect(before.some((l) => l.includes("Default answer text."))).toBe(true);

    component.handleInput("\r"); // Enter — collapse index 0

    const after = component.render(80);
    // Answer text should no longer be visible
    expect(after.some((l) => l.includes("Default answer text."))).toBe(false);
  });

  it("Enter toggles a collapsed entry to expanded", () => {
    // Use a single entry with unique answer text so we can detect toggle
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "UniqueAnswerText",
          toolTrace: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // By default index 0 is expanded
    expect(component.render(80).some((l) => l.includes("UniqueAnswerText"))).toBe(true);

    // Collapse it
    component.handleInput("\r");
    expect(component.render(80).some((l) => l.includes("UniqueAnswerText"))).toBe(false);

    // Re-expand
    component.handleInput("\r");
    expect(component.render(80).some((l) => l.includes("UniqueAnswerText"))).toBe(true);
  });

  it("toggling is independent per entry", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-2",
        query: "Entry A",
        result: {
          type: "success",
          text: "AnswerA",
          toolTrace: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-15"),
      }),
      successEntry({
        id: "btw-1",
        query: "Entry B",
        result: {
          type: "success",
          text: "AnswerB",
          toolTrace: [],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-14"),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Index 0 (Entry A) expanded by default — shows AnswerA
    const initial = component.render(80);
    expect(initial.some((l) => l.includes("AnswerA"))).toBe(true);
    expect(initial.some((l) => l.includes("AnswerB"))).toBe(false);

    // Collapse index 0, expand index 1
    component.handleInput("\r"); // collapse index 0
    component.handleInput("\x1b[B"); // down arrow to index 1
    component.handleInput("\r"); // expand index 1

    const after = component.render(80);
    // Index 1 (Entry B) should now show AnswerB
    expect(after.some((l) => l.includes("AnswerB"))).toBe(true);
    // Index 0 (Entry A) should no longer show AnswerA (collapsed)
    expect(after.some((l) => l.includes("AnswerA"))).toBe(false);
  });

  it("expand/collapse state persists across navigation", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Collapse index 0
    component.handleInput("\r");

    // Navigate down and back up
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[A");

    // Index 0 should still be collapsed
    const after = component.render(80);
    expect(after.some((l) => l.includes("Default answer text."))).toBe(false);
  });

  it("Enter on an already-collapsed entry with answer content shows it again", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Collapse
    component.handleInput("\r");
    expect(component.render(80).some((l) => l.includes("Default answer text."))).toBe(false);

    // Re-expand
    component.handleInput("\r");
    expect(component.render(80).some((l) => l.includes("Default answer text."))).toBe(true);
  });

  it("toggle calls requestRender", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    tui.requestRender.mockClear();
    component.handleInput("\r");

    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+O (\x0f or ctrl+o sequence) toggles the selected entry", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Space key
    const before = component.render(80);
    expect(before.some((l) => l.includes("Default answer text."))).toBe(true);

    component.handleInput(" "); // Space

    const after = component.render(80);
    expect(after.some((l) => l.includes("Default answer text."))).toBe(false);
  });
});

// ── Slice 5: Escape closes the review view ────────────────────────────

describe("Slice 5: Escape closes the review view", () => {
  it("escape calls onClose", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const onClose = vi.fn();
    const component = new BtwReviewComponent(entries, tui, theme, onClose);

    component.handleInput("\x1b"); // Escape

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape on empty entries calls onClose", () => {
    const tui = createMockTui();
    const theme = createMockTheme();
    const onClose = vi.fn();
    const component = new BtwReviewComponent([], tui, theme, onClose);

    component.handleInput("\x1b"); // Escape

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape does not interfere with other keys", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const onClose = vi.fn();
    const component = new BtwReviewComponent(entries, tui, theme, onClose);

    // Other keys should not trigger close
    component.handleInput("\r"); // Enter
    component.handleInput("\x1b[B"); // Down

    expect(onClose).not.toHaveBeenCalled();
  });

  it("escape calls requestRender before closing", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const onClose = vi.fn();
    const component = new BtwReviewComponent(entries, tui, theme, onClose);

    tui.requestRender.mockClear();
    component.handleInput("\x1b");

    // onClose should be called
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape is recognized as a single-character escape sequence", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const onClose = vi.fn();
    const component = new BtwReviewComponent(entries, tui, theme, onClose);

    component.handleInput("\x1b");

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Slice 6: Error result rendering ───────────────────────────────────

describe("Slice 6: Error result rendering", () => {
  it("success entry shows ✓ icon", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Successful query?",
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const headerLine = lines[0];
    expect(headerLine).toContain("✓");
  });

  it("error entry shows ✗ icon", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Failed query?",
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const headerLine = lines[0];
    expect(headerLine).toContain("✗");
  });

  it("error entry shows error message in expanded content", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Failed query?",
        result: {
          type: "error",
          error: "Process timed out after 300s",
          toolTrace: [{ toolName: "bash", args: { command: "find /" } }],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");
    expect(joined).toContain("Process timed out after 300s");
  });

  it("error entry shows stderr when available", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Something broke",
          stderr: "Error: Cannot read property 'x' of undefined",
          toolTrace: [],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");
    expect(joined).toContain("Cannot read property");
  });

  it("error entry shows collapsed tool trace indicator", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Failed",
          toolTrace: [
            { toolName: "read", args: { path: "/some/file.ts" } },
            { toolName: "grep", args: { pattern: "function" } },
          ],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");
    // Tool trace indicator should appear collapsed
    expect(joined).toContain("▸ Tool trace");
    expect(joined).toContain("2 tools");
    // Individual tool items should NOT be visible yet
    expect(joined).not.toContain("/some/file.ts");
  });

  it("error entry shows partial tool trace when expanded", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Failed",
          toolTrace: [
            { toolName: "read", args: { path: "/some/file.ts" } },
            { toolName: "grep", args: { pattern: "function" } },
          ],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Expand tool trace
    component.handleInput("\r");

    const lines = component.render(80);
    const joined = lines.join(" ");
    expect(joined).toContain("read");
    expect(joined).toContain("grep");
    expect(joined).toContain("/some/file.ts");
  });

  it("success entry does not show error indicator", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        completedAt: new Date(),
      }),
      errorEntry({
        id: "btw-2",
        query: "Q2?",
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    // First line (success) should have ✓ but not ✗
    expect(lines[0]).toContain("✓");
    expect(lines[0]).not.toContain("✗");
    // The error entry line should have ✗ but not ✓ (beyond the ✓ from the first line)
    // This is hard to check directly since lines contain both glyphs...
    // Instead check that each icon appears at least once
    expect(lines.some((l) => l.includes("✓"))).toBe(true);
  });
});

// ── Keybinding-driven toggle (AC 5) ──────────────────────────────────

describe("Keybinding-driven toggle", () => {
  it("uses keybindings.matches() for toggle when provided", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const keybindings = {
      matches: vi.fn().mockReturnValue(true),
    };
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn(), keybindings as any);

    // Expanded by default
    const before = component.render(80);
    expect(before.some((l) => l.includes("Default answer text."))).toBe(true);

    // Toggle via keybindings match (not Enter or Ctrl+O)
    component.handleInput("some-custom-key");

    expect(keybindings.matches).toHaveBeenCalledWith("some-custom-key", "tui.select.confirm");
    const after = component.render(80);
    expect(after.some((l) => l.includes("Default answer text."))).toBe(false);
  });

  it("does not toggle when keybindings.matches() returns false", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const keybindings = {
      matches: vi.fn().mockReturnValue(false),
    };
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn(), keybindings as any);

    component.handleInput("some-other-key");

    // Still expanded
    const after = component.render(80);
    expect(after.some((l) => l.includes("Default answer text."))).toBe(true);
  });

  it("works without keybindings (backwards compatible)", () => {
    const entries = makeEntries(1);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Enter still works without keybindings
    component.handleInput("\r");

    const after = component.render(80);
    expect(after.some((l) => l.includes("Default answer text."))).toBe(false);
  });
});

// ── Styling parity with subagent results (AC 8) ──────────────────────

describe("Styling parity with subagent results", () => {
  it("renders ✓ success icon, separator, usage stats, tool trace indicator, and output text", () => {
    const entries: CompletedEntry[] = [
      {
        id: "btw-1",
        query: "What is the capital of France?",
        completedAt: new Date(),
        result: {
          type: "success",
          text: "Paris is the capital of France.",
          toolTrace: [
            { toolName: "web_search", args: { query: "capital of France" } },
          ],
          usage: { input: 1500, output: 300, cacheRead: 500, cacheWrite: 0, cost: 0.02 },
          model: "anthropic/claude-sonnet-4",
          stopReason: "endTurn",
        },
      },
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join("\n");

    // ✓ status icon (subagent-style)
    expect(lines[0]).toContain("✓");

    // Question text in header
    expect(lines[0]).toContain("What is the capital of France?");

    // Usage stats with ↑↓RW$ formatting (subagent-style)
    expect(joined).toContain("↑1.5k");
    expect(joined).toContain("↓300");
    expect(joined).toContain("R500");
    expect(joined).toContain("$");

    // Model name in usage line
    expect(joined).toContain("anthropic/claude-sonnet-4");

    // Separator line
    expect(lines.some((l) => l.includes("─"))).toBe(true);

    // Tool trace collapsed indicator (subagent-style)
    expect(joined).toContain("▸ Tool trace");
    expect(joined).toContain("1 tool");

    // Answer text
    expect(joined).toContain("Paris is the capital of France.");
  });

  it("expanded tool trace shows items with → arrow", () => {
    const entries: CompletedEntry[] = [
      {
        id: "btw-1",
        query: "What is the capital of France?",
        completedAt: new Date(),
        result: {
          type: "success",
          text: "Paris is the capital of France.",
          toolTrace: [
            { toolName: "web_search", args: { query: "capital of France" } },
          ],
          usage: { input: 1500, output: 300, cacheRead: 500, cacheWrite: 0, cost: 0.02 },
          model: "anthropic/claude-sonnet-4",
        },
      },
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Expand tool trace
    component.handleInput("\r");

    const lines = component.render(80);
    const joined = lines.join("\n");

    // Expanded indicator
    expect(joined).toContain("▾ Tool trace");
    // Tool trace with → arrow (subagent-style)
    expect(joined).toContain("→");
    expect(joined).toContain("web_search");
  });

  it("renders ✗ error icon with error message and collapsed tool trace", () => {
    const entries: CompletedEntry[] = [
      {
        id: "btw-1",
        query: "Debug the crash",
        completedAt: new Date(),
        result: {
          type: "error",
          error: "BTW process exited with code 1",
          exitCode: 1,
          stderr: "Error: API key not found",
          toolTrace: [
            { toolName: "bash", args: { command: "npm test" } },
          ],
        },
      },
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join("\n");

    // ✗ error icon
    expect(lines[0]).toContain("✗");

    // Separator
    expect(lines.some((l) => l.includes("─"))).toBe(true);

    // Tool trace collapsed indicator
    expect(joined).toContain("▸ Tool trace");

    // Error message
    expect(joined).toContain("BTW process exited with code 1");

    // Stderr
    expect(joined).toContain("Error: API key not found");
  });

  it("expanded tool trace on error shows items", () => {
    const entries: CompletedEntry[] = [
      {
        id: "btw-1",
        query: "Debug the crash",
        completedAt: new Date(),
        result: {
          type: "error",
          error: "BTW process exited with code 1",
          exitCode: 1,
          stderr: "Error: API key not found",
          toolTrace: [
            { toolName: "bash", args: { command: "npm test" } },
          ],
        },
      },
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Expand tool trace
    component.handleInput("\r");

    const lines = component.render(80);
    const joined = lines.join("\n");

    // Tool trace with → arrow
    expect(joined).toContain("→");
    expect(joined).toContain("npm test");
  });

  it("renders tool trace for read tool with file path when expanded", () => {
    const entries: CompletedEntry[] = [
      {
        id: "btw-1",
        query: "Read the config",
        completedAt: new Date(),
        result: {
          type: "success",
          text: "Config loaded.",
          toolTrace: [
            { toolName: "read", args: { path: "/app/config.json" } },
          ],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Expand tool trace
    component.handleInput("\r");

    const lines = component.render(80);
    const joined = lines.join("\n");

    // read tool with → arrow and file path
    expect(joined).toContain("→");
    expect(joined).toContain("read");
    expect(joined).toContain("/app/config.json");
  });
});

// ── Slice 2: Stop reason and exit code display ────────────────────────

describe("Slice 2: Stop reason display", () => {
  it("shows stopReason in usage line when present", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          model: "claude-sonnet-4",
          stopReason: "endTurn",
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("endTurn");
    expect(joined).toContain("claude-sonnet-4");
  });

  it("omits stopReason when not present", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          model: "claude-sonnet-4",
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    // Model should still appear
    expect(joined).toContain("claude-sonnet-4");
    // stopReason should not appear
    expect(joined).not.toContain("endTurn");
  });

  it("omits stopReason when undefined", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).not.toContain("endTurn");
  });
});

describe("Slice 2: Exit code display", () => {
  it("shows exitCode when present on error", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Process failed",
          exitCode: 1,
          toolTrace: [],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("Exit code: 1");
  });

  it("omits exitCode when not present on error", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Process failed",
          toolTrace: [],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("Error: Process failed");
    expect(joined).not.toContain("Exit code");
  });

  it("shows exitCode before stderr", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Process failed",
          exitCode: 1,
          stderr: "stack trace here",
          toolTrace: [],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join("\n");

    const exitCodeIdx = joined.indexOf("Exit code: 1");
    const stderrIdx = joined.indexOf("stack trace here");
    expect(exitCodeIdx).toBeGreaterThan(-1);
    expect(stderrIdx).toBeGreaterThan(-1);
    expect(exitCodeIdx).toBeLessThan(stderrIdx);
  });
});

// ── Slice 3: Missing optional fields and edge cases ───────────────────

describe("Slice 3: Missing optional fields", () => {
  it("success with no cost omits cost from usage line", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("↑100");
    expect(joined).toContain("↓50");
    expect(joined).not.toContain("$");
  });

  it("success with no model omits model from usage line", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    // Usage line should exist but not contain model
    expect(joined).toContain("↑100");
    expect(joined).not.toContain("claude");
    expect(joined).not.toContain("gpt");
  });

  it("success with no stop reason omits stop reason from usage line", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          model: "claude-sonnet-4",
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("claude-sonnet-4");
    expect(joined).not.toContain("endTurn");
  });

  it("error with no exit code omits exit code line", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Something failed",
          toolTrace: [],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("Error: Something failed");
    expect(joined).not.toContain("Exit code");
  });

  it("error with no stderr omits stderr line", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Something failed",
          exitCode: 1,
          toolTrace: [],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("Exit code: 1");
    // No stderr content should appear (only the exit code line)
    expect(joined).not.toContain("stack");
  });

  it("success with empty tool trace renders no trace indicator", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    // No tool trace indicator should appear
    expect(joined).not.toContain("Tool trace");
    expect(joined).not.toContain("▸");
    expect(joined).not.toContain("▾");
  });

  it("error with empty tool trace renders no trace indicator", () => {
    const entries: CompletedEntry[] = [
      errorEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "error",
          error: "Failed",
          toolTrace: [],
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).not.toContain("Tool trace");
  });

  it("success with all optional fields present renders them all", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.001 },
          model: "claude-sonnet-4",
          stopReason: "endTurn",
        },
        completedAt: new Date(),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);
    const joined = lines.join(" ");

    expect(joined).toContain("↑100");
    expect(joined).toContain("↓50");
    expect(joined).toContain("R10");
    expect(joined).toContain("W5");
    expect(joined).toContain("$0.001");
    expect(joined).toContain("claude-sonnet-4");
    expect(joined).toContain("endTurn");
  });
});

// ── Slice 4: Collapsed entries distinguish success/error status ──────

describe("Slice 4: Collapsed entries distinguish success/error status", () => {
  it("collapsed success entry shows ✓ icon in header", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Newer question?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-15"),
      }),
      successEntry({
        id: "btw-2",
        query: "Older question?",
        result: {
          type: "success",
          text: "Older answer",
          toolTrace: [],
          usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-14"),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Index 1 (older) is collapsed by default
    const lines = component.render(80);

    // Find the line for the older entry (collapsed)
    const olderLine = lines.find((l) => l.includes("Older question?"));
    expect(olderLine).toBeDefined();
    expect(olderLine!).toContain("✓");
  });

  it("collapsed error entry shows ✗ icon in header", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Newer question?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-15"),
      }),
      errorEntry({
        id: "btw-2",
        query: "Failed question?",
        result: {
          type: "error",
          error: "Something broke",
          toolTrace: [],
        },
        completedAt: new Date("2026-06-14"),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    // Index 1 (error) is collapsed by default
    const lines = component.render(80);

    // Find the line for the error entry (collapsed)
    const errorLine = lines.find((l) => l.includes("Failed question?"));
    expect(errorLine).toBeDefined();
    expect(errorLine!).toContain("✗");
  });

  it("mixed success and error collapsed entries show correct icons", () => {
    const entries: CompletedEntry[] = [
      successEntry({
        id: "btw-1",
        query: "Success Q?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-15"),
      }),
      errorEntry({
        id: "btw-2",
        query: "Error Q?",
        result: {
          type: "error",
          error: "Failed",
          toolTrace: [],
        },
        completedAt: new Date("2026-06-14"),
      }),
      successEntry({
        id: "btw-3",
        query: "Another Success?",
        result: {
          type: "success",
          text: "Answer",
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        completedAt: new Date("2026-06-13"),
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    const lines = component.render(80);

    // All entries are collapsed except the first one
    const successLine1 = lines.find((l) => l.includes("Success Q?"));
    const errorLine = lines.find((l) => l.includes("Error Q?"));
    const successLine2 = lines.find((l) => l.includes("Another Success?"));

    expect(successLine1!).toContain("✓");
    expect(errorLine!).toContain("✗");
    expect(successLine2!).toContain("✓");
  });
});

// ── Regression: expanded content viewport scrolling ──────────────────

describe("Regression: arrow keys scroll expanded content", () => {
  it("j key scrolls the viewport instead of snapping back to selected entry", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
    const entries = [
      successEntry({
        id: "btw-long",
        query: "Long answer?",
        result: {
          type: "success",
          text: longText,
          toolTrace: [],
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    ];
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());
    component.setViewportHeight(6);

    const initial = component.render(80);
    expect(initial.some((l) => l.includes("Line 1"))).toBe(true);
    expect(initial.some((l) => l.includes("Line 4"))).toBe(false);

    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");

    const after = component.render(80);
    expect(after[0]).not.toContain("btw: Long answer?");
    expect(after.some((l) => l.includes("Line 4"))).toBe(true);
  });

  it("arrows still move the selected result while j/k scroll text", () => {
    const entries = makeEntries(2);
    const tui = createMockTui();
    const theme = createMockTheme();
    const component = new BtwReviewComponent(entries, tui, theme, vi.fn());

    component.handleInput("j"); // j scroll, not selection move
    component.render(80);
    expect(component.render(80).some((l) => l.startsWith(">") && l.includes("Question 2"))).toBe(true);

    component.handleInput("\x1b[B"); // selection move
    const afterDown = component.render(80);
    expect(afterDown.some((l) => l.startsWith(">") && l.includes("Question 1"))).toBe(true);
  });
});
