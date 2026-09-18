import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mutationExtension from "./index.js";
import { setCurrentProfile } from "./permission-policy.js";

// The Neovim launch utilities are mocked at the seam shared with the bash
// approval tests. commandExists defaults to "nvim available"; individual
// tests override it.
const runNeovimWithArgsProcess = vi.fn(() => ({ status: 0 }));
const commandExists = vi.fn((command: string) => command === "nvim");

vi.mock("./neovim-approval-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    commandExists: (command: string) => commandExists(command),
    runNeovimWithArgsProcess: (options: unknown) => runNeovimWithArgsProcess(options),
  };
});

function makePi() {
  const handlers: Record<string, Function[]> = {};
  const commands: Array<{ name: string; definition: any }> = [];
  const pi = {
    on: (eventName: string, handler: Function) => {
      handlers[eventName] ??= [];
      handlers[eventName]!.push(handler);
    },
    registerCommand: (name: string, definition: any) => commands.push({ name, definition }),
    appendEntry: () => undefined,
  };
  return {
    pi: pi as any,
    handlers,
    commands,
  };
}

// Handler order in the canonical package:
//   [0] permission-profile guard, [1] edit/write guard, [2] bash approval.
const DIFF_HANDLER = 1;
const BASH_HANDLER = 2;

function makeInteractiveCtx(
  cwd: string,
  selectChoices: (string | undefined)[] = [],
  confirmResult?: boolean,
) {
  // Each select() call returns a promise. If a queued choice is available it
  // resolves immediately; otherwise the promise stays pending until
  // releaseSelect() is called (used to test concurrent approval gating).
  let pendingSelectResolve: ((value: string | undefined) => void) | undefined;
  const select = vi.fn(async () => {
    if (selectChoices.length > 0) return selectChoices.shift();
    return new Promise<string | undefined>((resolve) => {
      pendingSelectResolve = resolve;
    });
  });
  const releaseSelect = (value: string | undefined) => {
    const resolve = pendingSelectResolve;
    pendingSelectResolve = undefined;
    if (resolve) resolve(value);
  };

  const custom = vi.fn(async (factory: Function) => {
    let lastResult: unknown;
    const done = (value: unknown) => { lastResult = value; };
    const component = factory(
      { requestRender: vi.fn(), stop: vi.fn(), start: vi.fn(), terminal: { rows: 40 } },
      {},
      {},
      done,
    );
    if (component && typeof component.handleInput === "function") {
      (custom as any).handleInput = (data: string) => component.handleInput(data);
    }
    return lastResult;
  });

  const confirm = vi.fn(async () => {
    if (confirmResult === undefined) {
      throw new Error("unexpected confirm fallback");
    }
    return confirmResult;
  });

  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      theme: {
        fg: (_name: string, text: string) => text,
      },
      setStatus: vi.fn(),
      confirm,
      select,
      notify: vi.fn(),
      custom,
    },
  };
  return { ctx, select, releaseSelect, custom, confirm, notify: ctx.notify };
}

// Simulates the Neovim diff approval for edit/write: the module writes
// decision.txt ("deny\n" by default) and reads it back after the (mocked)
// nvim process exits. Writing "approve\n" (and optionally the after-file)
// simulates the user approving (and editing) inside Neovim. The after file
// is nvimArgs[1] ("nvim -d before after").
function mockNvimDecision(decision: "approve" | "deny", editedContent?: string) {
  runNeovimWithArgsProcess.mockImplementation((options: any) => {
    const tempDir: string = options.tempDir;
    if (decision === "approve") {
      writeFileSync(join(tempDir, "decision.txt"), "approve\n", "utf8");
      const afterPath: string | undefined = options.nvimArgs?.[1];
      if (editedContent !== undefined && afterPath) {
        writeFileSync(afterPath, editedContent, "utf8");
      }
    }
    return { status: 0 };
  });
}

