import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import followExtension from "./index.js";

const SOCKET = "/run/user/1000/nv-t1.sock";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "follow-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake pi: records handlers and the nvim calls the extension makes through exec.
function load(env: Record<string, string> = { NV_SOCKET: SOCKET }, exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false }))) {
  // Isolate from the env of whatever session runs the tests (a subagent or Persona session would
  // otherwise make the extension inert).
  for (const key of ["PI_SUBAGENT_CHILD", "PI_HERDR_SUBAGENT", "PI_PERSONA_SESSION"]) vi.stubEnv(key, "");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const renderers = new Map<string, (entry: any, options: any, theme: any) => { render(width: number): string[] } | undefined>();
  const entries: { customType: string; data: any }[] = [];
  // No sendMessage here on purpose: a Change Summary sent as a message would reach the model.
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerEntryRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    exec,
  };
  followExtension(pi as any);
  return { handlers, commands, renderers, entries, exec, calls: () => exec.mock.calls as unknown as [string, string[], { timeout?: number }][] };
}

// Plays one tool call: tool_call, the tool changing the file on disk, then tool_result.
async function runTool(
  loaded: ReturnType<typeof load>,
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  change: () => void,
  isError = false,
) {
  const ctx = { cwd };
  await loaded.handlers.get("tool_call")?.({ type: "tool_call", toolName, toolCallId: "c1", input }, ctx);
  change();
  await loaded.handlers.get("tool_result")?.({ type: "tool_result", toolName, toolCallId: "c1", input, isError, content: [] }, ctx);
}

/** The line/col/path the extension sent to nvim, decoded from the --remote-expr argument. */
function jumps(loaded: ReturnType<typeof load>): { path: string; line: number; col: number }[] {
  return loaded
    .calls()
    .filter(([cmd]) => cmd === "nvim")
    .map(([, args]) => {
      const payload = args[3].match(/json_decode\('(.*)'\)\)$/s)![1].replace(/''/g, "'");
      return JSON.parse(payload);
    });
}

const settled = (loaded: ReturnType<typeof load>, count: number) => vi.waitFor(() => expect(loaded.calls().length).toBeGreaterThanOrEqual(count));
const idle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("follow: where the Companion Editor jumps", () => {
  it("jumps to the line and 0-based byte column of an edit in the middle of a line", async () => {
    const cwd = tempDir();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "alpha\nbeta gamma\ndelta\n");
    const loaded = load();
    await runTool(loaded, cwd, "edit", { path: "a.txt", edits: [{ oldText: "gamma", newText: "GAMMA" }] }, () =>
      writeFileSync(file, "alpha\nbeta GAMMA\ndelta\n"),
    );
    await settled(loaded, 1);
    expect(jumps(loaded)).toEqual([{ path: file, line: 2, col: 5 }]);
  });

  it("counts the column in bytes, not characters", async () => {
    const cwd = tempDir();
    const file = join(cwd, "u.txt");
    writeFileSync(file, "héllo wörld\n");
    const loaded = load();
    await runTool(loaded, cwd, "edit", { path: "u.txt" }, () => writeFileSync(file, "héllo world\n"));
    await settled(loaded, 1);
    // "héllo w" is 8 bytes: é takes two.
    expect(jumps(loaded)).toEqual([{ path: file, line: 1, col: 8 }]);
  });

  it("jumps to the first changed line when write overwrites an existing file", async () => {
    const cwd = tempDir();
    const file = join(cwd, "w.txt");
    writeFileSync(file, "one\ntwo\n");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: file, content: "one\nTWO\nthree\n" }, () => writeFileSync(file, "one\nTWO\nthree\n"));
    await settled(loaded, 1);
    expect(jumps(loaded)).toEqual([{ path: file, line: 2, col: 0 }]);
  });

  it("jumps to the top of a file that write creates", async () => {
    const cwd = tempDir();
    const file = join(cwd, "new.txt");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "new.txt", content: "hello\n" }, () => writeFileSync(file, "hello\n"));
    await settled(loaded, 1);
    expect(jumps(loaded)).toEqual([{ path: file, line: 1, col: 0 }]);
  });

  it("jumps to the end of the old text when a change only appends", async () => {
    const cwd = tempDir();
    const file = join(cwd, "app.txt");
    writeFileSync(file, "a\nb");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "app.txt" }, () => writeFileSync(file, "a\nb\nc"));
    await settled(loaded, 1);
    expect(jumps(loaded)).toEqual([{ path: file, line: 2, col: 1 }]);
  });

  it("does not move when the file ends up unchanged", async () => {
    const cwd = tempDir();
    const file = join(cwd, "same.txt");
    writeFileSync(file, "same\n");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "same.txt" }, () => writeFileSync(file, "same\n"));
    await idle();
    expect(loaded.calls()).toHaveLength(0);
  });

  it("does not move when the tool call failed or was blocked", async () => {
    const cwd = tempDir();
    const file = join(cwd, "f.txt");
    writeFileSync(file, "before\n");
    const loaded = load();
    await runTool(loaded, cwd, "edit", { path: "f.txt" }, () => writeFileSync(file, "after\n"), true);
    await idle();
    expect(loaded.calls()).toHaveLength(0);
  });

  it("forgets a blocked call, which pi ends without any tool_result", async () => {
    const cwd = tempDir();
    const file = join(cwd, "blocked.txt");
    writeFileSync(file, "before\n");
    const loaded = load();
    const ctx = { cwd };
    await loaded.handlers.get("tool_call")?.({ type: "tool_call", toolName: "write", toolCallId: "c9", input: { path: "blocked.txt" } }, ctx);
    await loaded.handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "c9", toolName: "write", isError: true }, ctx);
    writeFileSync(file, "changed by someone else\n");
    // Were the snapshot kept, this stray result for the same id would jump to the change.
    await loaded.handlers.get("tool_result")?.({ type: "tool_result", toolName: "write", toolCallId: "c9", input: {}, isError: false, content: [] }, ctx);
    await idle();
    expect(loaded.calls()).toHaveLength(0);
  });

  it("ignores tools other than edit and write", async () => {
    const cwd = tempDir();
    const file = join(cwd, "g.txt");
    writeFileSync(file, "x\n");
    const loaded = load();
    await runTool(loaded, cwd, "bash", { command: "echo y > g.txt" }, () => writeFileSync(file, "y\n"));
    await runTool(loaded, cwd, "read", { path: "g.txt" }, () => writeFileSync(file, "z\n"));
    await idle();
    expect(loaded.calls()).toHaveLength(0);
  });
});

