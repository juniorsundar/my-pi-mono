import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdr, lastText, newRunDir, piFlags } from "./herdr.js";

type Reply = { code?: number; stdout?: string; stderr?: string };

/** A fake pi.exec: records argv, answers from a per-subcommand script. */
function fakeExec(script: Record<string, Reply | Reply[]> = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async (cmd: string, args: string[], _options?: { signal?: AbortSignal }) => {
    calls.push([cmd, ...args]);
    const entry = script[`${cmd} ${args[0]}`];
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
    return { code: reply?.code ?? 0, stdout: reply?.stdout ?? "", stderr: reply?.stderr ?? "", killed: false };
  });
  return { exec, calls };
}

const RUN_OK = { stdout: JSON.stringify({ address: "t7" }) };

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("startPi", () => {
  it("runs pi in a paneless hc terminal under the parent, with PATH and extra env", async () => {
    vi.stubEnv("PATH", "/bin:/home/u/.local/bin");
    const { exec, calls } = fakeExec({ "hc run": RUN_OK });
    const terminal = await createHerdr(exec).startPi({
      name: "scout-ab12",
      cwd: "/repo",
      parent: "t1",
      env: { PI_PERMISSION_PROFILE: "yolo", PI_HERDR_SUBAGENT: "1" },
      piArgs: ["--session-dir", "/repo/.pi/x", "--", "do it"],
    });

    expect(terminal.address).toBe("t7");
    expect(calls).toEqual([[
      "hc", "run", "--bg", "--json", "--no-notify", "--name", "scout-ab12", "--cwd", "/repo", "--parent", "t1",
      "--", "env", "PATH=/bin:/home/u/.local/bin", "PI_PERMISSION_PROFILE=yolo", "PI_HERDR_SUBAGENT=1",
      "pi", "--session-dir", "/repo/.pi/x", "--", "do it",
    ]]);
  });

  it("throws with hc's stderr when hc run fails", async () => {
    const { exec } = fakeExec({ "hc run": { code: 1, stderr: "no such parent" } });
    await expect(
      createHerdr(exec).startPi({ name: "n", cwd: "/", parent: "t1", env: {}, piArgs: [] }),
    ).rejects.toThrow("hc run failed: no such parent");
  });
});

async function started(script: Record<string, Reply | Reply[]> = {}) {
  const fake = fakeExec({ "hc run": RUN_OK, ...script });
  const terminal = await createHerdr(fake.exec, { retryMs: 0 }).startPi({ name: "n", cwd: "/", parent: "t1", env: {}, piArgs: [] });
  fake.calls.length = 0;
  return { terminal, ...fake };
}

