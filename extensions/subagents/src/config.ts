/**
 * subagents — on/off switch read from pi settings.json.
 *
 * `{ "subagents": { "enabled": false } }` skips registering the subagent tool,
 * command, and orchestration guidelines. Deep research drives subagents, so it
 * reads the same key and skips itself too.
 *
 * Read once when the extension loads — restart pi after toggling it.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const DEFAULT_SUBAGENTS_ENABLED = true;

/** Pure: only a literal `enabled: false` disables subagents. */
export function parseSubagentsEnabled(
  raw: Record<string, unknown> | null | undefined,
): boolean {
  const section = raw?.subagents;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return DEFAULT_SUBAGENTS_ENABLED;
  }
  return (section as Record<string, unknown>).enabled !== false;
}

/** Project-local `.pi/settings.json` wins over `~/.pi/agent/settings.json`. */
export function loadSubagentsEnabled(): boolean {
  const paths = [
    join(process.cwd(), ".pi", "settings.json"),
    join(homedir(), ".pi", "agent", "settings.json"),
  ];

  for (const settingsPath of paths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      if ("subagents" in settings) return parseSubagentsEnabled(settings);
    } catch {
      // Unreadable settings — fall through to the next path
    }
  }

  return DEFAULT_SUBAGENTS_ENABLED;
}
