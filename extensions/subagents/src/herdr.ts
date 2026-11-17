// Subagents as interactive pi panes in herdr.
//
// Each subagent is a real `pi` in an hc terminal, shown as a pane in a
// "subagents" tab of the parent's herdr space. Definitions come from
// ~/.pi/agent/agents/*.md and, in trusted projects, <cwd>/.pi/agents/*.md.
// Everything about a run lives in <cwd>/.pi/subagents/<id>/: the pi session,
// system-prompt.md and meta.json.
//
//   subagent tool          run one or several (blocking or background), or
//                          send a follow-up to one that is still working
//   /subagent check [id]   reopen a subagent's session in a pane

import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadSubagentsEnabled } from "./config.js";

const TAB = "subagents";
const DEFAULT_TIMEOUT_S = 1800;
// Marks a pi as one of our subagents. Deliberately not PI_SUBAGENT_CHILD, which also makes the
// mutation extension skip its approval prompts: these subagents have a pane and can ask.
const CHILD_ENV = "PI_HERDR_SUBAGENT";

type Status = "running" | "done" | "blocked" | "error" | "timeout" | "interrupted" | "exited" | "killed";

interface Agent {
  name: string;
  description: string;
  flags: string[];
  prompt: string;
  promptFlag: string;
  timeout: number;
}

interface Rec {
  id: string;
  title: string;
  agent: string;
  task: string;
  status: Status;
  created: number;
  terminal?: string;
  result?: string;
}

const NOTES: Partial<Record<Status, string>> = {
  blocked: "It is waiting on the user in its pane (a dialog or a question). Tell the user; its result arrives as a message once they answer.",
  error: "Its pane is still open for inspection.",
  timeout: "Stopped waiting for it; it is still running in its pane.",
  interrupted: "Its pane is still open.",
  exited: "Its pi process ended before finishing a turn.",
  killed: "It was ended when the parent session closed.",
};

function loadAgents(cwd: string, trusted: boolean): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  // Project definitions carry prompts and tool lists, so only trusted projects add theirs.
  const dirs = [path.join(getAgentDir(), "agents"), ...(trusted ? [path.join(cwd, ".pi", "agents")] : [])];
  for (const dir of dirs) {
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!file.endsWith(".md")) continue;
      let fm: Record<string, any>;
      let body: string;
      try {
        ({ frontmatter: fm, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), "utf8")));
      } catch {
        continue;
      }
      const name = String(fm.name ?? path.basename(file, ".md"));
      agents.delete(name);
      if (fm.enabled === false) continue;
      const tools = Array.isArray(fm.tools) ? fm.tools.join(",") : fm.tools;
      agents.set(name, {
        name,
        description: String(fm.description ?? ""),
        flags: [
          ...(fm.model ? ["--model", String(fm.model)] : []),
          ...(fm.thinking ? ["--thinking", String(fm.thinking)] : []),
          ...(tools ? ["--tools", String(tools).replace(/\s+/g, "")] : []),
          ...(fm.inheritProjectContext === false ? ["-nc"] : []),
          ...(fm.inheritSkills === false || fm.skills === false ? ["-ns"] : []),
          ...(fm.inheritExtensions === false || fm.extensions === false ? ["-ne"] : []),
          ...extraArgs(fm, dir),
        ],
        prompt: body.trim(),
        promptFlag: String(fm.systemPromptMode).toLowerCase() === "append" ? "--append-system-prompt" : "--system-prompt",
        timeout: typeof fm.timeout === "number" ? fm.timeout : DEFAULT_TIMEOUT_S,
      });
    }
  }
  return agents;
}

/** Literal pi flags from frontmatter; paths resolve against `dir` (agents dir), `~/` against HOME. */
function extraArgs(fm: Record<string, any>, dir: string): string[] {
  const raw = Array.isArray(fm.extraArgs) ? fm.extraArgs : typeof fm.extraArgs === "string" ? [fm.extraArgs] : [];
  const home = process.env.HOME ?? "";
  return raw.flatMap((item) => String(item).split(/\s+/).filter(Boolean)).map((arg) =>
    arg.startsWith("~/") && home
      ? path.join(home, arg.slice(2))
      : arg.startsWith("./") || arg.startsWith("../")
        ? path.resolve(dir, arg)
        : arg,
  );
}

