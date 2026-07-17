/**
 * btw — BTW Review Component.
 *
 * A full-screen TUI view for reviewing completed BTW results.
 * Renders entries newest-first, most recent expanded by default,
 * older collapsed, with keyboard navigation and expand/collapse.
 *
 * Pass to ctx.ui.custom() to open:
 *
 *   const component = new BtwReviewComponent(
 *     registry.getCompleted(), tui, theme, done
 *   );
 *   ctx.ui.custom(component);
 */

import type { CompletedEntry } from "./registry.js";
import { truncateToWidth, wrapText } from "./text-utils.js";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface BtwReviewTuiLike {
  requestRender(): void;
}

export interface BtwReviewThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface BtwReviewKeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class BtwReviewComponent {
  private selectedIndex = 0;
  private expandedIndices: Set<number> = new Set();
  private toolTraceExpandedIndices: Set<number> = new Set();
  private scrollOffset = 0;
  private viewportHeight = 40; // default estimate, updated by TUI
  private entryLineRanges: Array<{ start: number; end: number }> = [];
  private shouldEnsureSelectedVisible = false;

  constructor(
    private readonly entries: readonly CompletedEntry[],
    private readonly tui: BtwReviewTuiLike,
    private readonly theme: BtwReviewThemeLike,
    public readonly onClose: () => void,
    private readonly keybindings?: BtwReviewKeybindingsLike,
  ) {
    // Most recent entry (index 0 in newest-first order) expanded by default
    if (entries.length > 0) {
      this.expandedIndices.add(0);
    }
    // Tool traces default to collapsed
  }

  /** Set the viewport height (called by TUI wrapper or estimated from terminal). */
  setViewportHeight(height: number): void {
    this.viewportHeight = Math.max(5, height);
  }

  // ── Component interface ───────────────────────────────────────────

  render(width: number): string[] {
    const allLines = this.computeRender(width);

    // Track line ranges for each entry
    this.computeEntryLineRanges(allLines, width);

    // Auto-scroll only after selection movement. Do not do this after arrow-key
    // viewport scrolling, or the render pass will snap back to the selected item.
    if (this.shouldEnsureSelectedVisible) {
      this.ensureSelectedVisible();
      this.shouldEnsureSelectedVisible = false;
    }

    const maxScroll = Math.max(0, allLines.length - this.viewportHeight);
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxScroll);

