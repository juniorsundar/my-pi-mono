import {
  formatSkillsForPrompt,
  type BeforeAgentStartEvent,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import type { PersonaDefinition } from "./persona-definition-parser.js";
import {
  resolvePersonas,
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
  // Session-scoped: a replace-mode switch is confirmed at most once per session,
  // re-armed by session_start unless the session restores a replace persona.
  let replaceModeConfirmed = false;

  async function switchToPersona(persona: PersonaDefinition, ctx: ExtensionCommandContext): Promise<void> {
    if (persona.systemPromptMode === "replace" && !replaceModeConfirmed) {
      const confirmed = await ctx.ui.confirm(
        "Replace pi's built-in prompt?",
        `Switching to "${persona.name}" replaces pi's built-in prompt — its tool guidance is lost. Project context and skills stay attached.`,
      );
      // A run may have started while the dialog was open; the confirmation is
      // not spent unless the switch actually applies.
      if (!confirmed || !(await ensureIdle(ctx))) return;
      replaceModeConfirmed = true;
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
    if (!ctx.hasUI) {
      ctx.ui.notify(listPersonasMessage(valid, failed), "info");
      return;
    }
    // Invalid definitions render as disabled entries between the valid personas
    // and the Default entry; selecting one reports the parse error instead of switching.
    const options = [
      ...valid.map(personaLabel),
      ...failed.map(failedPersonaLabel),
      DEFAULT_PICKER_LABEL,
    ];
    const choice = await ctx.ui.select("Switch persona", options);
    if (choice === undefined) return;
    const index = options.indexOf(choice);
    if (index === -1) return;
    // The Default entry sits last, so a persona whose label collides with it
    // wins the first match and can never be mistaken for the clear action.
    if (index === valid.length + failed.length) {
      if (!(await ensureIdle(ctx))) return;
      clearActivePersona(ctx);
      return;
    }
    const failedEntry = failed[index - valid.length];
    if (failedEntry) {
      ctx.ui.notify(parseErrorMessage(failedEntry), "warning");
      return;
    }
    if (!(await ensureIdle(ctx))) return;
    await switchToPersona(valid[index], ctx);
  }

  pi.registerCommand("persona", {
    description: "Switch the active persona: /persona [<name>|off|default|none]",
    handler: async (args, ctx) => {
      if (!(await ensureIdle(ctx))) return;

      const input = args.trim();
      const { validPersonas, failedPersonas } = resolvePersonas(options, ctx.cwd);

      if (DEFAULT_ALIASES.has(input.toLowerCase())) {
        clearActivePersona(ctx);
        return;
      }

      if (!input) {
        await openPicker(validPersonas, failedPersonas, ctx);
        return;
      }

      const match = validPersonas.find((persona) => persona.name === input);
      if (match) {
        await switchToPersona(match, ctx);
        return;
      }

      const failedMatch = failedPersonas.find((entry) => basename(entry.fileName, ".md") === input);
      if (failedMatch) {
        ctx.ui.notify(parseErrorMessage(failedMatch), "warning");
        return;
      }

      const available = validPersonas.map((persona) => persona.name).join(", ");
      ctx.ui.notify(`Unknown persona "${input}". Available: ${available || "(none)"}`, "warning");
    },
  });

  // Restoring must not re-emit the switch notice — it is already part of the
  // restored session context from the original switch.
  pi.on("session_start", async (_event, ctx) => {
    replaceModeConfirmed = false;
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
      const { validPersonas } = resolvePersonas(options, ctx.cwd);
      const persona = validPersonas.find((candidate) => candidate.name === savedName);
      if (persona) {
        activePersona = persona;
        // The session already established this persona, so replace mode is
        // considered confirmed for the resumed session.
        if (persona.systemPromptMode === "replace") replaceModeConfirmed = true;
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
    return { systemPrompt: composeSystemPrompt(event, activePersona) };
  });
}

function appendModePrompt(builtInPrompt: string, persona: PersonaDefinition): string {
  return persona.body ? `${builtInPrompt}\n\n${persona.body}` : builtInPrompt;
}

// Mirrors pi's custom-prompt composition: the persona body stands in for the
// built-in prompt while the append prompt, project context, skills, and cwd still attach.
function replaceModePrompt(body: string, options: BuildSystemPromptOptions): string {
  let prompt = body;
  if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path, content } of contextFiles) {
      prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }
  const skills = options.skills ?? [];
  if ((!options.selectedTools || options.selectedTools.includes("read")) && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }
  return `${prompt}\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}`;
}

function composeSystemPrompt(event: BeforeAgentStartEvent, persona: PersonaDefinition): string {
  if (persona.systemPromptMode === "replace") {
    return replaceModePrompt(persona.body, event.systemPromptOptions);
  }
  return appendModePrompt(event.systemPrompt, persona);
}

function personaLabel(persona: PersonaDefinition): string {
  return persona.description ? `${persona.name} — ${persona.description}` : persona.name;
}

function failedPersonaLabel(entry: FailedPersona): string {
  return `${entry.fileName} — ${entry.error}`;
}

function parseErrorMessage(entry: FailedPersona): string {
  return `Persona definition ${entry.fileName} failed to parse: ${entry.error}`;
}

function listPersonasMessage(valid: PersonaDefinition[], failed: FailedPersona[]): string {
  const lines = valid.map((persona) => `- ${personaLabel(persona)}`);
  lines.push(...failed.map((entry) => `- ${entry.fileName}: ${entry.error}`));
  const body = lines.join("\n");
  return body ? `Available personas:\n${body}` : "No persona definitions found.";
}