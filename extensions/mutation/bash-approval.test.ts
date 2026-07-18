import { afterEach, describe, expect, it, vi } from "vitest";
import registerBashApproval from "./bash-approval.js";
import { setCurrentProfile } from "./permission-policy.js";

const runNeovimWithArgsProcess = vi.fn(() => ({ status: 0 }));
const commandExists = vi.fn((command: string) => command === "nvim");

vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {
    children: any[] = [];
    addChild(child: any) { this.children.push(child); }
  },
  Text: class {
    text: string;
    constructor(text = "") { this.text = text; }
  },
}));

vi.mock("./neovim-approval-utils", () => ({
  commandExists: (command: string) => commandExists(command),
  runNeovimWithArgsProcess: (options: unknown) => runNeovimWithArgsProcess(options),
  shellQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}));

function makePi() {
  const handlers: Record<string, Function[]> = {};
  const messages: any[] = [];
  return {
    pi: {
      on: (eventName: string, handler: Function) => {
        handlers[eventName] ??= [];
        handlers[eventName]!.push(handler);
      },
      appendEntry: () => undefined,
      sendMessage: (message: unknown) => messages.push(message),
    } as any,
    handlers,
    messages,
  };
}

describe("bash approval neovim integration", () => {
  afterEach(() => {
    setCurrentProfile("ask");
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_PERMISSION_PROFILE;
    runNeovimWithArgsProcess.mockClear();
    commandExists.mockClear();
  });

  it("suspends and resumes the TUI when opening bash approval in Neovim", async () => {
    // Isolate from any PI_PERMISSION_PROFILE inherited from the environment.
    delete process.env.PI_PERMISSION_PROFILE;
    setCurrentProfile("ask");
    const { pi, handlers, messages } = makePi();
    registerBashApproval(pi);

    const notify = vi.fn();
    const select = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("Inspect/Edit in Neovim")
      .mockResolvedValueOnce("Deny");

    const custom = vi.fn(async (factory: Function) => {
      const tui = {
        stop: vi.fn(),
        start: vi.fn(),
        requestRender: vi.fn(),
      };
      let doneCalled = false;
      let doneValue: unknown;
      const component = factory(tui, {}, {}, (value: unknown) => {
        doneCalled = true;
        doneValue = value;
      });

      expect(component.render()).toEqual([]);
      expect(doneCalled).toBe(true);
      expect(tui.stop).toHaveBeenCalledTimes(1);
      expect(tui.start).toHaveBeenCalledTimes(1);
      expect(tui.requestRender).toHaveBeenCalledWith(true);

      return doneValue;
    });

    const result = await handlers.tool_call![0]!(
      { toolName: "bash", input: { command: "echo hi" } },
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: { select, notify, custom },
      },
    );

    expect(commandExists).toHaveBeenCalledWith("nvim");
    expect(runNeovimWithArgsProcess).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ block: true, reason: "Blocked by user" });
    expect(notify).toHaveBeenCalledWith(
      "No Neovim decision; returning to bash approval prompt.",
      "warning",
    );
    expect(
      messages.some((m: any) => m.customType === "mutation-verdict" && m.details?.verdict === "denied"),
    ).toBe(true);

    const launchOptions = runNeovimWithArgsProcess.mock.calls[0]?.[0];
    expect(launchOptions?.windowTitlePrefix).toBe("pi bash");
    expect(launchOptions?.nvimArgs).toHaveLength(3);
  });
});
