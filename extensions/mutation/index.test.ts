import { describe, expect, it, afterEach, vi } from "vitest";

const toolFactoryCalls = vi.hoisted(() => ({
  writeCwds: [] as string[],
  editCwds: [] as string[],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createWriteTool: (cwd: string) => {
    toolFactoryCalls.writeCwds.push(cwd);
    return {
      label: "write",
      description: "builtin write",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "wrote" }], details: undefined }),
    };
  },
  createEditTool: (cwd: string) => {
    toolFactoryCalls.editCwds.push(cwd);
    return {
      label: "edit",
      description: "builtin edit",
      parameters: {},
      prepareArguments: (input: unknown) => input,
      execute: async () => ({ content: [{ type: "text", text: "edited" }], details: undefined }),
    };
  },
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {
    children: any[] = [];
    addChild(child: any) { this.children.push(child); }
  },
  Container: class {
    children: any[] = [];
    addChild(child: any) { this.children.push(child); }
  },
  Text: class {
    text: string;
    constructor(text = "", ..._args: unknown[]) { this.text = text; }
    setText(text: string) { this.text = text; }
  },
  Key: { ctrlAlt: (key: string) => `ctrl+alt+${key}` },
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mutationExtension from "./index.js";
import { setCurrentProfile } from "./permission-policy.js";

function makePi() {
  const handlers: Record<string, Function[]> = {};
  const messages: any[] = [];
  const entries: any[] = [];
  const tools: any[] = [];
  const commands: Array<{ name: string; definition: any }> = [];
  const messageRenderers = new Map<string, Function>();
  const entryRenderers = new Map<string, Function>();
  const pi = {
    on: (eventName: string, handler: Function) => {
      handlers[eventName] ??= [];
      handlers[eventName]!.push(handler);
    },
    registerTool: (tool: any) => tools.push(tool),
    registerMessageRenderer: (customType: string, renderer: Function) =>
      messageRenderers.set(customType, renderer),
    registerEntryRenderer: (customType: string, renderer: Function) =>
      entryRenderers.set(customType, renderer),
    registerCommand: (name: string, definition: any) => commands.push({ name, definition }),
    registerShortcut: () => undefined,
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendMessage: (message: unknown) => messages.push(message),
  };
  return {
    pi: pi as any,
    handlers,
    messages,
    entries,
    tools,
    commands,
    messageRenderers,
    entryRenderers,
  };
}

function makeTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function collectText(node: any): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) return node.children.map(collectText).join("\n");
  return "";
}

function makeInteractiveCtx(cwd: string, selectChoices: (string | undefined)[] = []) {
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
    const component = factory({ requestRender: vi.fn(), terminal: { rows: 40 } }, {}, {}, done);
    if (component && typeof component.handleInput === "function") {
      (custom as any).handleInput = (data: string) => component.handleInput(data);
    }
    return lastResult;
  });

  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      theme: {
        fg: (_name: string, text: string) => text,
      },
      setStatus: vi.fn(),
      confirm: async () => {
        throw new Error("unexpected confirm fallback");
      },
      select,
      notify: () => undefined,
      custom,
    },
  };
  return { ctx, select, releaseSelect, custom };
}

