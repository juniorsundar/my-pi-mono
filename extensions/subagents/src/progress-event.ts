/**
 * Progress event — the central typed record of subagent activity.
 *
 * Emitted from a child's NDJSON stdout and consumed by the stream processor,
 * the activity feed formatter, and the workspace durable log.
 *
 * This module is the single source of truth for the ProgressEvent type
 * and the parseEventLine helper.
 */

export interface ProgressEvent {
  type: "lifecycle" | "tool" | "assistant_text" | "thinking" | "terminal" | "usage";
  text: string;
  timestamp: string;
  status?: "started" | "succeeded" | "failed" | "completed";
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResultPreview?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const VALID_TYPES = new Set<ProgressEvent["type"]>([
  "lifecycle",
  "tool",
  "assistant_text",
  "thinking",
  "terminal",
  "usage",
]);

/** Discriminated union returned by {@link parseEventLine}. */
export type ParseResult =
  | { ok: true; event: ProgressEvent }
  | { ok: false; reason: "invalid-json" | "missing-fields" };

/**
 * Parse one NDJSON line into a ProgressEvent or reject it.
 * Pure function — no side effects, no console.warn.
 *
 * Accepts a raw line string and returns a ParseResult discriminated union:
 * - `{ ok: true, event }` when the line is valid JSON with all required fields
 * - `{ ok: false, reason: "invalid-json" }` when JSON.parse fails
 * - `{ ok: false, reason: "missing-fields" }` when required string fields
 *   (type, text, timestamp) are absent or not strings
 */
export function parseEventLine(line: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "missing-fields" };
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.text !== "string" ||
    typeof record.timestamp !== "string"
  ) {
    return { ok: false, reason: "missing-fields" };
  }

  if (!VALID_TYPES.has(record.type as ProgressEvent["type"])) {
    return { ok: false, reason: "missing-fields" };
  }

  const event: ProgressEvent = {
    type: record.type as ProgressEvent["type"],
    text: record.text,
    timestamp: record.timestamp,
  };

  // Keep extra properties from the parsed record for forward-compatibility
  // with new event types or optional fields, without stricter runtime
  // validation here.
  Object.assign(event, record);

  return { ok: true, event };
}