describe("follow: talking to the Companion Editor", () => {
  it("runs nvim against NV_SOCKET and gives up after one second", async () => {
    const cwd = tempDir();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "a\n");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "a.txt" }, () => writeFileSync(file, "b\n"));
    await settled(loaded, 1);
    const [cmd, args, options] = loaded.calls()[0];
    expect(cmd).toBe("nvim");
    expect(args.slice(0, 3)).toEqual(["--server", SOCKET, "--remote-expr"]);
    expect(options).toEqual({ timeout: 1000 });
  });

  it("survives a path with quotes and backslashes", async () => {
    const cwd = tempDir();
    const file = join(cwd, "it's a \\ file.txt");
    writeFileSync(file, "a\n");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: file }, () => writeFileSync(file, "b\n"));
    await settled(loaded, 1);
    expect(jumps(loaded)[0].path).toBe(file);
  });

  it("stays silent when nvim cannot be reached", async () => {
    const cwd = tempDir();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "a\n");
    const failing = vi.fn(async () => {
      throw new Error("E247: no registered server");
    });
    const loaded = load({ NV_SOCKET: SOCKET }, failing as any);
    await expect(runTool(loaded, cwd, "write", { path: "a.txt" }, () => writeFileSync(file, "b\n"))).resolves.toBeUndefined();
    await settled(loaded, 1);
    await idle(); // an unhandled rejection would fail the run
  });

  it("sends jumps in the order the changes happened", async () => {
    const cwd = tempDir();
    const file = join(cwd, "a.txt");
    writeFileSync(file, "1\n2\n3\n");
    const order: number[] = [];
    const slowFirst = vi.fn(async (_cmd: string, args: string[]) => {
      const line = JSON.parse(args[3].match(/json_decode\('(.*)'\)\)$/s)![1]).line;
      if (order.length === 0) await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(line);
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    const loaded = load({ NV_SOCKET: SOCKET }, slowFirst as any);
    await runTool(loaded, cwd, "write", { path: "a.txt" }, () => writeFileSync(file, "1\nX\n3\n"));
    await runTool(loaded, cwd, "write", { path: "a.txt" }, () => writeFileSync(file, "1\nX\n3\nY\n"));
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual([2, 4]);
  });
});

/** Runs /follow and returns what it told the user. */
async function slashFollow(loaded: ReturnType<typeof load>): Promise<string[]> {
  const notify = vi.fn();
  await loaded.commands.get("follow")!.handler("", { ui: { notify } });
  return notify.mock.calls.map(([message]) => message as string);
}

