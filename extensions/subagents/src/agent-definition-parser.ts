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
  /** Literal extra pi argv appended verbatim; paths resolve against the agents dir, `~/` against HOME. */
  extraArgs: string[];
  timeout?: number;
}

export function parseAgentDefinition(
  markdownContent: string,
  agentsDir: string = process.cwd(),
): AgentDefinition {
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

  // Unrecognised keys are ignored: other tools share these definition files.

  const toolsRaw = frontmatter.tools;
  let tools: string[] | undefined;
  if (typeof toolsRaw === "string") {
    tools = toolsRaw.split(",").map((t: string) => t.trim());
  } else if (Array.isArray(toolsRaw)) {
    tools = toolsRaw.map((t: unknown) => String(t).trim());
  }

  const extraRaw = frontmatter.extraArgs;
  const extraArgs = (Array.isArray(extraRaw) ? extraRaw : typeof extraRaw === "string" ? [extraRaw] : [])
    .flatMap((item) => String(item).split(/\s+/))
    .filter(Boolean)
    .map((arg) =>
      arg.startsWith("~/")
        ? resolve(process.env.HOME ?? "", arg.slice(2))
        : arg.startsWith("./") || arg.startsWith("../")
          ? resolve(agentsDir, arg)
          : arg,
    );

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
    extraArgs,
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
  return parseAgentDefinition(content, agentsDir);
}
