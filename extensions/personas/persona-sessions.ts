import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PersonaDefinition } from "./persona-definition-parser.js";
import { sessionSettingsArgs } from "./persona-session-args.js";

// Persona sessions: long-lived forked pi sessions in paneless hc terminals (ADR 0010).
// shortcut: hc plumbing (run/get/wait/send/read, last assistant text) is copied from
// extensions/subagents/src/herdr.ts; extract a shared module when a third caller appears.

export const PERSONA_REPLY_CUSTOM_TYPE = "persona-reply";
const SPAWN_SELECTED = "Spawn selected";
const NEEDS_HERDR = "Persona sessions need herdr (HC_TERMINAL_ID is not set).";

export interface LiveSession {
  persona: string;
  id: string;
  terminal: string;
  dir: string;
  /** hc turn counter up to which replies have been delivered. */
  deliveredTurn: number;
  watching: boolean;
}

export interface PersonaSessionsOptions {
  /** The main session's hc terminal (HC_TERMINAL_ID); empty means not inside herdr. */
  terminalId: string;
  /** Pause between hc polls. */
  pollMs: number;
}

export function createPersonaSessions(pi: ExtensionAPI, options: PersonaSessionsOptions) {
  const live = new Map<string, LiveSession>();

  async function hcJson(args: string[]): Promise<any> {
    const r = await pi.exec("hc", args);
    if (r.code !== 0) throw new Error(`hc ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
    return JSON.parse(r.stdout);
  }

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
    const slug = persona.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 27) || "persona";
    const id = `${slug}-${randomBytes(2).toString("hex")}`; // hc names: a-z 0-9 - _, at most 32
    const root = join(ctx.cwd, ".pi", "persona-sessions");
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "*\n"); // transcripts stay out of git
    const { address } = await hcJson([
      "run", "--bg", "--json", "--no-notify", "--name", id, "--cwd", ctx.cwd, "--parent", options.terminalId,
      "--", "env", "PI_PERMISSION_PROFILE=yolo", `PI_PERSONA_SESSION=${persona.name}`,
      "pi", "--fork", forkFrom, "--session-dir", dir, ctx.isProjectTrusted() ? "-a" : "-na",
      ...sessionSettingsArgs(persona),
    ]);
    live.set(persona.name, { persona: persona.name, id, terminal: address, dir, deliveredTurn: 0, watching: false });
  }

  async function sendTo(name: string, message: string, ctx: ExtensionCommandContext): Promise<void> {
    if (needsHerdr(ctx)) return;
    const session = live.get(name);
    if (!session) {
      const names = [...live.keys()].join(", ");
      return ctx.ui.notify(`No live Persona session "${name}". Live: ${names || "(none)"}`, "warning");
    }
    const text = message.trim() || (await ctx.ui.input(`Message to ${name}`))?.trim();
    if (!text) return;
    // No --if: a persona mid-turn takes the message as a steer.
    let sent = await pi.exec("hc", ["send", "--", session.terminal, text]);
    // hc refuses input while pi is still booting ("unavailable"): nothing was typed, so retrying is safe.
    for (let i = 0; i < 15 && sent.code !== 0 && sent.stderr.includes('"unavailable"'); i++) {
      await sleep(options.pollMs * 2);
      sent = await pi.exec("hc", ["send", "--", session.terminal, text]);
    }
    if (sent.code !== 0) return ctx.ui.notify(`Not delivered to ${name}: ${sent.stderr.trim()}`, "warning");
    if (!session.watching) {
      session.watching = true;
      void watch(session).catch(() => undefined).finally(() => (session.watching = false));
    }
  }

  /** Deliver a reply for every turn that ends, until the persona goes quiet, exits, or is killed. */
  async function watch(session: LiveSession): Promise<void> {
    let asking = false;
    while (live.get(session.persona) === session) {
      const t = await hcJson(["get", session.terminal]).catch(() => undefined);
      if (live.get(session.persona) !== session) return;
      if (t?.state !== "live") return exited(session);
      const state = t.status?.state;
      if (t.turn > session.deliveredTurn) {
        session.deliveredTurn = t.turn;
        reply(session, lastText(session.dir) || "(no text reply)");
        if (state !== "working") return;
        continue;
      }
      if (state === "blocked") {
        if (!asking) await pi.exec("herdr-app", ["do", "terminal.peek", "--terminal", session.terminal]);
        asking = true;
      } else {
        asking = false;
        await pi.exec("hc", ["wait", session.terminal, "--timeout", "60"]);
      }
      await sleep(options.pollMs);
    }
  }

  async function exited(session: LiveSession): Promise<void> {
    live.delete(session.persona);
    const screen = (await pi.exec("hc", ["read", session.terminal])).stdout.trim().split("\n").slice(-15).join("\n");
    await pi.exec("hc", ["rm", session.terminal]);
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

  return { live, spawn, sendTo };
}

/** The persona's answer: the last assistant message with text in its session file. */
function lastText(dir: string): string {
  const file = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().pop() : undefined;
  const lines = file ? readFileSync(join(dir, file), "utf8").trim().split("\n") : [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(lines[i]).message;
      if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      const text = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (text) return text;
    } catch {
      // a half-written last line
    }
  }
  return "";
}

function label(persona: PersonaDefinition): string {
  return persona.description ? `${persona.name} — ${persona.description}` : persona.name;
}