describe("mutation tool_call approval wiring", () => {
  afterEach(() => {
    setCurrentProfile("ask");
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_PERMISSION_PROFILE;
    runNeovimWithArgsProcess.mockReset();
    runNeovimWithArgsProcess.mockReturnValue({ status: 0 });
    commandExists.mockReset();
    commandExists.mockImplementation((command: string) => command === "nvim");
  });

  it("registers the permissions command via the canonical mutation package", () => {
    const { pi, commands } = makePi();
    mutationExtension(pi);

    expect(commands.some((command) => command.name === "permissions")).toBe(true);
  });

  it("does not re-register custom write/edit tools (native previews)", () => {
    const { pi } = makePi() as any;
    const tools: any[] = [];
    (pi as any).registerTool = (tool: any) => tools.push(tool);
    mutationExtension(pi);

    expect(tools).toHaveLength(0);
  });

  it("bypasses edit/write confirmation in yolo profile", async () => {
    setCurrentProfile("yolo");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![DIFF_HANDLER]!(
      { toolName: "write", input: { path: "src/app.ts", content: "ok" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toBeUndefined();
  });

  it("blocks risky bash when no UI is available", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![0]!(
      { toolName: "bash", input: { command: "sudo systemctl restart nginx" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toContain("no UI available for confirmation");
  });

  it("approves bash through the canonical mutation package", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![BASH_HANDLER]!(
      { toolName: "bash", input: { command: "npm test" } },
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          select: async () => "Approve",
          notify: () => undefined,
        },
      },
    );

    expect(result).toBeUndefined();
  });

  it("denies bash through the canonical mutation package", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![BASH_HANDLER]!(
      { toolName: "bash", input: { command: "npm test" } },
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          select: async () => "Deny",
          notify: () => undefined,
        },
      },
    );

    expect(result).toMatchObject({ block: true, reason: "Blocked by user" });
  });

  it("blocks edit/write when confirmation is required but no UI is available", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![DIFF_HANDLER]!(
      { toolName: "edit", input: { path: "src/app.ts", edits: [] } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toContain("no UI available for confirmation");
  });

  it("allows subagent children through without interactive edit/write gates", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![DIFF_HANDLER]!(
      { toolName: "write", input: { path: "src/app.ts", content: "ok" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toBeUndefined();
  });

  it("bypasses /tmp edit/write mutations", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![DIFF_HANDLER]!(
      { toolName: "write", input: { path: "/tmp/pi-mutation-test.txt", content: "ok" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toBeUndefined();
  });

  it("blocks non-object edit/write input", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![DIFF_HANDLER]!(
      { toolName: "write", input: "not-an-object" },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toMatchObject({ block: true });
    expect(result!.reason).toContain("input must be an object");
  });

  it("approves write through the ui.select modal with the three-option guard", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd, ["Approve"]);
      mutationExtension(pi);

      const input = { path: "target.txt", content: "after\n" };
      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input },
        ctx,
      );

      await expect(toolCallPromise).resolves.toBeUndefined();
      expect(select).toHaveBeenCalledWith(
        expect.stringContaining("Allow write target.txt?"),
        ["Approve", "Deny", "Inspect-Edit in Neovim"],
      );
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(input.content).toBe("after\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("denies write through the ui.select modal", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd, ["Deny"]);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "target.txt", content: "after\n" } },
        ctx,
      );

      await expect(toolCallPromise).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
      expect(select).toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("treats a dismissed selector as deny", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx } = makeInteractiveCtx(cwd, [undefined]);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "target.txt", content: "after\n" } },
        ctx,
      );

      await expect(toolCallPromise).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks a second mutation while another approval is pending", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "first.txt"), "one\n", "utf8");
      writeFileSync(join(cwd, "second.txt"), "two\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select, releaseSelect } = makeInteractiveCtx(cwd);
      mutationExtension(pi);

      const first = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "first.txt", content: "one changed\n" } },
        ctx,
      );
      await new Promise((r) => setTimeout(r, 10));

      const second = await handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "second.txt", content: "two changed\n" } },
        ctx,
      );
      expect(second).toMatchObject({ block: true, reason: "Blocked by user" });
      expect(select).toHaveBeenCalledTimes(1);

      releaseSelect("Deny");
      await expect(first).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
      expect(select).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks a second mutation while a plain-confirm approval is pending", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
      writeFileSync(join(cwd, "second.txt"), "two\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd);
      mutationExtension(pi);

      // Hold the plain confirm open so the first approval stays pending.
      let releaseConfirm!: (value: boolean) => void;
      const confirmGate = new Promise<boolean>((resolve) => {
        releaseConfirm = resolve;
      });
      const confirm = vi.fn(async () => confirmGate);
      (ctx as any).ui.confirm = confirm;

      const first = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "binary.bin", content: "new content\n" } },
        ctx,
      );
      await new Promise((r) => setTimeout(r, 10));

      const second = await handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "second.txt", content: "two changed\n" } },
        ctx,
      );
      expect(second).toMatchObject({ block: true, reason: "Blocked by user" });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(select).not.toHaveBeenCalled();

      releaseConfirm(false);
      await expect(first).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies Neovim-edited content on final approve for write", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd, ["Inspect-Edit in Neovim", "Approve"]);
      mutationExtension(pi);

      // The mocked nvim process approves and leaves edited content in the
      // after buffer (nvimArgs = ["-d", beforePath, afterPath, "-c", ...]).
      runNeovimWithArgsProcess.mockImplementation((options: any) => {
        writeFileSync(join(options.tempDir, "decision.txt"), "approve\n", "utf8");
        // nvimArgs = ["-d", beforePath, afterPath, "-c", ...]
        writeFileSync(options.nvimArgs[2], "edited by user\n", "utf8");
        return { status: 0 };
      });

      const input = { path: "target.txt", content: "after\n" };
      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input },
        ctx,
      );

      await expect(toolCallPromise).resolves.toBeUndefined();
      expect(select).toHaveBeenCalledTimes(2);
      expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
      expect(input.content).toBe("edited by user\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks when Neovim denies the change", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd, ["Inspect-Edit in Neovim"]);
      mutationExtension(pi);

      // No decision file override — the module defaults the decision to deny.
      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "target.txt", content: "after\n" } },
        ctx,
      );

      await expect(toolCallPromise).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
      expect(select).toHaveBeenCalledTimes(1);
      expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loops back to the modal after a Neovim edit for edit calls", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before line\nkeep line\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd, ["Inspect-Edit in Neovim", "Approve"]);
      mutationExtension(pi);

      runNeovimWithArgsProcess.mockImplementation((options: any) => {
        writeFileSync(join(options.tempDir, "decision.txt"), "approve\n", "utf8");
        // nvimArgs = ["-d", beforePath, afterPath, "-c", ...]
        writeFileSync(options.nvimArgs[2], "edited line\nkeep line\n", "utf8");
        return { status: 0 };
      });

      const input = { path: "target.txt", edits: [{ oldText: "before line", newText: "new line" }] };
      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "edit", input },
        ctx,
      );

      await expect(toolCallPromise).resolves.toBeUndefined();
      expect(select).toHaveBeenCalledTimes(2);
      // The Neovim-edited content replaces the whole file via one edit pair.
      expect(input.edits).toEqual([
        { oldText: "before line\nkeep line\n", newText: "edited line\nkeep line\n" },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a plain confirm for binary targets", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
      const { pi, handlers } = makePi();
      const { ctx, select, confirm } = makeInteractiveCtx(cwd, [], false);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "binary.bin", content: "new content\n" } },
        ctx,
      );

      await expect(toolCallPromise).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
      expect(select).not.toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining("Allow write binary.bin?"),
        expect.any(String),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a plain confirm for unsafe edit validation", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select, confirm } = makeInteractiveCtx(cwd, [], true);
      mutationExtension(pi);

      // oldText does not match the file content — no safe preview possible.
      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        {
          toolName: "edit",
          input: { path: "target.txt", edits: [{ oldText: "missing text", newText: "x" }] },
        },
        ctx,
      );

      await expect(toolCallPromise).resolves.toBeUndefined();
      expect(select).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining("Allow edit target.txt?"),
        expect.any(String),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a plain confirm for unreadable targets", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      const filePath = join(cwd, "locked.txt");
      writeFileSync(filePath, "before\n", "utf8");
      chmodSync(filePath, 0o000);
      const { pi, handlers } = makePi();
      const { ctx, select, confirm } = makeInteractiveCtx(cwd, [], false);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "locked.txt", content: "after\n" } },
        ctx,
      );

      await expect(toolCallPromise).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
      expect(select).not.toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining("Allow write locked.txt?"),
        expect.any(String),
      );
    } finally {
      chmodSync(join(cwd, "locked.txt"), 0o644);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a plain confirm when Neovim is missing", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select, confirm } = makeInteractiveCtx(cwd, ["Inspect-Edit in Neovim"], true);
      mutationExtension(pi);

      commandExists.mockReturnValue(false);

      const toolCallPromise = handlers.tool_call![DIFF_HANDLER]!(
        { toolName: "write", input: { path: "target.txt", content: "after\n" } },
        ctx,
      );

      await expect(toolCallPromise).resolves.toBeUndefined();
      expect(select).toHaveBeenCalledTimes(1);
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Neovim was not found"),
        "warning",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});