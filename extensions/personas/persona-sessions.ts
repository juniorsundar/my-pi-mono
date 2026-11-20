import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHerdr, lastText, newRunDir, piFlags, type Herdr, type HerdrTerminal } from "../herdr/herdr.js";
import type { PersonaDefinition } from "./persona-definition-parser.js";

// Persona sessions: long-lived forked pi sessions in Herdr Terminals (ADR 0010).

/** Marks a send-to message as the user's: hc itself only tags it with the sending terminal. */
export const USER_MESSAGE_PREFIX = "Message from the user in the main session:";
const PERSONA_REPLY_CUSTOM_TYPE = "persona-reply";
const SPAWN_SELECTED = "Spawn selected";
const NEEDS_HERDR = "Persona sessions need herdr (HC_TERMINAL_ID is not set).";

export interface LiveSession {
  persona: string;
  id: string;
  terminal: HerdrTerminal;
  dir: string;
  /** hc turn counter up to which replies have been delivered. */
  deliveredTurn: number;
}

export interface PersonaSessionsOptions {
  /** The main session's hc terminal (HC_TERMINAL_ID); empty means not inside herdr. */
  terminalId: string;
  /** Pause between hc polls. */
  pollMs: number;
  /** Defaults to the real herdr library over pi.exec. */
  herdr?: Herdr;
}

export function createPersonaSessions(pi: ExtensionAPI, options: PersonaSessionsOptions) {
  const live = new Map<string, LiveSession>();
  const herdr = options.herdr ?? createHerdr(pi.exec.bind(pi), { retryMs: options.pollMs * 2 });

  function needsHerdr(ctx: ExtensionCommandContext): boolean {
    if (options.terminalId) return false;
    ctx.ui.notify(NEEDS_HERDR, "warning");
    return true;
  }

  /** Repeated select: each pick toggles a ✓; the final entry spawns the selection. */
  async function pickPersonas(candidates: PersonaDefinition[], ctx: ExtensionCommandContext) {
    const selected = new Set<string>();
    for (;;) {
      const labels = candidates.map((p) => `${selected.has(p.name) ? "✓" : " "} ${label(p)}`);
      const choice = await ctx.ui.select("Spawn Persona sessions", [...labels, SPAWN_SELECTED]);
      if (choice === undefined) return [];
      if (choice === SPAWN_SELECTED) return candidates.filter((p) => selected.has(p.name));
      const picked = candidates[labels.indexOf(choice)];
      if (!picked) continue;
      if (selected.has(picked.name)) selected.delete(picked.name);
      else selected.add(picked.name);
    }
  }

  async function spawn(candidates: PersonaDefinition[], ctx: ExtensionCommandContext): Promise<void> {
    if (needsHerdr(ctx)) return;
    if (!candidates.length) return ctx.ui.notify("No personas available to spawn.", "info");
    const forkFrom = ctx.sessionManager.getSessionFile();
    if (!forkFrom) return ctx.ui.notify("This session is not saved, so it cannot be forked.", "warning");
    for (const persona of await pickPersonas(candidates, ctx)) {
      if (live.has(persona.name)) {
        ctx.ui.notify(`${persona.name} is already live — kill it first for a fresh fork.`, "info");
        continue;
      }
      try {
        await spawnOne(persona, forkFrom, ctx);
        ctx.ui.notify(`Spawned Persona session ${persona.name}.`, "info");
      } catch (e) {
        ctx.ui.notify(`Could not spawn ${persona.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
  }

  async function spawnOne(persona: PersonaDefinition, forkFrom: string, ctx: ExtensionCommandContext) {
    const { id, dir } = newRunDir(join(ctx.cwd, ".pi", "persona-sessions"), persona.name, "persona");
    const terminal = await herdr.startPi({
      name: id,
      cwd: ctx.cwd,
      parent: options.terminalId,
      env: { PI_PERMISSION_PROFILE: "yolo", PI_PERSONA_SESSION: persona.name },
      piArgs: [
        "--fork", forkFrom, "--session-dir", dir, ctx.isProjectTrusted() ? "-a" : "-na",
        ...piFlags(persona.session, persona.directory),
      ],
    });
    const session: LiveSession = { persona: persona.name, id, terminal, dir, deliveredTurn: 0 };
    live.set(persona.name, session);
    void watch(session).catch(() => undefined);
  }

  async function sendTo(name: string, message: string, ctx: ExtensionCommandContext): Promise<void> {
    if (needsHerdr(ctx)) return;
    const session = live.get(name);
    if (!session) {
      const names = [...live.keys()].join(", ");
      return ctx.ui.notify(`No live Persona session "${name}". Live: ${names || "(none)"}`, "warning");
    }
    const typed = message.trim() || (await ctx.ui.input(`Message to ${name}`))?.trim();
    if (!typed) return;
    // No ifWorking: a persona mid-turn takes the message as a steer.
    const sent = await session.terminal.send(`${USER_MESSAGE_PREFIX} ${typed}`);
    if (!sent.ok) ctx.ui.notify(`Not delivered to ${name}: ${sent.error}`, "warning");
  }

  async function kill(name: string, ctx: ExtensionCommandContext): Promise<void> {
    if (needsHerdr(ctx)) return;
    const session = live.get(name);
    if (!session) return ctx.ui.notify(`No live Persona session "${name}".`, "warning");
    await end(session);
    ctx.ui.notify(`Killed Persona session ${name}.`, "info");
  }

  /** Ends every live Persona session: they belong to this main session. */
  async function killAll(): Promise<void> {
    await Promise.allSettled([...live.values()].map(end));
  }

  // Leaving the live set first is what stops the watcher from delivering an in-flight reply.
  async function end(session: LiveSession): Promise<void> {
    live.delete(session.persona);
    await session.terminal.close();
  }

  /**
   * Watches a Persona session for its whole life: delivers a reply for every turn that ends
   * and reports the session if its terminal dies. Stops once it is killed or has exited.
   */
  async function watch(session: LiveSession): Promise<void> {
    let peeked = false;
    let misses = 0;
    while (live.get(session.persona) === session) {
      const t = await session.terminal.state();
      if (live.get(session.persona) !== session) return;
      // One failed hc call is not a dead terminal: only a reported end, or repeated failures.
      if (!t && ++misses < 3) {
        await sleep(options.pollMs);
        continue;
      }
      if (!t?.live) return exited(session);
      misses = 0;
      const state = t.status;
      if (t.turn > session.deliveredTurn) {
        session.deliveredTurn = t.turn;
        reply(session, lastText(session.dir) || "(no text reply)");
      }
      if (state === "blocked") {
        if (!peeked) await session.terminal.peek();
        peeked = true;
      } else {
        peeked = false;
        await session.terminal.wait(60);
      }
      await sleep(options.pollMs);
    }
  }

  async function exited(session: LiveSession): Promise<void> {
    live.delete(session.persona);
    const screen = await session.terminal.screenTail();
    await session.terminal.remove();
    reply(session, `${session.persona} exited.${screen ? `\n\n${screen}` : ""}`, false);
  }

  function reply(session: LiveSession, text: string, prefix = true): void {
    pi.sendMessage(
      {
        customType: PERSONA_REPLY_CUSTOM_TYPE,
        content: prefix ? `${session.persona}: ${text}` : text,
        display: true,
        details: { persona: session.persona, id: session.id },
      },
      { triggerTurn: false },
    );
  }

  return { liveNames: () => [...live.keys()], spawn, sendTo, kill, killAll };
}

function label(persona: PersonaDefinition): string {
  return persona.description ? `${persona.name} — ${persona.description}` : persona.name;
}
