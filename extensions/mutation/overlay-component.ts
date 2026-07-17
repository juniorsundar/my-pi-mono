/**
 * DiffOverlayComponent — the full scrolling diff in a floating modal.
 *
 * Renders a bordered overlay with delta/coloured-diff content, scroll
 * indicators, hunk navigation, and keybinding footer. Accepts
 * approve/deny/edit-in-nvim/dismiss via the `done` callback.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { generateDiff } from "./diff-generation.js";

// ── Result type ───────────────────────────────────────────────────────

export type OverlayResult = "approve" | "deny" | "dismiss" | "edit_in_neovim";

// ── Component ─────────────────────────────────────────────────────────

export class DiffOverlayComponent {
  private theme: Theme;
  private tui: { requestRender: (force?: boolean) => void; terminal: { rows: number } };
  private done: (result: OverlayResult) => void;
  private lines: string[] = [];
  private hunkStarts: number[] = [];
  private scrollOffset = 0;
  private title: string;
  private before: string;
  private after: string;
  private fileName: string;
  private generated = false;

  constructor(
    tui: { requestRender: (force?: boolean) => void; terminal: { rows: number } },
    theme: Theme,
    title: string,
    before: string,
    after: string,
    fileName: string,
    done: (result: OverlayResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.before = before;
    this.after = after;
    this.fileName = fileName;
    this.done = done;
  }

  private ensureDiff(width: number): void {
    if (this.generated) return;
    this.generated = true;
    const diffWidth = Math.max(20, width - 3);
    const diffOutput = generateDiff(this.before, this.after, this.fileName, diffWidth);
    this.lines = diffOutput.split("\n");
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] === "") {
      this.lines.pop();
    }
    this.hunkStarts = [];
    for (let i = 0; i < this.lines.length; i++) {
      const stripped = this.lines[i]!.replace(/\x1b\[[0-9;]*[mK]/g, "");
      if (stripped.includes("─────┐") || stripped.startsWith("@@")) {
        this.hunkStarts.push(i);
      }
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done("deny");
      return;
    }

    // Ctrl+Alt+F — shrink back to inline (toggle, no decision made)
    if (matchesKey(data, "ctrl+alt+f")) {
      this.done("dismiss");
      return;
    }

    // Approve
    if (data === "a" || data === "A") {
      this.done("approve");
      return;
    }

    // Deny
    if (data === "d" || data === "D") {
      this.done("deny");
      return;
    }

    // Edit in Neovim
    if (data === "e" || data === "E") {
      this.done("edit_in_neovim");
      return;
    }

    // Scroll
    if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset = Math.min(this.lines.length - 1, this.scrollOffset + 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }

    // Page down
    const PAGE_SIZE = 20;

    if (matchesKey(data, "pageDown") || data === "J" || matchesKey(data, "ctrl+d")) {
      this.scrollOffset = Math.min(this.lines.length - 1, this.scrollOffset + PAGE_SIZE);
      this.tui.requestRender();
      return;
    }

    // Page up
    if (matchesKey(data, "pageUp") || data === "K" || matchesKey(data, "ctrl+u")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - PAGE_SIZE);
      this.tui.requestRender();
      return;
    }

    // Jump to top
    if (data === "g") {
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }

    // Jump to bottom
    if (data === "G") {
      this.scrollOffset = Math.max(0, this.lines.length - 1);
      this.tui.requestRender();
      return;
    }

    // Next hunk: ]
    if (data === "]") {
      const nextIdx = this.hunkStarts.findIndex((h) => h > this.scrollOffset);
      if (nextIdx !== -1) {
        this.scrollOffset = Math.max(0, this.hunkStarts[nextIdx]! - 1);
      } else if (this.hunkStarts.length > 0) {
        this.scrollOffset = Math.max(0, this.hunkStarts[0]! - 1);
      }
      this.tui.requestRender();
      return;
    }

    // Previous hunk: [
    if (data === "[") {
      let prevIdx = -1;
      for (let i = this.hunkStarts.length - 1; i >= 0; i--) {
        if (this.hunkStarts[i]! < this.scrollOffset) {
          prevIdx = i;
          break;
        }
      }
      if (prevIdx !== -1) {
        this.scrollOffset = Math.max(0, this.hunkStarts[prevIdx]! - 1);
      } else if (this.hunkStarts.length > 0) {
        const last = this.hunkStarts.length - 1;
        this.scrollOffset = Math.max(0, this.hunkStarts[last]! - 1);
      }
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    this.ensureDiff(width);

    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const border = (c: string) => th.fg("border", c);
    const padLine = (s: string) => {
      const vw = visibleWidth(s);
      if (vw > innerW) return truncateToWidth(s, innerW, "", true);
      return s + " ".repeat(Math.max(0, innerW - vw));
    };

    const result: string[] = [];

    // ── Top border with title ──
    const titleStr = ` ${this.title} `;
    const titleVW = visibleWidth(th.fg("accent", titleStr));
    const leftDash = Math.floor((innerW - titleVW) / 2);
    const rightDash = Math.max(0, innerW - titleVW - leftDash);
    result.push(
      border("╭") +
        border("─".repeat(leftDash)) +
        th.fg("accent", titleStr) +
        border("─".repeat(rightDash)) +
        border("╮"),
    );

    // ── Line count + scroll info ──
    const canScrollUp = this.scrollOffset > 0;
    const canScrollDown = this.scrollOffset < this.lines.length - 1;
    const scrollPct =
      this.lines.length > 0
        ? Math.round((this.scrollOffset / this.lines.length) * 100)
        : 100;
    const scrollInfo = [
      `${this.lines.length} lines`,
      canScrollUp || canScrollDown ? `scroll ${scrollPct}%` : null,
      this.hunkStarts.length > 0 ? `${this.hunkStarts.length} hunk(s)` : null,
    ]
      .filter(Boolean)
      .join(" │ ");
    result.push(
      border("│") +
        padLine(th.fg("dim", ` ${scrollInfo}`)) +
        border("│"),
    );

    // ── Compute how many content lines fit ──
    const terminalRows = this.tui.terminal.rows;
    const overlayHeight = Math.max(10, Math.floor(terminalRows * 0.8) - 6);
    const fixedLines = 4; // top border + scroll info + footer + bottom border
    const maxContent = Math.max(1, overlayHeight - fixedLines);

    // ── Footer with keybindings ──
    const keys =
      th.fg("accent", "A") +
      th.fg("dim", "pprove  ") +
      th.fg("accent", "D") +
      th.fg("dim", "eny  ") +
      th.fg("accent", "E") +
      th.fg("dim", "dit in nvim  ") +
      th.fg("accent", "↑↓") +
      th.fg("dim", "/") +
      th.fg("accent", "jk") +
      th.fg("dim", " scroll  ") +
      th.fg("accent", "[]") +
      th.fg("dim", " hunk  ") +
      th.fg("accent", "g/G") +
      th.fg("dim", " top/bot  ") +
      th.fg("accent", "Esc") +
      th.fg("dim", " deny  ") +
      th.fg("accent", "Ctrl+Alt+F") +
      th.fg("dim", " shrink");
    result.push(
      border("│") + padLine(` ${keys}`) + border("│"),
    );

    // ── Diff content ──
    for (let i = 0; i < maxContent; i++) {
      const lineIdx = this.scrollOffset + i;
      if (lineIdx < this.lines.length) {
        result.push(border("│") + padLine(` ${this.lines[lineIdx]!}`) + border("│"));
      } else {
        result.push(border("│") + padLine("") + border("│"));
      }
    }

    // ── Bottom border ──
    result.push(
      border("╰") + border("─".repeat(innerW)) + border("╯"),
    );

    return result;
  }

  invalidate(): void {}
}
