import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PersonaDefinition } from "./persona-definition-parser.js";
import {
  DEFAULT_GLOBAL_PERSONAS_DIR,
  isFailedPersona,
  isValidPersona,
  loadPersonasFromDirectory,
  personaFileNameStem,
  type FailedPersona,
  type PersonaDirectories,
} from "./persona-store.js";

export type PersonasExtensionOptions = PersonaDirectories;

const PERSONA_STATUS_KEY = "persona";

export default function personasExtension(
  pi: ExtensionAPI,
  options: PersonasExtensionOptions = {},
) {
  // Active persona: zero or one. The definition is snapshotted at switch time
  // so per-turn prompt application never touches the disk.
  let activePersona: PersonaDefinition | undefined;

  const globalDir = options.globalDir ?? DEFAULT_GLOBAL_PERSONAS_DIR;

  function composeSystemPrompt(builtInPrompt: string, persona: PersonaDefinition): string {
    return persona.body ? `${builtInPrompt}\n\n${persona.body}` : builtInPrompt;
  }

  function activate(persona: PersonaDefinition, ctx: ExtensionCommandContext): void {
    activePersona = persona;
    ctx.ui.setStatus(PERSONA_STATUS_KEY, `persona:${persona.name}`);
    ctx.ui.notify(`Switched to persona ${persona.name}.`, "info");
  }

  pi.registerCommand("persona", {
    description: "Switch the active persona: /persona <name>",
    handler: async (args, ctx) => {
      const input = args.trim();
      const loaded = loadPersonasFromDirectory(globalDir);
      const valid = loaded.filter(isValidPersona).map((entry) => entry.persona);
      const failed = loaded.filter(isFailedPersona);

      if (!input) {
        ctx.ui.notify(listPersonasMessage(valid, failed), "info");
        return;
      }

      const match = valid.find((persona) => persona.name === input);
      if (match) {
        // Replace-mode switching ships with its confirmation flow in ticket 0063.
        if (match.systemPromptMode === "replace") {
          ctx.ui.notify(
            `Persona "${match.name}" uses replace mode, which is not supported yet.`,
            "warning",
          );
          return;
        }
        activate(match, ctx);
        return;
      }

      const failedMatch = failed.find((entry) => personaFileNameStem(entry.fileName) === input);
      if (failedMatch) {
        ctx.ui.notify(
          `Persona definition ${failedMatch.fileName} failed to parse: ${failedMatch.error}`,
          "warning",
        );
        return;
      }

      const available = valid.map((persona) => persona.name).join(", ");
      ctx.ui.notify(`Unknown persona "${input}". Available: ${available || "(none)"}`, "warning");
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!activePersona) return undefined;
    return { systemPrompt: composeSystemPrompt(event.systemPrompt, activePersona) };
  });
}

function listPersonasMessage(valid: PersonaDefinition[], failed: FailedPersona[]): string {
  const lines = valid.map((persona) =>
    persona.description ? `- ${persona.name} — ${persona.description}` : `- ${persona.name}`,
  );
  lines.push(...failed.map((entry) => `- ${entry.fileName}: ${entry.error}`));
  const body = lines.join("\n");
  return body ? `Available personas:\n${body}` : "No persona definitions found.";
}