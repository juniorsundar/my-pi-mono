/**
 * Diff generation utilities.
 *
 * `generateDiff` produces a full-width coloured diff (delta or unified)
 * for the TUI overlay. `generateCompactDiff` produces a structured summary
 * (counts, hunks) for the inline card.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────

export interface HunkSummary {
  description: string;
  lines: string[];
  truncated: number;
}

export interface CompactDiff {
  fileName: string;
  title: string;
  additions: number;
  deletions: number;
  hunks: HunkSummary[];
}

// ── Full diff (for overlay) ───────────────────────────────────────────

export function generateDiff(
  before: string,
  after: string,
  fileName: string,
  width: number,
): string {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-diff-overlay-"));
  const beforePath = join(tempDir, "a.ts");
  const afterPath = join(tempDir, "b.ts");

  try {
    writeFileSync(beforePath, before, "utf8");
    writeFileSync(afterPath, after, "utf8");

    // Try delta first (inline diff with line numbers + syntax highlighting)
    // Pass --width so delta fills the overlay width (defaults to 80 when piped)
    // Use base16 syntax theme which inherits the terminal's 16 ANSI colors,
    // so it automatically matches the terminal colorscheme.
    const deltaResult = spawnSync(
      "delta",
      [
        "--width", String(width),
        "--syntax-theme", "base16",
        "--file-modified-label", `after (${fileName})`,
        "--file-removed-label", `before (${fileName})`,
        "--file-added-label", `after (${fileName})`,
        "--file-renamed-label", `renamed (${fileName})`,
        beforePath,
        afterPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          FORCE_COLOR: "1",
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
        },
        encoding: "utf8",
      },
    );

    // delta returns exit code 1 when files differ (like diff), which is success for us
    if (deltaResult.stdout.trim()) {
      return deltaResult.stdout;
    }

    // Fallback: unified diff with color
    const diffResult = spawnSync(
      "diff",
      [
        "--color=always",
        "-u",
        "--label", `before/${fileName}`,
        "--label", `after/${fileName}`,
        beforePath,
        afterPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "1" },
        encoding: "utf8",
      },
    );

    // diff exits 1 when files differ — that's success for our purpose
    if (diffResult.stdout.trim()) {
      return diffResult.stdout;
    }

    return "(no diff output generated)";
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Compact diff (for inline card) ────────────────────────────────────
//
// Re-parses the output of `diff -u` into a small, structured shape:
// counts and full hunks (every line, untruncated) for the inline card.
// ANSI escapes are stripped — the inline card uses simple +/- prefixes
// coloured via theme.fg rather than delta's full syntax theme.
//
// Note: we deliberately shell out to `diff -u` here instead of reusing
// generateDiff(). Delta at `--width 200` emits a side-by-side layout with
// no literal `+`/`-` prefixes on content lines (only `─────┐` hunk bars),
// which makes counts impossible. `diff -u` always produces a unified stream
// with `+`/`-` prefixes.

// No per-hunk truncation: edit/write approval cards show every hunk line as-is.
const DEFAULT_MAX_LINES_PER_HUNK = Number.POSITIVE_INFINITY;

export function generateCompactDiff(
  before: string,
  after: string,
  fileName: string,
  title: string,
  maxLinesPerHunk: number = DEFAULT_MAX_LINES_PER_HUNK,
): CompactDiff {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-compact-"));
  const beforePath = join(tempDir, "a.ts");
  const afterPath = join(tempDir, "b.ts");

  try {
    writeFileSync(beforePath, before, "utf8");
    writeFileSync(afterPath, after, "utf8");

    // FORCE_COLOR=1 so we get ANSI codes; we strip them in the parser.
    // diff exits 1 when files differ — that's success for our purpose.
    const r = spawnSync(
      "diff",
      [
        "-u",
        "--label", `before/${fileName}`,
        "--label", `after/${fileName}`,
        beforePath,
        afterPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "1" },
        encoding: "utf8",
      },
    );

    const rawLines = r.stdout.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

    let additions = 0;
    let deletions = 0;
    let currentHunk: HunkSummary | null = null;
    const hunks: HunkSummary[] = [];

    for (const rawLine of rawLines) {
      const stripped = rawLine.replace(/\x1b\[[0-9;]*[mK]/g, "");

      // Unified-diff hunk header: @@ -10,7 +10,8 @@ [optional description]
      if (stripped.startsWith("@@")) {
        if (currentHunk) hunks.push(currentHunk);
        const trailing = stripped.match(/@@[^@]*@@\s*(.*)/)?.[1]?.trim();
        let desc: string;
        if (trailing) {
          desc = trailing;
        } else {
          const range = stripped.match(/@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
          if (range) {
            const oStart = parseInt(range[1]!, 10);
            const oLen = parseInt(range[2] ?? "1", 10);
            const nStart = parseInt(range[3]!, 10);
            const nLen = parseInt(range[4] ?? "1", 10);
            desc = `lines ${oStart}–${oStart + oLen - 1} → ${nStart}–${nStart + nLen - 1}`;
          } else {
            desc = "(hunk)";
          }
        }
        currentHunk = { description: desc, lines: [], truncated: 0 };
        continue;
      }

      // Skip diff metadata (file labels).
      if (
        stripped.startsWith("--- ") ||
        stripped.startsWith("+++ ") ||
        stripped.startsWith("Index: ") ||
        stripped.startsWith("diff --git ")
      ) {
        continue;
      }

      if (stripped.startsWith("+")) additions++;
      else if (stripped.startsWith("-")) deletions++;

      if (currentHunk) {
        if (currentHunk.lines.length < maxLinesPerHunk) {
          currentHunk.lines.push(stripped);
        } else {
          currentHunk.truncated++;
        }
      }
    }

    if (currentHunk) hunks.push(currentHunk);

    return { fileName, title, additions, deletions, hunks };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
