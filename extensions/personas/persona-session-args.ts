import { join, resolve } from "node:path";
import type { PersonaDefinition } from "./persona-definition-parser.js";

/**
 * pi flags for a Persona session's argv, built from the persona's Session settings.
 * Mirrors extensions/subagents/src/herdr.ts `loadAgents`/`extraArgs`: `./` and `../`
 * resolve against the definition's directory, `~/` against HOME.
 */
export function sessionSettingsArgs(persona: PersonaDefinition): string[] {
  const settings = persona.session;
  return [
    ...(settings.model ? ["--model", settings.model] : []),
    ...(settings.thinking ? ["--thinking", settings.thinking] : []),
    ...(settings.tools ? ["--tools", settings.tools] : []),
    ...(settings.inheritProjectContext === false ? ["-nc"] : []),
    ...(settings.inheritSkills === false ? ["-ns"] : []),
    ...(settings.inheritExtensions === false || settings.extensions === false ? ["-ne"] : []),
    ...resolveExtraArgs(settings.extraArgs, persona.directory),
  ];
}

/** Literal pi args: one arg per whitespace-separated token, with path prefixes resolved. */
function resolveExtraArgs(raw: string[], directory: string): string[] {
  const home = process.env.HOME ?? "";
  return raw
    .flatMap((item) => item.split(/\s+/).filter(Boolean))
    .map((arg) =>
      arg.startsWith("~/") && home
        ? join(home, arg.slice(2))
        : arg.startsWith("./") || arg.startsWith("../")
          ? resolve(directory, arg)
          : arg,
    );
}
