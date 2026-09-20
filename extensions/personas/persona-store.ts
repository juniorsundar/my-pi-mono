import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parsePersonaDefinition, type PersonaDefinition } from "./persona-definition-parser.js";

export const DEFAULT_GLOBAL_PERSONAS_DIR = join(homedir(), ".pi", "agent", "personas");
export const DEFAULT_BUNDLED_PERSONAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "bundled");

export interface FailedPersona {
  fileName: string;
  error: string;
}

export interface PersonaDirectories {
  /** Project persona directory (.pi/personas under the project root). Defaults to a directory resolved from the session cwd. */
  projectDir?: string;
  /** Global persona directory (~/.pi/agent/personas). */
  globalDir?: string;
  /** Bundled personas shipped inside the extension package. */
  bundledDir?: string;
}

/** Missing directories are tolerated and yield no personas. */
export function loadPersonasFromDirectory(
  dir: string,
): { valid: PersonaDefinition[]; failed: FailedPersona[] } {
  if (!existsSync(dir)) return { valid: [], failed: [] };

  const valid: PersonaDefinition[] = [];
  const failed: FailedPersona[] = [];
  const fileNames = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const fileName of fileNames) {
    try {
      valid.push(parsePersonaDefinition(readFileSync(join(dir, fileName), "utf8")));
    } catch (e) {
      failed.push({
        fileName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { valid, failed };
}

export function projectPersonasDir(cwd: string): string {
  return join(cwd, ".pi", "personas");
}

export interface ResolvedPersonas {
  validPersonas: PersonaDefinition[];
  failedPersonas: FailedPersona[];
}

/** Directory precedence is project > global > bundled; the first valid definition for a persona name wins. */
export function resolvePersonas(options: PersonaDirectories, cwd: string): ResolvedPersonas {
  const directories = [
    options.projectDir ?? projectPersonasDir(cwd),
    options.globalDir ?? DEFAULT_GLOBAL_PERSONAS_DIR,
    options.bundledDir ?? DEFAULT_BUNDLED_PERSONAS_DIR,
  ];
  const byName = new Map<string, PersonaDefinition>();
  const failed: FailedPersona[] = [];
  for (const dir of directories) {
    const loaded = loadPersonasFromDirectory(dir);
    for (const persona of loaded.valid) {
      if (!byName.has(persona.name)) byName.set(persona.name, persona);
    }
    failed.push(...loaded.failed);
  }
  return { validPersonas: [...byName.values()], failedPersonas: failed };
}
