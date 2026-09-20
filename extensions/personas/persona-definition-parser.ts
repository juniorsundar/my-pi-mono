import { parse as parseYaml } from "yaml";

export interface PersonaDefinition {
  name: string;
  description?: string;
  systemPromptMode: "append" | "replace";
  body: string;
}

const KNOWN_KEYS = new Set(["name", "description", "systemPromptMode"]);

export function parsePersonaDefinition(markdownContent: string): PersonaDefinition {
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
  };
}