describe("mutation tool_call approval wiring", () => {
  afterEach(() => {
    setCurrentProfile("ask");
    delete process.env.PI_SUBAGENT_CHILD;
    toolFactoryCalls.writeCwds.length = 0;
    toolFactoryCalls.editCwds.length = 0;
  });

  it("bypasses edit/write diff confirmation in yolo profile", async () => {
    setCurrentProfile("yolo");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![1]!(
      { toolName: "write", input: { path: "src/app.ts", content: "ok" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toBeUndefined();
  });

  it("registers the permissions command via the canonical mutation package", () => {
    const { pi, commands } = makePi();
    mutationExtension(pi);

    expect(commands.some((command) => command.name === "permissions")).toBe(true);
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
    expect(result.reason).toContain("no UI available for confirmation");
  });

  it("approves bash through the canonical mutation package", async () => {
    setCurrentProfile("ask");
    const { pi, handlers, messages, entries, entryRenderers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![2]!(
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
    expect(
      messages.some(
        (m: any) =>
          m.customType === "mutation-verdict" &&
          m.content === "User approved the bash tool call: npm test" &&
          m.details?.verdict === "approved" &&
          m.details?.target === "npm test",
      ),
    ).toBe(true);
    expect(entries).toContainEqual({
      customType: "mutation-verdict-display",
      data: { verdict: "approved", toolName: "bash", target: "npm test" },
    });
    const rendered = entryRenderers.get("mutation-verdict-display")!(
      { data: entries[0]!.data },
      {},
      makeTheme(),
    );
    expect(collectText(rendered)).toContain("✓ approved — npm test");
  });

  it("denies bash through the canonical mutation package", async () => {
    setCurrentProfile("ask");
    const { pi, handlers, messages } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![2]!(
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
    expect(
      messages.some(
        (m: any) =>
          m.customType === "mutation-verdict" &&
          m.content === "User denied the bash tool call: npm test" &&
          m.details?.verdict === "denied" &&
          m.details?.target === "npm test",
      ),
    ).toBe(true);
  });

  it("blocks edit/write when confirmation is required but no UI is available", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![1]!(
      { toolName: "edit", input: { path: "src/app.ts", edits: [] } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("diff-preview confirmation");
  });

  it("allows subagent children through without interactive edit/write gates", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![1]!(
      { toolName: "write", input: { path: "src/app.ts", content: "ok" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toBeUndefined();
  });

  it("bypasses /tmp edit/write mutations", async () => {
    setCurrentProfile("ask");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![1]!(
      { toolName: "write", input: { path: "/tmp/pi-mutation-test.txt", content: "ok" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toBeUndefined();
  });

  it("registers write/edit renderCall overrides to replace native previews", () => {
    const { pi, tools } = makePi();
    mutationExtension(pi);

    const writeTool = tools.find((tool) => tool.name === "write");
    const editTool = tools.find((tool) => tool.name === "edit");

    expect(writeTool?.renderCall).toEqual(expect.any(Function));
    expect(editTool?.renderCall).toEqual(expect.any(Function));
    expect(writeTool?.execute).toEqual(expect.any(Function));
    expect(editTool?.execute).toEqual(expect.any(Function));
  });

  it("delegates built-in execution using the tool context cwd", async () => {
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      const { pi, tools } = makePi();
      mutationExtension(pi);

      const writeTool = tools.find((tool) => tool.name === "write");
      await writeTool.execute("call-1", { path: "target.txt", content: "ok" }, undefined, undefined, { cwd });

      expect(toolFactoryCalls.writeCwds.at(-1)).toBe(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps edit renderCall preview stable after execution mutates the file", () => {
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      const filePath = join(cwd, "target.txt");
      writeFileSync(filePath, "# Project\nold second line\n\nBody\n", "utf8");
      const { pi, tools } = makePi();
      mutationExtension(pi);

      const editTool = tools.find((tool) => tool.name === "edit");
      const args = {
        path: "target.txt",
        edits: [{ oldText: "old second line", newText: "new second line" }],
      };
      const context = { cwd, state: {}, executionStarted: false };

      const before = editTool.renderCall(args, makeTheme(), context);
      expect(collectText(before)).toContain("new second line");
      expect(collectText(before)).not.toContain("Unable to safely preview");

      writeFileSync(filePath, "# Project\nnew second line\n\nBody\n", "utf8");
      context.executionStarted = true;
      const after = editTool.renderCall(args, makeTheme(), context);

      expect(collectText(after)).toContain("new second line");
      expect(collectText(after)).not.toContain("Unable to safely preview");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("approves write through the ui.select modal", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd, ["Approve"]);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![1]!(
        { toolName: "write", input: { path: "target.txt", content: "after\n" } },
        ctx,
      );

      await expect(toolCallPromise).resolves.toBeUndefined();
      expect(select).toHaveBeenCalledWith(
        expect.stringContaining("Allow write target.txt?"),
        ["Approve", "Deny", "Inspect/Edit in Neovim", "Expand diff view"],
      );
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not emit an approved verdict if the file changes before approval", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers, messages } = makePi();
      const { ctx, select, releaseSelect } = makeInteractiveCtx(cwd);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![1]!(
        { toolName: "write", input: { path: "target.txt", content: "after\n" } },
        ctx,
      );
      await new Promise((r) => setTimeout(r, 10));

      writeFileSync(join(cwd, "target.txt"), "changed elsewhere\n", "utf8");
      releaseSelect("Approve");

      await expect(toolCallPromise).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
      expect(select).toHaveBeenCalled();
      expect(messages.some((m: any) => m.customType === "mutation-verdict" && m.details?.verdict === "approved")).toBe(false);
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

      const first = handlers.tool_call![1]!(
        { toolName: "write", input: { path: "first.txt", content: "one changed\n" } },
        ctx,
      );
      await new Promise((r) => setTimeout(r, 10));

      const second = await handlers.tool_call![1]!(
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

  it("denies write through the ui.select modal", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select } = makeInteractiveCtx(cwd, ["Deny"]);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![1]!(
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

  it("opens the diff overlay when Expand diff view is selected", async () => {
    setCurrentProfile("ask");
    const cwd = mkdtempSync(join(process.cwd(), ".tmp-mutation-test-"));
    try {
      writeFileSync(join(cwd, "target.txt"), "before\n", "utf8");
      const { pi, handlers } = makePi();
      const { ctx, select, custom } = makeInteractiveCtx(cwd, ["Expand diff view", "Deny"]);
      mutationExtension(pi);

      const toolCallPromise = handlers.tool_call![1]!(
        { toolName: "write", input: { path: "target.txt", content: "after\n" } },
        ctx,
      );

      // The overlay mock exposes handleInput from the DiffOverlayComponent.
      // Drive it to "dismiss" so the modal loop re-prompts, then "Deny".
      await new Promise((r) => setTimeout(r, 10));
      (custom as any).handleInput?.("ctrl+alt+f");

      await expect(toolCallPromise).resolves.toMatchObject({ block: true, reason: "Blocked by user" });
      expect(custom).toHaveBeenCalledTimes(1);
      expect(select).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps bash approval owned by the canonical mutation package", async () => {
    setCurrentProfile("yolo");
    const { pi, handlers } = makePi();
    mutationExtension(pi);

    const result = await handlers.tool_call![2]!(
      { toolName: "bash", input: { command: "npm test" } },
      { cwd: process.cwd(), hasUI: false, ui: {} },
    );

    expect(result).toBeUndefined();
  });
});
