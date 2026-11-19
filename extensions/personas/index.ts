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
  projectPersonasDir,
  resolvePersonas,
  type FailedPersona,
  type PersonaDirectories,
} from "./persona-store.js";
import { createPersonaSessions, USER_MESSAGE_PREFIX } from "./persona-sessions.js";

export type PersonasExtensionOptions = PersonaDirectories & {
  /** Persona session marker (PI_PERSONA_SESSION): set when this process is a spawned Persona session. */
  personaSession?: string;
  /** The main session's hc terminal (HC_TERMINAL_ID); empty means not inside herdr. */
  terminalId?: string;
  /** Pause between hc polls while waiting for a Persona session's reply. */
  pollMs?: number;
};

const PERSONA_STATUS_KEY = "persona";
const PERSONA_STATE_CUSTOM_TYPE = "personas-state";
const PERSONA_SWITCH_NOTICE_CUSTOM_TYPE = "personas-switch-notice";
const DEFAULT_SWITCH_NOTICE = "Persona switched: default — pi's built-in prompt";
const DEFAULT_ALIASES = new Set(["off", "default", "none"]);
const DEFAULT_PICKER_LABEL = "Default — pi's built-in prompt";
const REJECTED_MESSAGE = "Persona switch rejected: the agent is still running.";
const PERSONA_SESSION_COMMAND_NOTICE = "This is a Persona session — /persona is unavailable.";

export default function personasExtension(
  pi: ExtensionAPI,
  options: PersonasExtensionOptions = {},
) {
  // Active persona: zero or one. The definition is snapshotted at switch time
  // so per-turn prompt application never touches the disk.
  let activePersona: PersonaDefinition | undefined;
  // A Persona session is fixed to the persona named by the marker: it never
  // restores the fork's persona state and refuses /persona, so personas cannot nest.
  const personaSession = options.personaSession ?? process.env.PI_PERSONA_SESSION;
  // Session-scoped: a replace-mode switch is confirmed at most once per session,
  // re-armed by session_start unless the session restores a replace persona.
  let replaceModeConfirmed = false;
  const sessions = createPersonaSessions(pi, {
    terminalId: options.terminalId ?? process.env.HC_TERMINAL_ID ?? "",
    pollMs: options.pollMs ?? 1000,
  });

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

  // Completions get no context, so the cwd for resolving persona names is captured at session start.
  let cwd = process.cwd();

  function completions(prefix: string) {
    if (personaSession) return null;
    const live = /^(send-to|kill)\s+(\S*)$/.exec(prefix);
    if (live) {
      const [, sub, partial] = live;
      // send-to keeps a trailing space so the message can be typed straight after.
      const items = sessions
        .liveNames()
        .filter((name) => name.startsWith(partial))
        .map((name) => ({ value: `${sub} ${name}${sub === "send-to" ? " " : ""}`, label: name }));
      return items.length ? items : null;
    }
    if (/\s/.test(prefix)) return null;
    const items = [
      { value: "spawn", label: "spawn", description: "Spawn Persona sessions" },
      { value: "send-to ", label: "send-to", description: "Message a live Persona session" },
      { value: "kill ", label: "kill", description: "End a live Persona session" },
      { value: "off", label: "off", description: DEFAULT_PICKER_LABEL },
      ...resolvePersonas(options, cwd).validPersonas.map((persona) => ({
        value: persona.name,
        label: persona.name,
        description: persona.description,
      })),
    ].filter((item) => item.value.startsWith(prefix));
    return items.length ? items : null;
  }

  pi.registerCommand("persona", {
    description: "Switch the active persona, or consult one as a Persona session: /persona [<name>|off|spawn|send-to <persona> [message]|kill <persona>]",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      if (personaSession) {
        ctx.ui.notify(PERSONA_SESSION_COMMAND_NOTICE, "warning");
        return;
      }
      const input = args.trim();

      // Persona session subcommands win over same-named personas and never wait for idle.
      if (input === "spawn") {
        const projectDir = options.projectDir ?? projectPersonasDir(ctx.cwd);
        // Session settings reach argv, so an untrusted project's personas are never spawned.
        const spawnable = resolvePersonas(options, ctx.cwd).validPersonas.filter(
          (persona) => ctx.isProjectTrusted() || persona.directory !== projectDir,
        );
        await sessions.spawn(spawnable, ctx);
        return;
      }
      const sendTo = /^send-to(?:\s+(\S+)\s*([\s\S]*))?$/.exec(input);
      if (sendTo) {
        if (!sendTo[1]) {
          ctx.ui.notify("Usage: /persona send-to <persona> [message]", "warning");
          return;
        }
        await sessions.sendTo(sendTo[1], sendTo[2], ctx);
        return;
      }
      const kill = /^kill(?:\s+(\S+))?$/.exec(input);
      if (kill) {
        if (!kill[1]) {
          ctx.ui.notify("Usage: /persona kill <persona>", "warning");
          return;
        }
        await sessions.kill(kill[1], ctx);
        return;
      }

      if (!(await ensureIdle(ctx))) return;
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
  pi.on("session_shutdown", async () => {
    await sessions.killAll();
  });

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    replaceModeConfirmed = false;
    if (personaSession) {
      const { validPersonas } = resolvePersonas(options, ctx.cwd);
      const persona = validPersonas.find((candidate) => candidate.name === personaSession);
      if (!persona) {
        activePersona = undefined;
        ctx.ui.setStatus(PERSONA_STATUS_KEY, undefined);
        ctx.ui.notify(
          `Persona session persona "${personaSession}" is no longer available — using pi's built-in prompt.`,
          "warning",
        );
        return;
      }
      // Activated directly: the fork's restored state is ignored, and there is
      // neither a replace-mode confirmation nor a switch notice.
      activePersona = persona;
      ctx.ui.setStatus(PERSONA_STATUS_KEY, `persona:${persona.name}`);
      return;
    }
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
    const prompt = composeSystemPrompt(event, activePersona);
    // The forked history is the main agent's; without this the persona carries on as the main agent.
    return { systemPrompt: personaSession ? `${prompt}\n\n${personaSessionIdentity(activePersona.name)}` : prompt };
  });
}

function personaSessionIdentity(name: string): string {
  return (
    `You are the ${name} Persona session: a separate pi forked from the main session's conversation. ` +
    "The conversation above is the main agent's work, not yours to continue or check. " +
    `The user consults you from the main session; their messages arrive prefixed "${USER_MESSAGE_PREFIX}". ` +
    `Reply to each one as ${name}, with your own view.`
  );
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