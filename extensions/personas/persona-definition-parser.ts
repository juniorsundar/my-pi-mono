import { parse as parseYaml } from "yaml";
import type { PiSettings } from "../herdr/herdr.js";

/**
 * Session settings shape a Persona session only; live switching never reads them.
 * They become pi flags through piFlags in extensions/herdr, as agent definitions do.
 */
export type PersonaSessionSettings = PiSettings;

export interface PersonaDefinition {
  name: string;
  description?: string;
  systemPromptMode: "append" | "replace";
  body: string;
  session: PersonaSessionSettings;
  /** Directory the definition was read from: relative extraArgs resolve against it. */
  directory: string;
}

const KNOWN_KEYS = new Set([
  "name",
  "description",
  "systemPromptMode",
  "model",
  "thinking",
  "tools",
  "inheritProjectContext",
  "inheritSkills",
  "inheritExtensions",
  "extensions",
  "extraArgs",
]);

export function parsePersonaDefinition(
  markdownContent: string,
  directory: string,
): PersonaDefinition {
  const parts = markdownContent.split(/^---$/m);
  if (parts.length < 2) {
    throw new Error("Invalid persona definition: no YAML frontmatter found");
  }

  const yamlContent = parts[1]?.trim() ?? "";
  const body = parts.slice(2).join("---").trim();

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(yamlContent) ?? {};
  } catch (e) {
    throw new Error(
      `Failed to parse YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("Persona definition frontmatter must be a YAML mapping");
  }

  const rawName = frontmatter.name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    throw new Error("Persona definition must include a non-empty 'name' field");
  }

  const unknownKeys = Object.keys(frontmatter).filter((key) => !KNOWN_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown persona definition frontmatter key: ${unknownKeys[0]}. ` +
        "Persona definitions accept only known fields. " +
        `Check for typos — recognized fields are: ${Array.from(KNOWN_KEYS).join(", ")}.`,
    );
  }

  const description = frontmatter.description;
  if (description !== undefined && typeof description !== "string") {
    throw new Error("Persona definition field 'description' must be a string when present");
  }

  const rawMode = frontmatter.systemPromptMode;
  if (rawMode !== undefined && rawMode !== "append" && rawMode !== "replace") {
    throw new Error(
      `Invalid 'systemPromptMode' value "${String(rawMode)}": expected "append" or "replace"`,
    );
  }

  return {
    name: rawName.trim(),
    description,
    systemPromptMode: rawMode ?? "append",
    body,
    directory,
    session: {
      model: optionalString(frontmatter.model, "model"),
      thinking: optionalString(frontmatter.thinking, "thinking"),
      tools: parseTools(frontmatter.tools),
      inheritProjectContext: optionalBoolean(
        frontmatter.inheritProjectContext,
        "inheritProjectContext",
      ),
      inheritSkills: optionalBoolean(frontmatter.inheritSkills, "inheritSkills"),
      inheritExtensions: optionalBoolean(frontmatter.inheritExtensions, "inheritExtensions"),
      extensions: optionalBoolean(frontmatter.extensions, "extensions"),
      extraArgs: parseExtraArgs(frontmatter.extraArgs),
    },
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Persona definition field '${field}' must be a string when present`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Persona definition field '${field}' must be a boolean when present`);
  }
  return value;
}

/** pi's --tools format: a comma-joined list with no whitespace, from a string or a list. */
function parseTools(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.replace(/\s+/g, "");
  if (Array.isArray(value) && value.every((tool) => typeof tool === "string")) {
    return value.join(",").replace(/\s+/g, "");
  }
  throw new Error(
    "Persona definition field 'tools' must be a string or a list of strings when present",
  );
}

function parseExtraArgs(value: unknown): string[] {
  if (value === undefined) return [];
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
    throw new Error(
      "Persona definition field 'extraArgs' must be a string or a list of strings when present",
    );
  }
  return items;
}