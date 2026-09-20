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
const PERSONA_STATE_CUSTOM_TYPE = "personas-state";
const PERSONA_SWITCH_NOTICE_CUSTOM_TYPE = "personas-switch-notice";
const DEFAULT_SWITCH_NOTICE = "Persona switched: default — pi's built-in prompt";
const DEFAULT_ALIASES = new Set(["off", "default", "none"]);
const DEFAULT_PICKER_LABEL = "Default — pi's built-in prompt";
const REJECTED_MESSAGE = "Persona switch rejected: the agent is still running.";

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

  function switchToPersona(persona: PersonaDefinition, ctx: ExtensionCommandContext): void {
    // Replace-mode switching ships with its confirmation flow in ticket 0063.
    if (persona.systemPromptMode === "replace") {
      ctx.ui.notify(
        `Persona "${persona.name}" uses replace mode, which is not supported yet.`,
        "warning",
      );
      return;
    }
    activePersona = persona;
    pi.appendEntry(PERSONA_STATE_CUSTOM_TYPE, { persona: persona.name });
    ctx.ui.setStatus(PERSONA_STATUS_KEY, `persona:${persona.name}`);
    ctx.ui.notify(`Switched to persona ${persona.name}.`, "info");
    pi.sendMessage({
      customType: PERSONA_SWITCH_NOTICE_CUSTOM_TYPE,
      content: `Persona switched: ${personaLabel(persona)}`,
      display: true,
    });
  }

  function clearActivePersona(ctx: ExtensionCommandContext): void {
    activePersona = undefined;
    pi.appendEntry(PERSONA_STATE_CUSTOM_TYPE, { persona: undefined });
    ctx.ui.setStatus(PERSONA_STATUS_KEY, undefined);
    ctx.ui.notify("Persona cleared — using pi's built-in prompt.", "info");
    pi.sendMessage({
      customType: PERSONA_SWITCH_NOTICE_CUSTOM_TYPE,
      content: DEFAULT_SWITCH_NOTICE,
      display: true,
    });
  }

  // Waiting first keeps the in-flight turn on its current prompt; the recheck
  // rejects when the run outlives the wait (or the wait was aborted).
  async function ensureIdle(ctx: ExtensionCommandContext): Promise<boolean> {
    if (ctx.isIdle()) return true;
    try {
      await ctx.waitForIdle();
    } catch {
      ctx.ui.notify(REJECTED_MESSAGE, "warning");
      return false;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify(REJECTED_MESSAGE, "warning");
      return false;
    }
    return true;
  }

  async function openPicker(
    valid: PersonaDefinition[],
    failed: FailedPersona[],
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    for (const entry of failed) {
      ctx.ui.notify(
        `Persona definition ${entry.fileName} failed to parse: ${entry.error}`,
        "warning",
      );
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(listPersonasMessage(valid, failed), "info");
      return;
    }
    const options = [...valid.map(personaLabel), DEFAULT_PICKER_LABEL];
    const choice = await ctx.ui.select("Switch persona", options);
    if (choice === undefined) return;
    if (!(await ensureIdle(ctx))) return;
    const index = options.indexOf(choice);
    if (index === -1) return;
    // The Default entry sits last, so a persona whose label collides with it
    // wins the first match and can never be mistaken for the clear action.
    if (index === valid.length) {
      clearActivePersona(ctx);
      return;
    }
    switchToPersona(valid[index], ctx);
  }

  pi.registerCommand("persona", {
    description: "Switch the active persona: /persona [<name>|off|default|none]",
    handler: async (args, ctx) => {
      if (!(await ensureIdle(ctx))) return;

      const input = args.trim();
      const loaded = loadPersonasFromDirectory(globalDir);
      const valid = loaded.filter(isValidPersona).map((entry) => entry.persona);
      const failed = loaded.filter(isFailedPersona);

      if (DEFAULT_ALIASES.has(input.toLowerCase())) {
        clearActivePersona(ctx);
        return;
      }

      if (!input) {
        await openPicker(valid, failed, ctx);
        return;
      }

      const match = valid.find((persona) => persona.name === input);
      if (match) {
        switchToPersona(match, ctx);
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

  // Restoring must not re-emit the switch notice — it is already part of the
  // restored session context from the original switch.
  pi.on("session_start", async (_event, ctx) => {
    const stateEntry = ctx.sessionManager
      .getEntries()
      .filter(
        (candidate) =>
          candidate.type === "custom" &&
          candidate.customType === PERSONA_STATE_CUSTOM_TYPE,
      )
      .pop() as { data?: { persona?: unknown } } | undefined;

    const savedName = stateEntry?.data?.persona;
    if (typeof savedName === "string") {
      const persona = loadPersonasFromDirectory(globalDir)
        .filter(isValidPersona)
        .map((entry) => entry.persona)
        .find((candidate) => candidate.name === savedName);
      if (persona) {
        activePersona = persona;
        ctx.ui.setStatus(PERSONA_STATUS_KEY, `persona:${persona.name}`);
        return;
      }
      ctx.ui.notify(
        `Saved persona "${savedName}" is no longer available — using pi's built-in prompt.`,
        "warning",
      );
    }
    activePersona = undefined;
    ctx.ui.setStatus(PERSONA_STATUS_KEY, undefined);
  });

  pi.on("before_agent_start", (event) => {
    if (!activePersona) return undefined;
    return { systemPrompt: composeSystemPrompt(event.systemPrompt, activePersona) };
  });
}

function personaLabel(persona: PersonaDefinition): string {
  return persona.description ? `${persona.name} — ${persona.description}` : persona.name;
}

function listPersonasMessage(valid: PersonaDefinition[], failed: FailedPersona[]): string {
  const lines = valid.map((persona) => `- ${personaLabel(persona)}`);
  lines.push(...failed.map((entry) => `- ${entry.fileName}: ${entry.error}`));
  const body = lines.join("\n");
  return body ? `Available personas:\n${body}` : "No persona definitions found.";
}