import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeHerdr, type FakeTerminal } from "../../herdr/fake-herdr.js";

let agentDir = "";
vi.mock("@earendil-works/pi-coding-agent", async (orig) => ({ ...(await orig<object>()), getAgentDir: () => agentDir }));
vi.mock("../src/config.js", () => ({ loadSubagentsEnabled: () => true }));

import herdrSubagents from "../src/herdr.js";

let cwd = "";
beforeEach(() => {
  vi.stubEnv("HC_TERMINAL_ID", "t0");
  vi.stubEnv("PI_HERDR_SUBAGENT", "");
  vi.stubEnv("PI_SUBAGENT_CHILD", "");
  agentDir = mkdtempSync(join(tmpdir(), "subagents-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "subagents-cwd-"));
  mkdirSync(join(agentDir, "agents"));
  writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: does work\n---\nYou work.\n");
  writeFileSync(join(agentDir, "agents", "quick.md"), "---\nname: quick\ntimeout: 0\n---\n");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Loads the extension against the library fake; `setup` shapes each terminal as it starts. */
function load(setup: (t: FakeTerminal) => void) {
  const fake = createFakeHerdr();
  const herdr = {
    ...fake.herdr,
    async startPi(o: Parameters<typeof fake.herdr.startPi>[0]) {
      const handle = await fake.herdr.startPi(o);
      setup(fake.terminals.at(-1)!);
      return handle;
    },
  };
  const handlers: Record<string, (...a: any[]) => any> = {};
  let tool: any;
  const pi = {
    on: (event: string, fn: any) => (handlers[event] = fn),
    registerTool: (t: any) => (tool = t),
    registerCommand: () => {},
    sendMessage: vi.fn(),
  };
  herdrSubagents(pi as any, { herdr });
  const ctx = { cwd, isProjectTrusted: () => true };
  handlers.session_start({}, ctx);
  const run = async (agent: string) => {
    const out = await tool.execute("c1", { agent, title: "Do it", task: "the task" }, undefined, undefined, ctx);
    return { text: out.content[0].text as string, status: out.details.runs[0].status as string };
  };
  return { fake, run, shutdown: () => handlers.session_shutdown() };
}

const sessionDir = (t: FakeTerminal) => t.start.piArgs[t.start.piArgs.indexOf("--session-dir") + 1];

describe("watch", () => {
  it("a finished turn returns done with the last text and closes the terminal", async () => {
    const { fake, run } = load((t) => {
      Object.assign(t, { turn: 1, status: "done" });
      const msg = { message: { role: "assistant", content: [{ type: "text", text: "All done." }] } };
      writeFileSync(join(sessionDir(t), "s.jsonl"), JSON.stringify(msg) + "\n");
    });
    const out = await run("worker");
    expect(out.status).toBe("done");
    expect(out.text).toContain("All done.");
    expect(fake.callsOf("close")).toHaveLength(1);

    const start = fake.terminals[0].start;
    expect(start.env).toEqual({ PI_HERDR_SUBAGENT: "1", PI_PERMISSION_PROFILE: "yolo" });
    expect(start.parent).toBe("t0");
    expect(start.piArgs).toContain("--system-prompt");
    expect(start.piArgs.slice(-3)).toEqual(["Do it", "--", "the task"]);
  });

  it("a blocked dialog returns blocked and peeks", async () => {
    const { fake, run, shutdown } = load((t) => (t.status = "blocked"));
    const out = await run("worker");
    expect(out.status).toBe("blocked");
    expect(fake.callsOf("peek").length).toBeGreaterThan(0);
    expect(fake.callsOf("close")).toHaveLength(0);
    await shutdown(); // ends the patient follow-up
  });

  it("a timeout returns timeout and leaves the terminal open", async () => {
    const { fake, run, shutdown } = load(() => {});
    const out = await run("quick");
    expect(out.status).toBe("timeout");
    expect(fake.callsOf("close")).toHaveLength(0);
    await shutdown();
  });

  it("a pi that exits before its turn returns exited with the screen tail and closes the terminal", async () => {
    const { fake, run } = load((t) => Object.assign(t, { live: false, screen: "Error: unknown model" }));
    const out = await run("worker");
    expect(out.status).toBe("exited");
    expect(out.text).toContain("Error: unknown model");
    expect(fake.callsOf("close")).toHaveLength(1);
  });
});
