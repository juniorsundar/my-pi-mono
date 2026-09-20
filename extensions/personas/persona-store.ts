import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { parsePersonaDefinition, type PersonaDefinition } from "./persona-definition-parser.js";

export const DEFAULT_GLOBAL_PERSONAS_DIR = join(homedir(), ".pi", "agent", "personas");

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
  /** Project persona directory (.pi/personas under the project root). Wired by ticket 0062. */
  projectDir?: string;
  /** Global persona directory (~/.pi/agent/personas). */
  globalDir?: string;
  /** Bundled personas shipped inside the extension package. Wired by ticket 0062. */
  bundledDir?: string;
}

export function isValidPersona(entry: DirectoryPersona): entry is LoadedPersona {
  return entry.ok;
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