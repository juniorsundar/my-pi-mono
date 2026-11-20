import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler), exec };
  followExtension(pi as any);
  return { handlers, exec, calls: () => exec.mock.calls as unknown as [string, string[], { timeout?: number }][] };
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

describe("follow: when it stays out of the way", () => {
  it("registers nothing without NV_SOCKET", () => {
    vi.stubEnv("NV_SOCKET", "");
    const loaded = load({});
    expect(loaded.handlers.size).toBe(0);
  });

  it.each([
    ["a headless subagent", { PI_SUBAGENT_CHILD: "1" }],
    ["a herdr subagent", { PI_HERDR_SUBAGENT: "1" }],
    ["a Persona session", { PI_PERSONA_SESSION: "mentor" }],
  ])("registers nothing in %s, which inherits NV_SOCKET but is not the main session", (_name, env) => {
    const loaded = load({ NV_SOCKET: SOCKET, ...env });
    expect(loaded.handlers.size).toBe(0);
  });
});

// The one test that needs a real Companion Editor: it checks the Lua nvim evaluates, which the
// tests above cannot see. Skipped where nvim is not installed.
const hasNvim = spawnSync("nvim", ["--version"]).status === 0;
describe.skipIf(!hasNvim)("follow: against a real nvim", () => {
  it("reloads the file and puts the cursor on the changed spot", async () => {
    const cwd = tempDir();
    const socket = join(cwd, "nv.sock");
    const file = join(cwd, "real.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    const nvim = spawn("nvim", ["--headless", "--clean", "--listen", socket, file], { stdio: "ignore" });
    try {
      const run = (args: string[]) => spawnSync("nvim", ["--server", socket, ...args], { encoding: "utf8" });
      await vi.waitFor(() => expect(run(["--remote-expr", "1"]).status).toBe(0), { timeout: 5000 });

      const exec = async (cmd: string, args: string[]) => {
        const r = spawnSync(cmd, args, { encoding: "utf8" });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, killed: false };
      };
      const loaded = load({ NV_SOCKET: socket }, exec as any);
      await runTool(loaded, cwd, "edit", { path: "real.txt" }, () => writeFileSync(file, "one\ntwo CHANGED\nthree\n"));

      await vi.waitFor(() => expect(run(["--remote-expr", "getline(2) . '@' . line('.') . ':' . col('.')"]).stdout.trim()).toBe("two CHANGED@2:4"));
    } finally {
      nvim.kill();
    }
  });
});