describe("follow: the /follow toggle", () => {
  it("turns Follow Mode off and back on, saying which state it is in", async () => {
    const cwd = tempDir();
    const file = join(cwd, "t.txt");
    writeFileSync(file, "a\n");
    const loaded = load();

    expect(await slashFollow(loaded)).toEqual([expect.stringMatching(/\boff\b/i)]);
    await runTool(loaded, cwd, "write", { path: "t.txt" }, () => writeFileSync(file, "b\n"));
    await idle();
    expect(loaded.calls()).toHaveLength(0); // off: no jump

    expect(await slashFollow(loaded)).toEqual([expect.stringMatching(/\bon\b/i)]);
    await runTool(loaded, cwd, "write", { path: "t.txt" }, () => writeFileSync(file, "c\n"));
    await settled(loaded, 1);
    expect(jumps(loaded)).toEqual([{ path: file, line: 1, col: 0 }]); // on again
  });

  it("does not jump for a call that was already running when it was turned off", async () => {
    const cwd = tempDir();
    const file = join(cwd, "t.txt");
    writeFileSync(file, "a\n");
    const loaded = load();
    const ctx = { cwd };
    await loaded.handlers.get("tool_call")?.({ type: "tool_call", toolName: "write", toolCallId: "c1", input: { path: "t.txt" } }, ctx);
    await slashFollow(loaded); // off
    writeFileSync(file, "b\n");
    await loaded.handlers.get("tool_result")?.({ type: "tool_result", toolName: "write", toolCallId: "c1", input: {}, isError: false, content: [] }, ctx);
    await idle();
    expect(loaded.calls()).toHaveLength(0);
  });

  it("explains that there is no Companion Editor, and enables nothing, without NV_SOCKET", async () => {
    const loaded = load({ NV_SOCKET: "" });
    const [message, ...rest] = await slashFollow(loaded);
    expect(message).toContain("Companion Editor");
    expect(message).toContain("NV_SOCKET");
    expect(rest).toEqual([]);
    expect(loaded.handlers.size).toBe(0); // still no event handlers, so nothing can follow
    await slashFollow(loaded); // asking again changes nothing
    expect(loaded.handlers.size).toBe(0);
    expect(loaded.calls()).toHaveLength(0);
  });
});

// The run ends: pi fires agent_settled once nothing is left to retry, compact or continue.
const endRun = (loaded: ReturnType<typeof load>, cwd: string) => loaded.handlers.get("agent_settled")?.({ type: "agent_settled" }, { cwd });
const summaries = (loaded: ReturnType<typeof load>) => loaded.entries.filter((e) => e.customType === "follow-changes").map((e) => e.data.files);