describe("terminal handle", () => {
  it("state() normalises hc get to live, turn and status", async () => {
    const { terminal, calls } = await started({
      "hc get": { stdout: JSON.stringify({ state: "live", turn: 2, status: { state: "blocked" } }) },
    });
    expect(await terminal.state()).toEqual({ live: true, turn: 2, status: "blocked" });
    expect(calls).toEqual([["hc", "get", "t7"]]);
  });

  it("state() reports an ended terminal as not live, and a failed hc get as undefined", async () => {
    const { terminal } = await started({
      "hc get": [{ stdout: JSON.stringify({ state: "finished", turn: 1 }) }, { code: 1, stderr: "socket hiccup" }],
    });
    expect(await terminal.state()).toEqual({ live: false, turn: 1, status: undefined });
    expect(await terminal.state()).toBeUndefined();
  });

  it("wait, peek and interrupt address the terminal", async () => {
    const { terminal, calls, exec } = await started();
    const signal = new AbortController().signal;
    await terminal.wait(60, signal);
    await terminal.peek();
    await terminal.interrupt();
    expect(calls).toEqual([
      ["hc", "wait", "t7", "--timeout", "60"],
      ["herdr-app", "do", "terminal.peek", "--terminal", "t7"],
      ["hc", "interrupt", "t7"],
    ]);
    expect(exec.mock.calls.find((c: any[]) => c[1][0] === "wait")![2]).toEqual({ signal });
  });

  it("screenTail() returns the last lines of hc read", async () => {
    const screen = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const { terminal, calls } = await started({ "hc read": { stdout: `${screen}\n\n` } });
    expect(await terminal.screenTail(3)).toBe("line 18\nline 19\nline 20");
    expect((await terminal.screenTail()).split("\n")).toHaveLength(15);
    expect(calls[0]).toEqual(["hc", "read", "t7"]);
  });

  it("send() types the text, with --if working only when asked", async () => {
    const { terminal, calls } = await started();
    expect(await terminal.send("steer this")).toEqual({ ok: true });
    expect(await terminal.send("follow-up", { ifWorking: true })).toEqual({ ok: true });
    expect(calls).toEqual([
      ["hc", "send", "--", "t7", "steer this"],
      ["hc", "send", "--if", "working", "--", "t7", "follow-up"],
    ]);
  });

  it("send() retries while pi is still booting, then delivers", async () => {
    const booting = { code: 1, stderr: 'error: "unavailable"' };
    const { terminal, calls } = await started({ "hc send": [booting, booting, {}] });
    expect(await terminal.send("hi")).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("send() gives up after 15 retries and reports hc's error", async () => {
    const { terminal, calls } = await started({ "hc send": { code: 1, stderr: 'error: "unavailable"' } });
    expect(await terminal.send("hi")).toEqual({ ok: false, error: 'error: "unavailable"' });
    expect(calls).toHaveLength(16);
  });

  it("send() does not retry other errors, nor after the signal aborts", async () => {
    const other = await started({ "hc send": { code: 1, stderr: "not working" } });
    expect(await other.terminal.send("hi", { ifWorking: true })).toEqual({ ok: false, error: "not working" });
    expect(other.calls).toHaveLength(1);

    const aborted = await started({ "hc send": { code: 1, stderr: 'error: "unavailable"' } });
    const controller = new AbortController();
    controller.abort();
    await aborted.terminal.send("hi", { signal: controller.signal });
    expect(aborted.calls).toHaveLength(1);
  });

  it("close() kills then removes; remove() only removes", async () => {
    const { terminal, calls } = await started();
    await terminal.close();
    await terminal.remove();
    expect(calls).toEqual([["hc", "kill", "t7"], ["hc", "rm", "t7"], ["hc", "rm", "t7"]]);
  });
});

describe("newRunDir", () => {
  it("makes an hc-safe id from the name and a git-ignored run folder", () => {
    const root = join(tempDir(), ".pi", "subagents");
    const { id, dir } = newRunDir(root, "Find Auth Entry-Points: in the whole API layer!");
    expect(id).toMatch(/^find-auth-entry-points-in-t-[0-9a-f]{4}$/);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(dir).toBe(join(root, id));
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("falls back to a default slug when the name has no usable characters", () => {
    expect(newRunDir(tempDir(), "!!!", "persona").id).toMatch(/^persona-[0-9a-f]{4}$/);
  });
});

describe("lastText", () => {
  const assistant = (text: string) =>
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
  const user = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "q" }] } });

  it("returns the last assistant text of the newest session file, skipping a half-written line", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "2026-01-01_a.jsonl"), `${assistant("old file")}\n`);
    writeFileSync(join(dir, "2026-01-02_b.jsonl"), `${assistant("first")}\n${assistant("answer")}\n${user}\n{"type":"mess`);
    expect(lastText(dir)).toBe("answer");
  });

  it("returns an empty string with no session file, no text, or no folder", () => {
    const dir = tempDir();
    expect(lastText(dir)).toBe("");
    writeFileSync(join(dir, "s.jsonl"), `${user}\n`);
    expect(lastText(dir)).toBe("");
    expect(lastText(join(dir, "missing"))).toBe("");
  });
});

describe("piFlags", () => {
  it("maps every setting to its pi flag", () => {
    expect(
      piFlags(
        {
          model: "anthropic/claude-x",
          thinking: "high",
          tools: "read,bash",
          inheritProjectContext: false,
          inheritSkills: false,
          inheritExtensions: false,
          extraArgs: [],
        },
        "/defs",
      ),
    ).toEqual(["--model", "anthropic/claude-x", "--thinking", "high", "--tools", "read,bash", "-nc", "-ns", "-ne"]);
  });

  it("adds nothing for unset or true settings, and -ne for extensions: false", () => {
    expect(piFlags({ inheritSkills: true, extraArgs: [] }, "/defs")).toEqual([]);
    expect(piFlags({ extensions: false, extraArgs: [] }, "/defs")).toEqual(["-ne"]);
  });

  it("splits extraArgs on whitespace and resolves ~/, ./ and ../", () => {
    vi.stubEnv("HOME", "/home/u");
    expect(piFlags({ extraArgs: ["-e ./ext.ts", "--skill ../skills/x", "-e ~/e.ts", "--flag  /abs"] }, "/defs/agents")).toEqual([
      "-e", "/defs/agents/ext.ts", "--skill", "/defs/skills/x", "-e", "/home/u/e.ts", "--flag", "/abs",
    ]);
  });
});
