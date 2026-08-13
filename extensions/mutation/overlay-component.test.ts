import { describe, expect, it, vi } from "vitest";

// Isolate diff generation (which shells out to `delta`/`diff`) so the overlay
// renderer can be exercised deterministically.
vi.mock("./diff-generation.js", () => ({
  generateDiff: () => "line one\nline two\nline three\n",
}));

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: () => false,
  truncateToWidth: (text: string, maxWidth: number) => text.slice(0, maxWidth),
  visibleWidth: (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length,
}));

import { DiffOverlayComponent } from "./overlay-component.js";

function makeTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

function makeTui(rows = 40) {
  return { requestRender: vi.fn(), terminal: { rows } };
}

describe("DiffOverlayComponent", () => {
  it("does not crash when the title is wider than the overlay width", () => {
    const comp = new DiffOverlayComponent(
      makeTui(),
      makeTheme(),
      "Pi Approval | write | a-very-long-target-path-that-exceeds-the-overlay-width.txt",
      "before",
      "after",
      "file.txt",
      vi.fn(),
    );

    // A narrow overlay forces the title border to be truncated rather than
    // passed as a negative count to String.repeat (which crashed pi).
    const lines = comp.render(20);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
  });

  it("renders the title normally when the overlay is wide enough", () => {
    const comp = new DiffOverlayComponent(
      makeTui(),
      makeTheme(),
      "Pi Approval | write | file.txt",
      "before",
      "after",
      "file.txt",
      vi.fn(),
    );

    const lines = comp.render(80);
    expect(lines.some((line) => line.includes("Pi Approval"))).toBe(true);
    expect(lines.some((line) => line.includes("line two"))).toBe(true);
  });
});