describe("follow: the Change Summary", () => {
  it("lists every file the run changed, in the order they were first changed, marked added or modified", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "old.txt"), "one\n");
    const loaded = load();
    await runTool(loaded, cwd, "edit", { path: "old.txt" }, () => writeFileSync(join(cwd, "old.txt"), "ONE\n"));
    await runTool(loaded, cwd, "write", { path: "new.txt" }, () => writeFileSync(join(cwd, "new.txt"), "hi\n"));
    await endRun(loaded, cwd);
    expect(summaries(loaded)).toEqual([[
      { path: "old.txt", added: false },
      { path: "new.txt", added: true },
    ]]);
  });

  it("lists a file changed several times once, and a file the run created stays added", async () => {
    const cwd = tempDir();
    const file = join(cwd, "twice.txt");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "twice.txt" }, () => writeFileSync(file, "a\n"));
    await runTool(loaded, cwd, "edit", { path: "twice.txt" }, () => writeFileSync(file, "b\n"));
    await endRun(loaded, cwd);
    expect(summaries(loaded)).toEqual([[{ path: "twice.txt", added: true }]]);
  });

  it("shows only what the latest run changed, and a file added in an earlier run is modified now", async () => {
    const cwd = tempDir();
    const file = join(cwd, "f.txt");
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "f.txt" }, () => writeFileSync(file, "a\n"));
    await endRun(loaded, cwd);
    await runTool(loaded, cwd, "edit", { path: "f.txt" }, () => writeFileSync(file, "b\n"));
    await endRun(loaded, cwd);
    expect(summaries(loaded)).toEqual([[{ path: "f.txt", added: true }], [{ path: "f.txt", added: false }]]);
  });

  it("shows nothing for a run that changed nothing: no calls, failed calls, or a write that left the file as it was", async () => {
    const cwd = tempDir();
    const file = join(cwd, "same.txt");
    writeFileSync(file, "same\n");
    const loaded = load();
    await endRun(loaded, cwd);
    await runTool(loaded, cwd, "edit", { path: "same.txt" }, () => writeFileSync(file, "x\n"), true);
    await runTool(loaded, cwd, "write", { path: "same.txt" }, () => writeFileSync(file, "x\n"));
    await endRun(loaded, cwd);
    expect(loaded.entries).toEqual([]);
  });

  it("forgets a blocked call", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "b.txt"), "a\n");
    const loaded = load();
    await loaded.handlers.get("tool_call")?.({ type: "tool_call", toolName: "write", toolCallId: "c5", input: { path: "b.txt" } }, { cwd });
    await loaded.handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "c5", toolName: "write", isError: true }, { cwd });
    await endRun(loaded, cwd);
    expect(loaded.entries).toEqual([]);
  });

  it("still records with /follow off, and sends no jump", async () => {
    const cwd = tempDir();
    const file = join(cwd, "off.txt");
    writeFileSync(file, "a\n");
    const loaded = load();
    await slashFollow(loaded); // off
    await runTool(loaded, cwd, "write", { path: "off.txt" }, () => writeFileSync(file, "b\n"));
    await endRun(loaded, cwd);
    await idle();
    expect(summaries(loaded)).toEqual([[{ path: "off.txt", added: false }]]);
    expect(loaded.calls()).toHaveLength(0);
  });

  it("shows a path relative to where pi started, and the full path for a file outside it", async () => {
    const cwd = tempDir();
    const outside = join(tempDir(), "elsewhere.txt");
    mkdirSync(join(cwd, "src"));
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "src/in.txt" }, () => writeFileSync(join(cwd, "src", "in.txt"), "a\n"));
    await runTool(loaded, cwd, "write", { path: outside }, () => writeFileSync(outside, "a\n"));
    await endRun(loaded, cwd);
    expect(summaries(loaded)).toEqual([[
      { path: join("src", "in.txt"), added: true },
      { path: outside, added: true },
    ]]);
  });

  it("starts empty when a new session starts", async () => {
    const cwd = tempDir();
    const loaded = load();
    await runTool(loaded, cwd, "write", { path: "s.txt" }, () => writeFileSync(join(cwd, "s.txt"), "a\n"));
    await loaded.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, { cwd });
    await endRun(loaded, cwd);
    expect(loaded.entries).toEqual([]);
  });

  it("renders as a block naming each file, how it changed, and how to open it", () => {
    const loaded = load();
    const render = loaded.renderers.get("follow-changes")!;
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
    const block = render({ type: "custom", customType: "follow-changes", data: { files: [{ path: "a.ts", added: false }, { path: "dir/b.ts", added: true }] } }, { expanded: false }, theme)!;
    const lines = block.render(80).map((line) => line.trim()).filter(Boolean);
    expect(lines[0]).toBe("Changed files");
    expect(lines[1]).toMatch(/^modified\s+a\.ts$/);
    expect(lines[2]).toMatch(/^added\s+dir\/b\.ts$/);
    expect(lines[3]).toContain("/changes");
    expect(render({ type: "custom", customType: "follow-changes", data: { files: [] } }, { expanded: false }, theme)).toBeUndefined();
  });
});

describe("follow: when it stays out of the way", () => {

  it.each([
    ["a headless subagent", { PI_SUBAGENT_CHILD: "1" }],
    ["a herdr subagent", { PI_HERDR_SUBAGENT: "1" }],
    ["a Persona session", { PI_PERSONA_SESSION: "mentor" }],
  ])("registers nothing in %s, which inherits NV_SOCKET but is not the main session", (_name, env) => {
    const loaded = load({ NV_SOCKET: SOCKET, ...env });
    expect(loaded.handlers.size).toBe(0);
    expect(loaded.commands.size).toBe(0);
  });
});

// These need a real Companion Editor: they check the Lua nvim evaluates, which the tests above
// cannot see. Skipped where nvim is not installed.
const hasNvim = spawnSync("nvim", ["--version"]).status === 0;

