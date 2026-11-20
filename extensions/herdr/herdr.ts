// Herdr Terminals: a `pi` in a paneless hc terminal listed under the main agent (CONTEXT.md).
// The one place in this repo that builds `hc` and `herdr-app` argv. Not an extension (no index.ts):
// subagents and Persona sessions import it and keep their own wait loops.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type Exec = ExtensionAPI["exec"];

export interface StartPiOptions {
  /** hc terminal name: a-z 0-9 - _, at most 32. */
  name: string;
  cwd: string;
  /** The main session's hc terminal (HC_TERMINAL_ID). */
  parent: string;
  env: Record<string, string>;
  piArgs: string[];
}

export interface TerminalState {
  live: boolean;
  /** hc's turn counter: how many pi turns have ended. */
  turn: number;
  /** pi's status as hc reports it: "idle", "working", "blocked", "done", "error"… */
  status: string | undefined;
}

export interface HerdrTerminal {
  address: string;
  /** undefined when hc get fails: one failure is not proof the terminal ended. */
  state(): Promise<TerminalState | undefined>;
  wait(timeoutS: number, signal?: AbortSignal): Promise<void>;
  /**
   * Type text into pi. `ifWorking` refuses unless pi is mid-turn (never starts a fresh turn);
   * without it a working pi takes the text as a steer.
   */
  send(text: string, options?: { ifWorking?: boolean; signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }>;
  /** Float the terminal over the tab so the user sees it. */
  peek(): Promise<void>;
  interrupt(): Promise<void>;
  /** The last `lines` lines on the terminal's screen. */
  screenTail(lines?: number): Promise<string>;
  /** Kill and remove: for a terminal that may still be running. */
  close(): Promise<void>;
  /** Remove only: for a terminal that has already ended. */
  remove(): Promise<void>;
}

export interface HerdrOptions {
  /** Pause between send retries while pi boots. */
  retryMs?: number;
}

export type Herdr = ReturnType<typeof createHerdr>;

export function createHerdr(exec: Exec, { retryMs = 2000 }: HerdrOptions = {}) {
  async function hcJson(args: string[]): Promise<any> {
    const r = await exec("hc", args);
    if (r.code !== 0) throw new Error(`hc ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
    return JSON.parse(r.stdout);
  }

  async function startPi(o: StartPiOptions): Promise<HerdrTerminal> {
    const { address } = await hcJson([
      "run", "--bg", "--json", "--no-notify", "--name", o.name, "--cwd", o.cwd, "--parent", o.parent,
      // hc starts programs with herdr's own PATH, which may lack hc, ~/.local/bin and the project's dev shell.
      "--", "env", `PATH=${process.env.PATH ?? ""}`, ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`),
      "pi", ...o.piArgs,
    ]);
    return terminal(address);
  }

  function terminal(address: string): HerdrTerminal {
    return {
      address,
      async state() {
        const t = await hcJson(["get", address]).catch(() => undefined);
        return t && { live: t.state === "live", turn: t.turn ?? 0, status: t.status?.state };
      },
      async wait(timeoutS, signal) {
        await exec("hc", ["wait", address, "--timeout", String(timeoutS)], { signal });
      },
      async send(text, { ifWorking = false, signal } = {}) {
        const args = ["send", ...(ifWorking ? ["--if", "working"] : []), "--", address, text];
        let sent = await exec("hc", args);
        // hc refuses input while pi is still booting ("unavailable"): nothing was typed, so retrying is safe.
        for (let i = 0; i < 15 && sent.code !== 0 && sent.stderr.includes('"unavailable"') && !signal?.aborted; i++) {
          await sleep(retryMs);
          sent = await exec("hc", args);
        }
        return sent.code === 0 ? { ok: true } : { ok: false, error: sent.stderr.trim() };
      },
      async peek() {
        await exec("herdr-app", ["do", "terminal.peek", "--terminal", address]);
      },
      async interrupt() {
        await exec("hc", ["interrupt", address]);
      },
      async screenTail(lines = 15) {
        return (await exec("hc", ["read", address])).stdout.trim().split("\n").slice(-lines).join("\n");
      },
      async close() {
        await exec("hc", ["kill", address]);
        await exec("hc", ["rm", address]);
      },
      async remove() {
        await exec("hc", ["rm", address]);
      },
    };
  }

  /** The existing terminal called `name` (any state), or undefined if hc knows none. */
  async function find(name: string): Promise<HerdrTerminal | undefined> {
    const t = await hcJson(["get", name]).catch(() => undefined);
    return t?.address ? terminal(t.address) : undefined;
  }

  return { startPi, find };
}

/**
 * A fresh run folder `<root>/<id>` for a Herdr Terminal's pi session. The id doubles as the hc
 * terminal name: the name slugged to 27 characters plus 4 hex (hc names: a-z 0-9 - _, at most 32).
 */
export function newRunDir(root: string, name: string, fallback = "run"): { id: string; dir: string } {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 27) || fallback;
  const id = `${slug}-${randomBytes(2).toString("hex")}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "*\n"); // transcripts stay out of git
  return { id, dir };
}

/** The last assistant message with text in the newest pi session file in `dir`; "" if none. */
export function lastText(dir: string): string {
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

/** Definition settings that become pi flags: shared by agent definitions and Persona Session settings. */
export interface PiSettings {
  model?: string;
  thinking?: string;
  /** Comma-joined tool list without whitespace: pi's --tools format. */
  tools?: string;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  inheritExtensions?: boolean;
  /** Shorthand for inheritExtensions: `extensions: false` adds -ne. */
  extensions?: boolean;
  /** Literal pi args, unresolved. */
  extraArgs: string[];
}

/** pi flags for `settings`; in extraArgs `./` and `../` resolve against `dir`, `~/` against HOME. */
export function piFlags(settings: PiSettings, dir: string): string[] {
  const home = process.env.HOME ?? "";
  return [
    ...(settings.model ? ["--model", settings.model] : []),
    ...(settings.thinking ? ["--thinking", settings.thinking] : []),
    ...(settings.tools ? ["--tools", settings.tools] : []),
    ...(settings.inheritProjectContext === false ? ["-nc"] : []),
    ...(settings.inheritSkills === false ? ["-ns"] : []),
    ...(settings.inheritExtensions === false || settings.extensions === false ? ["-ne"] : []),
    ...settings.extraArgs
      .flatMap((item) => item.split(/\s+/).filter(Boolean))
      .map((arg) =>
        arg.startsWith("~/") && home
          ? join(home, arg.slice(2))
          : arg.startsWith("./") || arg.startsWith("../")
            ? resolve(dir, arg)
            : arg,
      ),
  ];
}