    // Slice to viewport
    const visible = allLines.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);

    // Add scroll indicator if content overflows
    if (allLines.length > this.viewportHeight && visible.length > 0) {
      const scrollPct = maxScroll > 0 ? Math.round((this.scrollOffset / maxScroll) * 100) : 0;
      const indicator = this.theme.fg("dim", `── ${scrollPct}% · ↑↓ select · j/k scroll · Enter expand · Esc close ──`);
      if (this.scrollOffset + this.viewportHeight < allLines.length) {
        visible[visible.length - 1] = indicator;
      }
    }

    return visible;
  }

  /** Compute which line range each entry occupies in the full render. */
  private computeEntryLineRanges(allLines: string[], _width: number): void {
    // We re-run the same logic as computeRender to track line offsets
    // This is a bit wasteful but keeps the code simple
    this.entryLineRanges = [];
    let lineIdx = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const start = lineIdx;
      lineIdx++; // header line
      if (this.expandedIndices.has(i)) {
        const entry = this.entries[i];
        const contentIndent = 2;
        const contentWidth = Math.max(1, _width - contentIndent);
        const resultLines = this.renderExpandedContent(entry, i, contentWidth);
        lineIdx += resultLines.length;
      }
      this.entryLineRanges[i] = { start, end: lineIdx - 1 };
    }
  }

  /** Adjust scrollOffset so the selected entry is fully visible. */
  private ensureSelectedVisible(): void {
    const range = this.entryLineRanges[this.selectedIndex];
    if (!range) return;

    // Scroll down if selected entry's end is below viewport
    if (range.end >= this.scrollOffset + this.viewportHeight - 1) {
      this.scrollOffset = range.end - this.viewportHeight + 2;
    }

    // Scroll up if selected entry's start is above viewport
    if (range.start < this.scrollOffset) {
      this.scrollOffset = range.start;
    }

    // Clamp
    this.scrollOffset = Math.max(0, this.scrollOffset);
  }

  private computeRender(width: number): string[] {
    if (this.entries.length === 0) {
      return [this.theme.fg("muted", "No completed BTW results yet.")];
    }

    const lines: string[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const isSelected = i === this.selectedIndex;
      const isExpanded = this.expandedIndices.has(i);
      const prefix = isSelected ? this.theme.fg("accent", ">") : " ";
      const icon = entry.result.type === "success"
        ? this.theme.fg("success", "✓")
        : this.theme.fg("error", "✗");

      // Header line — truncate to fit width
      const header = `${prefix} ${icon} btw: ${entry.query}`;
      lines.push(truncateToWidth(header, width));

      // Expanded content
      if (isExpanded) {
        const contentIndent = 2;
        const contentWidth = Math.max(1, width - contentIndent);
        const resultLines = this.renderExpandedContent(entry, i, contentWidth);
        for (const rl of resultLines) {
          lines.push(`  ${truncateToWidth(rl, contentWidth)}`);
        }
      }
    }
    return lines;
  }

  private renderExpandedContent(entry: CompletedEntry, entryIndex: number, contentWidth: number): string[] {
    const lines: string[] = [];
    const result = entry.result;

    // Usage stats (only for success results)
    if (result.type === "success") {
      const { usage } = result;
      const usageParts: string[] = [];
      if (usage.input) usageParts.push(`↑${this.formatTokens(usage.input)}`);
      if (usage.output) usageParts.push(`↓${this.formatTokens(usage.output)}`);
      if (usage.cacheRead) usageParts.push(`R${this.formatTokens(usage.cacheRead)}`);
      if (usage.cacheWrite) usageParts.push(`W${this.formatTokens(usage.cacheWrite)}`);
      if (usage.cost !== undefined && usage.cost > 0) usageParts.push(`$${usage.cost.toFixed(4)}`);
      if (result.model) usageParts.push(result.model);
      if (result.stopReason) usageParts.push(result.stopReason);
      if (usageParts.length > 0) {
        lines.push(this.theme.fg("dim", usageParts.join(" ")));
      }
    }

    // Separator — dynamic width
    const sepLen = Math.min(contentWidth, 40);
    lines.push(this.theme.fg("muted", "─".repeat(sepLen)));

    // Tool trace — collapsed by default
    if (result.toolTrace.length > 0) {
      const traceCount = result.toolTrace.length;
      const isTraceExpanded = this.toolTraceExpandedIndices.has(entryIndex);
      if (isTraceExpanded) {
        lines.push(this.theme.fg("muted", "▾ Tool trace"));
        for (const tool of result.toolTrace) {
          lines.push(`  ${this.renderToolCall(tool.toolName, tool.args)}`);
        }
      } else {
        lines.push(
          this.theme.fg("muted", `▸ Tool trace (${traceCount} ${traceCount === 1 ? "tool" : "tools"})`),
        );
      }
    }

    // Result content — word-wrapped to fit available width
    if (result.type === "success") {
      const wrappedLines = wrapText(result.text, contentWidth);
      for (const wl of wrappedLines) {
        lines.push(this.theme.fg("toolOutput", wl));
      }
    } else {
      const errorMsg = `Error: ${result.error}`;
      for (const wl of wrapText(errorMsg, contentWidth)) {
        lines.push(this.theme.fg("error", wl));
      }
      if (result.exitCode !== undefined) {
        lines.push(this.theme.fg("dim", `Exit code: ${result.exitCode}`));
      }
      if (result.stderr) {
        for (const wl of wrapText(result.stderr, contentWidth)) {
          lines.push(this.theme.fg("dim", wl));
        }
      }
    }

    return lines;
  }

  private formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
  }

  private renderToolCall(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case "read":
      case "edit":
      case "write":
      case "ls": {
        const filePath = (args.file_path || args.path || "...") as string;
        return `${this.theme.fg("muted", "→")} ${this.theme.fg("muted", `${toolName} `)}${this.theme.fg("accent", filePath)}`;
      }
      case "bash": {
        const command = (args.command || "") as string;
        const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
        return `${this.theme.fg("muted", "→")} ${this.theme.fg("muted", "$ ")}${this.theme.fg("toolOutput", preview)}`;
      }
      case "grep": {
        const pattern = (args.pattern || "") as string;
        return `${this.theme.fg("muted", "→")} ${this.theme.fg("muted", `grep /${pattern}/`)}`;
      }
      case "find": {
        const pattern = (args.pattern || "*") as string;
        const filePath = (args.path || ".") as string;
        return `${this.theme.fg("muted", "→")} ${this.theme.fg("muted", `find `)}${this.theme.fg("accent", pattern)}${this.theme.fg("dim", ` in ${filePath}`)}`;
      }
      default: {
        const argsStr = JSON.stringify(args);
        const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
        return `${this.theme.fg("muted", "→")} ${this.theme.fg("accent", toolName)}${this.theme.fg("dim", ` ${preview}`)}`;
      }
    }
  }

  handleInput(data: string): void {
    // Escape works regardless of entries state
    if (data === "\x1b") {
      this.onClose();
      return;
    }

    if (this.entries.length === 0) return;

    // ── Selection movement (arrow keys) ──
    if (data === "\x1b[A") {
      // Up arrow — move selection up
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.shouldEnsureSelectedVisible = true;
        this.tui.requestRender();
      }
    } else if (data === "\x1b[B") {
      // Down arrow — move selection down
      if (this.selectedIndex < this.entries.length - 1) {
        this.selectedIndex++;
        this.shouldEnsureSelectedVisible = true;
        this.tui.requestRender();
      }
    }
    // ── Viewport scroll (j/k, Page Up/Down, Ctrl+D/U) ──
    else if (data === "k") {
      // k — scroll viewport up
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
    } else if (data === "j") {
      // j — scroll viewport down
      this.scrollOffset++;
      this.tui.requestRender();
    } else if (data === "\x1b[5~") {
      // Page Up
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight);
      this.tui.requestRender();
    } else if (data === "\x1b[6~") {
      // Page Down
      this.scrollOffset += this.viewportHeight;
      this.tui.requestRender();
    } else if (data === "\x04") {
      // Ctrl+D — half page down
      this.scrollOffset += Math.floor(this.viewportHeight / 2);
      this.tui.requestRender();
    } else if (data === "\x15") {
      // Ctrl+U — half page up
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.floor(this.viewportHeight / 2));
      this.tui.requestRender();
    } else if (data === "g") {
      // g — go to top
      this.scrollOffset = 0;
      this.selectedIndex = 0;
      this.tui.requestRender();
    } else if (data === "G") {
      // G — go to bottom
      this.selectedIndex = this.entries.length - 1;
      this.shouldEnsureSelectedVisible = true;
      this.tui.requestRender();
    }
    // ── Space: always toggle entry expand/collapse ──
    else if (data === " ") {
      if (this.expandedIndices.has(this.selectedIndex)) {
        this.expandedIndices.delete(this.selectedIndex);
      } else {
        this.expandedIndices.add(this.selectedIndex);
      }
      this.scrollOffset = 0;
      this.tui.requestRender();
    }
    // ── Enter: toggle expand/collapse, or toggle tool trace if entry has tools ──
    else if (
      data === "\r" ||
      (this.keybindings?.matches(data, "tui.select.confirm") ?? false)
    ) {
      const entry = this.entries[this.selectedIndex];
      const isExpanded = this.expandedIndices.has(this.selectedIndex);
      const hasToolTrace = isExpanded && entry?.result.toolTrace.length > 0;

      if (hasToolTrace) {
        // If entry is expanded and has tool trace, toggle tool trace
        if (this.toolTraceExpandedIndices.has(this.selectedIndex)) {
          this.toolTraceExpandedIndices.delete(this.selectedIndex);
        } else {
          this.toolTraceExpandedIndices.add(this.selectedIndex);
        }
      } else {
        // Otherwise toggle entry expand/collapse
        if (this.expandedIndices.has(this.selectedIndex)) {
          this.expandedIndices.delete(this.selectedIndex);
        } else {
          this.expandedIndices.add(this.selectedIndex);
        }
      }
      this.scrollOffset = 0;
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    // No caching — render reads state fresh each time
  }
}
