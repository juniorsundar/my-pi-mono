/**
 * btw — timeout configuration for BTW processes.
 *
 * Reads the BTW timeout setting from pi settings while preserving a safe default.
 * A user who does nothing gets the default five-minute timeout, and a user who
 * configures a BTW timeout gets that value applied consistently when a BTW
 * Process is later spawned.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Default timeout: 5 minutes in milliseconds
export const DEFAULT_BTW_TIMEOUT_MS = 300_000;

/**
 * Source of the timeout value.
 * - 'config': User explicitly configured a valid timeout value.
 * - 'default': No valid configuration found; using the default.
 */
export type BtwTimeoutSource = "config" | "default";

/**
 * Result of loading the BTW timeout.
 */
export interface BtwTimeoutResult {
  /** The timeout value in milliseconds */
  timeout: number;
  /** Whether the timeout came from user config or the default */
  source: BtwTimeoutSource;
}

/**
 * Get the paths to search for settings.json files.
 * Searches project-local (.pi/settings.json) first, then global (~/.pi/agent/settings.json).
 */
function getSettingsPaths(): string[] {
  const home = homedir();
  return [
    join(process.cwd(), ".pi", "settings.json"),
    join(home, ".pi", "agent", "settings.json"),
  ];
}

/**
 * Parse the BTW timeout from raw settings.
 *
 * This is a pure function that separates parsing from I/O.
 * Strict typing: only actual `number` values are accepted.
 * Numeric strings like "60000" are rejected (use Number() beforehand if needed).
 *
 * @param raw - Raw settings object (may be null/undefined)
 * @returns Parsed timeout result with source attribution
 */
export function parseBtwTimeout(raw: Record<string, unknown> | null | undefined): BtwTimeoutResult {
  if (!raw) {
    return { timeout: DEFAULT_BTW_TIMEOUT_MS, source: "default" };
  }

  const btwSettings = raw.btw as Record<string, unknown> | null | undefined;

  const timeoutMs = btwSettings?.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { timeout: DEFAULT_BTW_TIMEOUT_MS, source: "default" };
  }

  return { timeout: timeoutMs, source: "config" };
}

/**
 * Load the BTW timeout from pi settings.
 *
 * Searches project-local (.pi/settings.json) first, then global (~/.pi/agent/settings.json).
 * The first file found with a `btw.timeoutMs` key wins.
 *
 * @returns Parsed timeout result with source attribution
 */
export function loadBtwTimeout(): BtwTimeoutResult {
  const paths = getSettingsPaths();

  for (const settingsPath of paths) {
    if (!existsSync(settingsPath)) continue;

    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const result = parseBtwTimeout(settings);
      if (result.source === "config") {
        return result;
      }
    } catch {
      // Ignore parse errors and try next path
    }
  }

  return { timeout: DEFAULT_BTW_TIMEOUT_MS, source: "default" };
}
