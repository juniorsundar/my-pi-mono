// ── Shared text utilities for BTW modules ────────────────────────────

/**
 * Strip ANSI SGR escape sequences from a string.
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Truncate a string so that its visible width does not exceed `maxWidth`.
 * Strips ANSI codes first, truncates plain text, then appends ellipsis.
 * This avoids corrupting partial escape sequences.
 */
export function truncateToWidth(str: string, maxWidth: number, ellipsis = "…"): string {
  const plain = stripAnsi(str);
  if (plain.length <= maxWidth) return str;
  // Truncate the plain text, then find where that truncation corresponds
  // in the original string by matching prefix character by character
  const keepLen = maxWidth - ellipsis.length;
  let visibleCount = 0;
  let resultEnd = 0;
  for (let i = 0; i < str.length && visibleCount < keepLen; i++) {
    const ch = str[i];
    // Skip ANSI escape sequences without counting them
    if (ch === "\x1b") {
      // Consume the escape sequence: \x1b [ 0-9;... m
      while (i < str.length && str[i] !== "m") i++;
      resultEnd = i + 1; // include the 'm'
      continue;
    }
    visibleCount++;
    resultEnd = i + 1;
  }
  return str.slice(0, resultEnd) + ellipsis;
}

/**
 * Truncate plain text to a maximum length, appending ellipsis if truncated.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

/**
 * Wrap text to fit within `maxWidth` columns, breaking at word boundaries.
 * Preserves existing newlines in the input. Each resulting line is ≤ maxWidth.
 * ANSI sequences are stripped for width calculation but preserved in output.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  const outputLines: string[] = [];
  const inputLines = text.split("\n");

  for (const inputLine of inputLines) {
    // Fast path: line fits as-is
    if (stripAnsi(inputLine).length <= maxWidth) {
      outputLines.push(inputLine);
      continue;
    }

    // Word-wrap this line
    let currentLine = "";
    let currentPlainLen = 0;
    const words = inputLine.split(/(\s+)/); // preserve whitespace groups

    for (const word of words) {
      const wordPlainLen = stripAnsi(word).length;

      // If adding this word would exceed width and current line is non-empty
      if (currentPlainLen + wordPlainLen > maxWidth && currentLine.length > 0) {
        outputLines.push(currentLine);
        // Start new line, skip leading whitespace
        if (/^\s+$/.test(word)) {
          currentLine = "";
          currentPlainLen = 0;
        } else {
          currentLine = word;
          currentPlainLen = wordPlainLen;
        }
      } else {
        currentLine += word;
        currentPlainLen += wordPlainLen;
      }
    }

    if (currentLine.length > 0) {
      outputLines.push(currentLine);
    }
  }

  return outputLines;
}
