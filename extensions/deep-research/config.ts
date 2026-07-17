import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface DeepResearchConfig {
  /** Full model ID for subagents (e.g. "ollama/gemma4:31b").
   *  If omitted, falls back to each agent definition's default model. */
  subagentModel?: string;

  /** Full model ID for the orchestrator (e.g. "opencode-go/deepseek-v4-flash").
   *  If omitted, the session's current model is used. */
  orchestratorModel?: string;
}

export interface LoadConfigResult {
  config: DeepResearchConfig;
  errors: string[];
}

function getSettingsPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".pi", "agent", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ];
}

/**
 * Parse deepresearch config from a raw settings JSON object.
 * Extracted for testability — pure function, no file I/O.
 */
export function parseDeepresearchConfig(
  raw: Record<string, unknown>,
): { config: DeepResearchConfig; found: boolean } {
  const rawDr = raw.deepresearch;
  if (!rawDr || typeof rawDr !== "object" || Array.isArray(rawDr)) {
    return { config: {}, found: false };
  }
  const dr = rawDr as Record<string, unknown>;

  return {
    config: {
      subagentModel: typeof dr.subagentModel === "string" ? dr.subagentModel : undefined,
      orchestratorModel: typeof dr.orchestratorModel === "string" ? dr.orchestratorModel : undefined,
    },
    found: true,
  };
}

/**
 * Load deepresearch config from settings.json.
 * Searches global (~/.pi/agent/settings.json) first, then project-local (.pi/settings.json).
 * The first file found with a `deepresearch` key wins.
 */
export function loadDeepresearchConfig(): LoadConfigResult {
  const errors: string[] = [];
  const paths = getSettingsPaths();

  for (const settingsPath of paths) {
    if (!existsSync(settingsPath)) continue;

    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const { config, found } = parseDeepresearchConfig(settings);
      if (!found) {
        errors.push(`deepresearch key not found in ${settingsPath}`);
        continue;
      }
      return { config, errors: [] };
    } catch (err) {
      errors.push(`Cannot parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { config: {}, errors };
}
