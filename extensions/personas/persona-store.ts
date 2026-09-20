import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parsePersonaDefinition, type PersonaDefinition } from "./persona-definition-parser.js";

export const DEFAULT_GLOBAL_PERSONAS_DIR = join(homedir(), ".pi", "agent", "personas");
export const DEFAULT_BUNDLED_PERSONAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "bundled");

export interface LoadedPersona {
  ok: true;
  persona: PersonaDefinition;
}

export interface FailedPersona {
  ok: false;
  fileName: string;
  error: string;
}

export type DirectoryPersona = LoadedPersona | FailedPersona;

export interface PersonaDirectories {
  /** Project persona directory (.pi/personas under the project root). Defaults to a directory resolved from the session cwd. */
  projectDir?: string;
  /** Global persona directory (~/.pi/agent/personas). */
  globalDir?: string;
  /** Bundled personas shipped inside the extension package. */
  bundledDir?: string;
}

export function isFailedPersona(entry: DirectoryPersona): entry is FailedPersona {
  return !entry.ok;
}

export function personaFileNameStem(fileName: string): string {
  return basename(fileName, ".md");
}

/** Missing directories are tolerated and yield no personas. */
export function loadPersonasFromDirectory(dir: string): DirectoryPersona[] {
  if (!existsSync(dir)) return [];

  const entries: DirectoryPersona[] = [];
  const fileNames = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const fileName of fileNames) {
    try {
      const content = readFileSync(join(dir, fileName), "utf8");
      entries.push({ ok: true, persona: parsePersonaDefinition(content) });
    } catch (e) {
      entries.push({
        ok: false,
        fileName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return entries;
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
    for (const entry of loadPersonasFromDirectory(dir)) {
      if (isFailedPersona(entry)) {
        failed.push(entry);
      } else if (!byName.has(entry.persona.name)) {
        byName.set(entry.persona.name, entry.persona);
      }
    }
  }
  return { validPersonas: [...byName.values()], failedPersonas: failed };
}
