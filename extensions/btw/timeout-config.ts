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
 * Pure function that separates parsing from I/O.
 * Strict typing: only actual `number` values are accepted.
 * Numeric strings like "60000" are rejected (use Number() beforehand if needed).
 */
export function parseBtwTimeout(raw: Record<string, unknown> | null | undefined): number {
	const timeoutMs = (raw?.btw as Record<string, unknown> | undefined)?.timeoutMs;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return DEFAULT_BTW_TIMEOUT_MS;
	}
	return timeoutMs;
}

/**
 * Load the BTW timeout from pi settings.
 *
 * Searches project-local (.pi/settings.json) first, then global (~/.pi/agent/settings.json).
 * The first file found with a `btw.timeoutMs` key wins.
 */
export function loadBtwTimeout(): number {
	for (const settingsPath of getSettingsPaths()) {
		if (!existsSync(settingsPath)) continue;

		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
			const timeout = parseBtwTimeout(settings);
			if (timeout !== DEFAULT_BTW_TIMEOUT_MS) return timeout;
		} catch {
			// Ignore parse errors and try next path
		}
	}

	return DEFAULT_BTW_TIMEOUT_MS;
}