function age(created: number): string {
  const m = Math.round((Date.now() - created) / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

const line = (r: Rec) => `${r.title} · ${r.agent} · ${r.status} · ${age(r.created)} · ${r.id}`;

function report(r: Rec): string {
  const note = NOTES[r.status] ? `\n${NOTES[r.status]}` : "";
  const label = r.status === "done" ? "" : "Last output:\n";
  return `Subagent "${r.title}" (${r.agent}, id ${r.id}): ${r.status}${note}${r.result ? `\n\n${label}${r.result}` : ""}`;
}

export default function (pi: ExtensionAPI) {
  const me = process.env.HC_TERMINAL_ID ?? "";
  // Outside herdr there is nowhere to put panes; inside a subagent (either kind), no nesting.
  if (!me || process.env[CHILD_ENV] === "1" || process.env.PI_SUBAGENT_CHILD === "1") return;
  // `subagents.enabled: false` in settings.json keeps the whole extension off.
  if (!loadSubagentsEnabled()) return;

  let cwd = "";
  let closed = false;
  const open = new Map<string, Rec>(); // terminals this session started and has not ended

  const root = () => path.join(cwd || process.cwd(), ".pi", TAB);
  const dirOf = (id: string) => path.join(root(), id);

  function save(rec: Rec): void {
    fs.writeFileSync(path.join(dirOf(rec.id), "meta.json"), JSON.stringify(rec, null, 2));
  }

  function load(id: string): Rec | undefined {
    if (!/^[a-z0-9_-]+$/.test(id)) return undefined; // ids come from the model: keep them inside root()
    try {
      return JSON.parse(fs.readFileSync(path.join(dirOf(id), "meta.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  function list(): Rec[] {
    const ids = fs.existsSync(root()) ? fs.readdirSync(root()) : [];
    return ids.map(load).filter((r): r is Rec => !!r).sort((a, b) => b.created - a.created);
  }

  function sessionFile(id: string): string | undefined {
    const file = fs.readdirSync(dirOf(id)).filter((f) => f.endsWith(".jsonl")).sort().pop();
    return file && path.join(dirOf(id), file);
  }

  /** The subagent's answer: its last assistant message that has text. */
  function lastText(id: string): string {
    const file = sessionFile(id);
    const lines = file ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
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

  async function run(cmd: string, args: string[]): Promise<any> {
    const r = await pi.exec(cmd, args);
    if (r.code !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
    return JSON.parse(r.stdout);
  }

  // Subagents have no pane: they float over the tab when they need the user, or when clicked in the agents list.
  const focus = (terminal: string) => pi.exec("herdr-app", ["do", "terminal.peek", "--terminal", terminal]);

  async function close(terminal: string): Promise<void> {
    await pi.exec("hc", ["kill", terminal]);
    await pi.exec("hc", ["rm", terminal]);
    open.delete(terminal);
  }

  // No herdr.space/herdr.tab labels: herdr lists it under its parent (this terminal) without a pane.
  async function openPane(name: string, piArgs: string[]): Promise<string> {
    const { address } = await run("hc", [
      "run", "--bg", "--json", "--no-notify", "--name", name, "--cwd", cwd, "--parent", me,
      // Yolo keeps the mutation extension's hard blocks (protected paths, catastrophic shell) but
      // skips its approval dialogs, which nobody answers in an unattended subagent.
      "--", "env", `${CHILD_ENV}=1`, "PI_PERMISSION_PROFILE=yolo", "pi", ...piArgs,
    ]);
    return address as string;
  }

  /**
   * pi arguments for a subagent, for its first run and for /subagent check. Rebuilt from the agent
   * definition each time: meta.json sits in the project, so nothing read from it may become argv.
   */
  function piArgs(id: string, agent: Agent | undefined, trusted: boolean): string[] {
    // The child gets the trust the parent has, so it never stops on a trust dialog.
    const args = ["--session-dir", dirOf(id), trusted ? "-a" : "-na", ...(agent?.flags ?? [])];
    if (agent?.prompt) {
      const file = path.join(dirOf(id), "system-prompt.md");
      fs.writeFileSync(file, agent.prompt);
      args.push(agent.promptFlag, file);
    }
    return args;
  }

  async function spawn(agent: Agent, title: string, task: string, trusted: boolean): Promise<Rec> {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 27) || "subagent";
    const id = `${slug}-${randomBytes(2).toString("hex")}`; // hc names: a-z 0-9 - _, at most 32
    fs.mkdirSync(dirOf(id), { recursive: true });
    fs.writeFileSync(path.join(root(), ".gitignore"), "*\n"); // transcripts stay out of git
    const rec: Rec = { id, title, agent: agent.name, task, status: "running", created: Date.now() };
    save(rec);
    // pi reads a leading @ as a file attachment.
    const args = [...piArgs(id, agent, trusted), "--name", title, "--", task.replace(/^@/, "Task: @")];
    rec.terminal = await openPane(id, args);
    open.set(rec.terminal, rec);
    save(rec);
    return rec;
  }

  /**
   * Wait for the subagent's turn to end, then record the outcome and close or surface its pane.
   * `patient` waits through dialogs instead of returning "blocked" at the first one.
   */
  async function watch(rec: Rec, timeoutS: number, signal?: AbortSignal, patient = false): Promise<Rec> {
    const terminal = rec.terminal!;
    const deadline = Date.now() + timeoutS * 1000;
    let status: Status;
    let asking = false;
    for (;;) {
      const t = await run("hc", ["get", terminal]).catch(() => undefined);
      const state = t?.status?.state;
      if (t?.state !== "live") status = "exited";
      else if (state === "blocked" && patient && !closed) {
        if (!asking) await focus(terminal); // once per dialog
        asking = true;
        await sleep(2000);
        continue;
      } else if (state === "blocked" || state === "error") status = state;
      else if (t.turn > 0 && state !== "working") status = state === "done" ? "done" : "interrupted";
      else if (signal?.aborted) {
        await pi.exec("hc", ["interrupt", terminal]);
        status = "interrupted";
      } else if (Date.now() > deadline) status = "timeout";
      else {
        asking = false;
        // hc wait returns at once while pi is still booting (idle, turn 0), hence the pause.
        await pi.exec("hc", ["wait", terminal, "--timeout", "60"], { signal });
        await sleep(1000);
        continue;
      }
      break;
    }
    if (closed) return rec; // session_shutdown owns the cleanup now

    rec.status = status;
    rec.result = lastText(rec.id);
    if (status === "done" || status === "exited") {
      // A pi that died on startup (bad model, bad flag) leaves its reason on screen.
      if (!rec.result) rec.result = (await pi.exec("hc", ["read", terminal])).stdout.trim().split("\n").slice(-15).join("\n");
      await close(terminal);
    } else if (status !== "interrupted") {
      await focus(terminal);
    }
    save(rec);
    return rec;
  }

  /**
   * Hand a subagent's outcome to the parent as a message. The first dialog it stops on is reported;
   * after that (`patient`) it is followed quietly to its end.
   */
  function deliver(rec: Rec, timeoutS: number, patient = false): void {
    void (async () => {
      const out = await watch(rec, timeoutS, undefined, patient).catch((e): Rec => ({ ...rec, status: "error", result: String(e) }));
      if (closed) return;
      pi.sendMessage({ customType: "subagent", content: report(out), display: true, details: out }, { triggerTurn: true });
      if (out.status === "blocked") deliver(rec, timeoutS, true);
    })().catch(() => undefined);
  }

  const text = (t: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text: t }], details });

  pi.on("session_start", (_event, ctx) => {
    closed = false;
    if (cwd) return;
    cwd = ctx.cwd;
    const agents = [...loadAgents(cwd, ctx.isProjectTrusted()).values()];

    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        `Delegate work to subagents: separate interactive pi sessions with their own context, each visible to the user ` +
        `under this agent in herdr's agents list, floating over the tab when it needs them. Run one with agent + title + task, or several in parallel with tasks. ` +
        `By default the call blocks and returns each subagent's final answer. With background: true it returns ids at once ` +
        `and each answer arrives later as a message. action "send" passes a follow-up to a background subagent that is ` +
        `still working.\n\nAgents:\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`,
      promptSnippet: "Delegate a task to a subagent running in its own herdr terminal",
      promptGuidelines: [
        "Give every subagent a short, human-readable title: the user browses subagents by title.",
        "After starting a subagent with background: true, do not wait or poll: its result arrives as a message.",
      ],
      parameters: Type.Object({
        action: Type.Optional(StringEnum(["run", "send"] as const, { description: 'Default "run"' })),
        agent: Type.Optional(Type.String({ description: "Agent name (run)" })),
        title: Type.Optional(Type.String({ description: "Short title shown to the user, e.g. \"Find auth entry points\" (run)" })),
        task: Type.Optional(Type.String({ description: "Full task; the subagent sees nothing else of this conversation (run)" })),
        tasks: Type.Optional(
          Type.Array(Type.Object({ agent: Type.String(), title: Type.String(), task: Type.String() }), {
            description: "Several subagents in parallel, instead of agent/title/task",
          }),
        ),
        background: Type.Optional(Type.Boolean({ description: "Return at once; results arrive as messages" })),
        id: Type.Optional(Type.String({ description: "Subagent id (send)" })),
        message: Type.Optional(Type.String({ description: "Follow-up text (send)" })),
      }),

      async execute(_toolCallId, p, signal, onUpdate, ctx) {
        if (p.action === "send") {
          const rec = load(p.id ?? "");
          if (!rec) throw new Error(`No subagent with id "${p.id}".`);
          if (!p.message?.trim()) throw new Error("send needs a message.");
          if (!rec.terminal || !open.has(rec.terminal)) return text(report(rec));
          // --if working: never start a fresh turn in a subagent that is about to be closed.
          let sent = await pi.exec("hc", ["send", "--if", "working", "--", rec.terminal, p.message]);
          // hc refuses input while pi is still booting ("unavailable"): nothing was typed, so retrying is safe.
          for (let i = 0; i < 15 && sent.code !== 0 && sent.stderr.includes('"unavailable"') && !signal?.aborted; i++) {
            await sleep(2000);
            sent = await pi.exec("hc", ["send", "--if", "working", "--", rec.terminal, p.message]);
          }
          return text(sent.code === 0 ? `Sent to ${rec.id}.` : `Not delivered to ${rec.id}: ${sent.stderr.trim()}`);
        }

        const tasks = p.tasks?.length ? p.tasks : [{ agent: p.agent ?? "", title: p.title ?? "", task: p.task ?? "" }];
        const trusted = ctx.isProjectTrusted();
        const defs = loadAgents(ctx.cwd, trusted);
        for (const t of tasks) {
          if (!t.title.trim() || !t.task.trim()) throw new Error("Each subagent needs an agent, a title and a task.");
          if (!defs.has(t.agent)) throw new Error(`Unknown agent "${t.agent}". Available: ${[...defs.keys()].join(", ")}`);
        }

        const recs: Rec[] = [];
        for (const t of tasks) recs.push(await spawn(defs.get(t.agent)!, t.title.trim(), t.task, trusted));
        const timeout = (r: Rec) => defs.get(r.agent)!.timeout;
        const details = () => ({ runs: recs.map(({ id, title, agent, status }) => ({ id, title, agent, status })) });
        const started = recs.map((r) => `- ${r.id} (${r.agent}): ${r.title}`).join("\n");

        if (p.background) {
          for (const r of recs) deliver(r, timeout(r));
          return text(`Started in the background:\n${started}\nEach result arrives as a message when it finishes.`, details());
        }

        onUpdate?.(text(`Running:\n${started}`, details()));
        const done = await Promise.all(recs.map((r) => watch(r, timeout(r), signal)));
        for (const r of done) if (r.status === "blocked") deliver(r, timeout(r), true);
        return text(done.map(report).join("\n\n---\n\n"), details());
      },
    });
  });

  pi.registerCommand("subagent", {
    description: "Reopen a subagent's session in a pane: /subagent check [id]",
    getArgumentCompletions: (prefix) => {
      const q = prefix.replace(/^check\s*/, "").toLowerCase();
      const items = list()
        .filter((r) => r.id.includes(q) || r.title.toLowerCase().includes(q))
        .map((r) => ({ value: `check ${r.id}`, label: r.title, description: line(r) }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      let id = args.trim().replace(/^check\s*/, "");
      if (!id) {
        const recs = list();
        if (!recs.length) return ctx.ui.notify(`No subagents in ${root()}`, "info");
        const lines = recs.map(line);
        const pick = await ctx.ui.select("Subagents", lines);
        if (!pick) return;
        id = recs[lines.indexOf(pick)].id;
      }
      const rec = load(id);
      if (!rec) return ctx.ui.notify(`No subagent "${id}"`, "error");
      try {
        const live = await run("hc", ["get", id]).catch(() => undefined);
        let terminal: string = live?.address;
        if (live?.state !== "live") {
          const file = sessionFile(id);
          if (!file) return ctx.ui.notify(`"${rec.title}" saved no session: ${rec.result ?? rec.status}`, "warning");
          const trusted = ctx.isProjectTrusted();
          const agent = loadAgents(ctx.cwd, trusted).get(rec.agent);
          terminal = await openPane(id, [...piArgs(id, agent, trusted), "--session", file]);
          open.set(terminal, rec); // closes with the parent, like any other subagent pane
          await pi.exec("hc", ["wait", terminal, "--timeout", "20"]); // until pi is up, so herdr can focus it
        }
        await focus(terminal);
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      }
    },
  });

  // hc ends children with the parent *terminal*, which is the shell around pi, not pi itself.
  pi.on("session_shutdown", async () => {
    closed = true;
    await Promise.allSettled(
      [...open].map(async ([terminal, rec]) => {
        await close(terminal);
        if (rec.status === "running") save({ ...rec, status: "killed" });
      }),
    );
  });
}