/** A headless nvim on a socket, plus the extension wired to it through the real nvim client. */
async function withNvim(files: Record<string, string>, body: (t: RealNvim) => Promise<void>) {
  const cwd = tempDir();
  const socket = join(cwd, "nv.sock");
  const paths = Object.entries(files).map(([name, text]) => {
    const path = join(cwd, name);
    writeFileSync(path, text);
    return path;
  });
  const nvim = spawn("nvim", ["--headless", "--clean", "--listen", socket, ...paths.slice(0, 1)], { stdio: "ignore" });
  const server = (args: string[]) => spawnSync("nvim", ["--server", socket, ...args], { encoding: "utf8" });
  try {
    await vi.waitFor(() => expect(server(["--remote-expr", "1"]).status).toBe(0), { timeout: 5000 });
    let finished = 0;
    const exec = async (cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      finished++;
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, killed: false };
    };
    const loaded = load({ NV_SOCKET: socket }, exec as any);
    await body({
      cwd,
      paths,
      expr: (e) => server(["--remote-expr", e]).stdout.trim(),
      send: (keys) => void server(["--remote-send", keys]),
      // Changes `name` on disk as an edit would, and waits until the jump has been sent.
      edit: async (name, text) => {
        const before = finished;
        await runTool(loaded, cwd, "edit", { path: name }, () => writeFileSync(join(cwd, name), text));
        await vi.waitFor(() => expect(finished).toBe(before + 1));
      },
    });
  } finally {
    nvim.kill();
  }
}

interface RealNvim {
  cwd: string;
  paths: string[];
  expr(e: string): string;
  send(keys: string): void;
  edit(name: string, text: string): Promise<void>;
}

describe.skipIf(!hasNvim)("follow: against a real nvim", () => {
  it("reloads the file and puts the cursor on the changed spot", async () => {
    await withNvim({ "real.txt": "one\ntwo\nthree\n" }, async (nvim) => {
      await nvim.edit("real.txt", "one\ntwo CHANGED\nthree\n");
      expect(nvim.expr("getline(2) . '@' . line('.') . ':' . col('.')")).toBe("two CHANGED@2:4");
    });
  });

  it.each([
    ["insert", "i"],
    ["insert after CTRL-O", "i<C-o>"],
    ["replace", "R"],
    ["command-line", ":"],
  ])("does not move while the user is in %s mode", async (_mode, keys) => {
    await withNvim({ "typing.txt": "one\ntwo\nthree\n" }, async (nvim) => {
      nvim.send(keys);
      const mode = nvim.expr("mode()");
      await nvim.edit("typing.txt", "one\ntwo\nTHREE\n");
      expect(nvim.expr("mode()")).toBe(mode); // still typing
      expect(nvim.expr("line('.')")).toBe("1"); // cursor not pulled away
      expect(nvim.expr("getline(3)")).toBe("three"); // file not reloaded under them
    });
  });

  it("neither reloads nor moves a buffer with unsaved changes, and warns", async () => {
    await withNvim({ "dirty.txt": "one\ntwo\nthree\n" }, async (nvim) => {
      nvim.send("ggOunsaved line<Esc>");
      expect(nvim.expr("&modified")).toBe("1");
      await nvim.edit("dirty.txt", "one\ntwo\nTHREE\n");
      expect(nvim.expr("getline(1)")).toBe("unsaved line");
      expect(nvim.expr("&modified")).toBe("1");
      expect(nvim.expr("line('.')")).toBe("1");
      expect(nvim.expr("execute('messages')")).toContain("unsaved changes");
    });
  });

  it("uses the window that already shows the file, leaving the user's current window alone", async () => {
    await withNvim({ "a.txt": "a1\na2\na3\n", "b.txt": "b1\n" }, async (nvim) => {
      nvim.send(":vsplit b.txt<CR>"); // current window shows b.txt, the other shows a.txt
      expect(nvim.expr("expand('%:t') . ':' . winnr('$')")).toBe("b.txt:2");
      await nvim.edit("a.txt", "a1\na2\nA3\n");
      expect(nvim.expr("expand('%:t') . ':' . winnr('$')")).toBe("b.txt:2"); // same window, no new one
      const aWindow = nvim.expr("win_findbuf(bufnr('a.txt'))[0]");
      expect(nvim.expr(`getcurpos(${aWindow})[1] . ':' . getbufline('a.txt', 3)[0]`)).toBe("3:A3"); // moved, and reloaded
    });
  });

  it("loads the file into the current window when only another tab shows it", async () => {
    await withNvim({ "a.txt": "a1\na2\n", "b.txt": "b1\n" }, async (nvim) => {
      nvim.send(":tabnew b.txt<CR>");
      expect(nvim.expr("tabpagenr()")).toBe("2");
      await nvim.edit("a.txt", "a1\nA2\n");
      expect(nvim.expr("tabpagenr() . ':' . expand('%:t') . ':' . line('.')")).toBe("2:a.txt:2");
    });
  });
});
