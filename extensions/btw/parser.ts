export type { BtwToolTraceEntry, BtwUsage } from "./types.js";
import type { BtwToolTraceEntry, BtwUsage } from "./types.js";

/**
 * Parse NDJSON lines from the BTW child process stdout and extract structured data.
 *
 * Extracts:
 * - Final assistant text from message_end events
 * - Tool trace from tool_execution_start / tool_call events
 * - Usage stats, model, and stop reason from message_end events
 */
export function parseBtwOutput(lines: string[]): {
  text: string;
  toolTrace: BtwToolTraceEntry[];
  usage: BtwUsage;
  model?: string;
  stopReason?: string;
} {
  let text = "";
  const toolTrace: BtwToolTraceEntry[] = [];
  const usage: BtwUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model: string | undefined;
  let stopReason: string | undefined;

  const seenToolIds = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const eventType = parsed.type as string | undefined;

    // Extract assistant text from message_end
    if (eventType === "message_end") {
      const msg = parsed.message as {
        role?: string;
        content?: unknown;
        model?: string;
        stopReason?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number };
      } | undefined;
      if (msg?.role === "assistant") {
        text = extractTextContent(msg.content);
        model = msg.model ?? undefined;
        stopReason = msg.stopReason ?? undefined;

        // Accumulate usage across all assistant message_end events.
        // Each event contributes its usage to the running total.
        usage.input += msg.usage?.input ?? 0;
        usage.output += msg.usage?.output ?? 0;
        usage.cacheRead += msg.usage?.cacheRead ?? 0;
        usage.cacheWrite += msg.usage?.cacheWrite ?? 0;
        if (msg.usage?.cost !== undefined) {
          usage.cost = (usage.cost ?? 0) + msg.usage.cost;
        }
      }
    }

    // Extract tool trace from tool_execution_start / tool_call
    if (eventType === "tool_execution_start" || eventType === "tool_call") {
      const toolCallId = ((parsed.toolCallId ?? parsed.id ?? "") as string);
      if (toolCallId && seenToolIds.has(toolCallId)) continue;
      if (toolCallId) seenToolIds.add(toolCallId);

      toolTrace.push({
        toolName: (parsed.toolName as string) ?? "unknown",
        args: (parsed.args as Record<string, unknown>) ?? (parsed.input as Record<string, unknown>) ?? {},
      });
    }
  }

  return { text, toolTrace, usage, model, stopReason };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string",
    )
    .map((block) => (block as { text: string }).text)
    .join("\n");
}
