import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  thinking?: string;
  systemPromptMode: "replace" | "append";
  systemPromptBody: string;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  inheritExtensions: boolean;
  timeout?: number;
}

export function parseAgentDefinition(markdownContent: string): AgentDefinition {
  // Split frontmatter from body
  const parts = markdownContent.split(/^---$/m);
  if (parts.length < 2) {
    throw new Error("Invalid agent definition: no YAML frontmatter found");
  }

  const yamlContent = parts[1]?.trim() ?? "";
  const body = parts.slice(2).join("---").trim();

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(yamlContent) ?? {};
  } catch (e) {
    throw new Error(
      `Failed to parse YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!frontmatter.name || typeof frontmatter.name !== "string" || !String(frontmatter.name).trim()) {
    throw new Error("Agent definition must include a non-empty 'name' field");
  }

  const KNOWN_KEYS = new Set([
    "name",
    "description",
    "model",
    "tools",
    "thinking",
    "systemPromptMode",
    "inheritProjectContext",
    "inheritSkills",
    "inheritExtensions",
    "timeout",
  ]);

  const unknownKeys = Object.keys(frontmatter).filter(
    (key) => !KNOWN_KEYS.has(key)
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown agent definition frontmatter key: ${unknownKeys[0]}. ` +
        "Agent definitions accept only known fields. " +
        "Check for typos — recognized fields are: " +
        Array.from(KNOWN_KEYS).join(", ") + "."
    );
  }

  const toolsRaw = frontmatter.tools;
  let tools: string[] | undefined;
  if (typeof toolsRaw === "string") {
    tools = toolsRaw.split(",").map((t: string) => t.trim());
  } else if (Array.isArray(toolsRaw)) {
    tools = toolsRaw.map((t: unknown) => String(t).trim());
  }

  return {
    name: frontmatter.name ?? "",
    description: frontmatter.description as string | undefined,
    model: frontmatter.model as string | undefined,
    tools,
    thinking: frontmatter.thinking as string | undefined,
    systemPromptMode:
      String(frontmatter.systemPromptMode ?? "").toLowerCase() === "append"
        ? "append"
        : "replace",
    systemPromptBody: body,
    inheritProjectContext: (frontmatter.inheritProjectContext ?? true) as boolean,
    inheritSkills: (frontmatter.inheritSkills ?? true) as boolean,
    inheritExtensions: (frontmatter.inheritExtensions ?? true) as boolean,
    timeout: typeof frontmatter.timeout === "number" ? frontmatter.timeout : undefined,
  };
}

export function parseAgentDefinitionFile(
  agentName: string,
  agentsDir: string
): AgentDefinition {
  const filePath = resolve(agentsDir, `${agentName}.md`);
  if (!existsSync(filePath)) {
    throw new Error(
      `Agent definition file not found for "${agentName}" at ${filePath}`
    );
  }
  const content = readFileSync(filePath, "utf-8");
  return parseAgentDefinition(content);
}
