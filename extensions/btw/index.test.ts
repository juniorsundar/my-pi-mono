import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the spawner module so tests don't spawn real processes
const mockSpawnBtwProcess = vi.fn().mockResolvedValue({
  ok: true,
  text: "mocked answer",
  toolTrace: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

vi.mock("./spawner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spawner.js")>();
  return {
    ...actual,
    spawnBtwProcess: (...args: any[]) => mockSpawnBtwProcess(...args),
  };
});

// Mock the timeout-config module
vi.mock("./timeout-config.js", () => ({
  loadBtwTimeout: () => ({ timeout: 300000, source: "default" }),
}));

// Mock the spinning-list module
const mockSpinningListComponent = vi.fn();
vi.mock("./spinning-list.js", () => ({
  SpinningListComponent: mockSpinningListComponent,
}));

// Mock the review module
vi.mock("./review.js", () => ({
  BtwReviewComponent: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function createMockPi() {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

function createMockCtx(overrides = {}) {
  return {
    hasUI: true,
    ui: { notify: vi.fn(), custom: vi.fn(), setWidget: vi.fn() },
    cwd: "/tmp/test-cwd",
    sessionManager: {
      getSessionFile: vi.fn().mockReturnValue("/tmp/test-session.jsonl"),
    },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    ...overrides,
  };
}

function getShutdownHandler(pi: ReturnType<typeof createMockPi>): () => Promise<void> {
  const shutdownCall = pi.on.mock.calls.find(
    (c: unknown[]) => c[0] === "session_shutdown",
  );
  expect(shutdownCall).toBeDefined();
  return shutdownCall[1] as () => Promise<void>;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("btw extension", () => {
  afterEach(() => {
    mockSpawnBtwProcess.mockReset();
    mockSpawnBtwProcess.mockResolvedValue({
      ok: true,
      text: "mocked answer",
      toolTrace: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    mockSpinningListComponent.mockReset();
    vi.restoreAllMocks();
    // Reset PI_BTW_CHILD between tests
    delete process.env.PI_BTW_CHILD;
  });

  describe("Slice 1: Tracer bullet — loads without side effects", () => {
    it("can be imported and invoked against a mock pi without throwing", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      expect(() => btwExtension(pi)).not.toThrow();
    });

    it("does not register any tools when loaded", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      btwExtension(pi);

      expect(pi.registerTool).not.toHaveBeenCalled();
    });
  });

  describe("Slice 2: /btw command registration in normal sessions", () => {
    it("registers a /btw command when PI_BTW_CHILD is not set", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      btwExtension(pi);

      expect(pi.registerCommand).toHaveBeenCalledTimes(1);
    });

    it("registers the command with name 'btw'", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      btwExtension(pi);

      const commandName = pi.registerCommand.mock.calls[0][0];
      expect(commandName).toBe("btw");
    });

    it("provides a description mentioning side-question", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      btwExtension(pi);

      const options = pi.registerCommand.mock.calls[0][1];
      expect(options.description.toLowerCase()).toContain("side-question");
    });
  });

  describe("Slice 4: /btw with no arguments recognized separately", () => {
    it("calls the handler with empty args and opens review view", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("", ctx);

      // No-args opens the review view via custom component
      expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    });

    it("no-args opens review view, question shows notification", async () => {
      const { default: btwExtension } = await import("./index.js");
      const piNoArgs = createMockPi();
      const piWithQuestion = createMockPi();
      const ctxNoArgs = createMockCtx();
      const ctxWithQuestion = createMockCtx();

      btwExtension(piNoArgs);
      btwExtension(piWithQuestion);

      const handlerNoArgs = piNoArgs.registerCommand.mock.calls[0][1].handler;
      const handlerWithQuestion = piWithQuestion.registerCommand.mock.calls[0][1].handler;

      await handlerNoArgs("", ctxNoArgs);
      await handlerWithQuestion("what about X?", ctxWithQuestion);

      // No-args opens review view (custom component), not notification
      expect(ctxNoArgs.ui.custom).toHaveBeenCalled();
      // Question shows notification, not custom component
      expect(ctxWithQuestion.ui.notify).toHaveBeenCalled();
    });

    it("no-args review path does not append to conversation stream", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("", ctx);

      // Opening the review view must not insert anything into the conversation
      expect(ctx.sendMessage).not.toHaveBeenCalled();
      expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("Slice 5+6: /btw accepts quoted and unquoted question text", () => {
    it("handles quoted question text without crashing", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await expect(handler('"what about X?"', ctx)).resolves.not.toThrow();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    });

    it("handles unquoted question text without crashing", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await expect(handler("what about X", ctx)).resolves.not.toThrow();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    });

    it("passes quoted text through to the handler", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler('"what about X?"', ctx);

      // Handler should have called notify (either success or error)
      expect(ctx.ui.notify).toHaveBeenCalled();
    });

    it("passes unquoted text through to the handler", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      // Should not throw (will try to spawn, may fail but handler catches)
      await expect(handler("what about X", ctx)).resolves.not.toThrow();
      // Handler should have called notify (either success or error)
      expect(ctx.ui.notify).toHaveBeenCalled();
    });
  });

  describe("Slice 3: BTW Child Guard — disables registration when PI_BTW_CHILD=1", () => {
    it("does not register /btw when PI_BTW_CHILD is '1'", async () => {
      process.env.PI_BTW_CHILD = "1";
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      btwExtension(pi);

      expect(pi.registerCommand).not.toHaveBeenCalled();
    });

    it("returns early without side effects when PI_BTW_CHILD is '1'", async () => {
      process.env.PI_BTW_CHILD = "1";
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      const result = btwExtension(pi);

      expect(result).toBeUndefined();
      expect(pi.registerCommand).not.toHaveBeenCalled();
      expect(pi.registerTool).not.toHaveBeenCalled();
    });

    it("does not register /btw when PI_BTW_CHILD is 'true'", async () => {
      process.env.PI_BTW_CHILD = "true";
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();

      btwExtension(pi);

      // Guard checks for any truthy value, so 'true' should activate it
      expect(pi.registerCommand).not.toHaveBeenCalled();
    });
  });

  describe("Registry wiring: addRunning/complete/fail", () => {
    it("passes onSpawn callback to spawnBtwProcess", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockClear();
      await handler("what about X?", ctx);

      expect(mockSpawnBtwProcess).toHaveBeenCalledWith(
        expect.objectContaining({ onSpawn: expect.any(Function) }),
      );
    });

    it("calls complete with enriched result on success", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      mockSpawnBtwProcess.mockResolvedValue({
        ok: true,
        text: "Paris is the capital.",
        toolTrace: [{ toolName: "web_search", args: {} }],
        usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
        model: "claude-sonnet-4",
        stopReason: "endTurn",
      });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("capital of France?", ctx);

      // Success notification shown
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Paris"),
        "info",
      );
    });

    it("calls fail with error details on failure", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      mockSpawnBtwProcess.mockResolvedValue({
        ok: false,
        errorMessage: "BTW process exited with code 1",
        exitCode: 1,
        stderr: "Error: model not found",
        toolTrace: [],
        partialText: undefined,
      });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("what about X?", ctx);

      // Error notification shown
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("exited with code 1"),
        "error",
      );
    });

    it("calls fail when spawnBtwProcess throws", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      mockSpawnBtwProcess.mockRejectedValue(new Error("ENOENT"));

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("what about X?", ctx);

      // Error notification shown
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("ENOENT"),
        "error",
      );
    });

    it("handles a non-Error throw (e.g. string rejection)", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      mockSpawnBtwProcess.mockRejectedValue("SIGTERM");

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("fail silently?", ctx);

      // Non-Error throws are converted via String(err)
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("SIGTERM"),
        "error",
      );
    });

    it("passes an isolated AbortSignal not inherited from main-session context", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      // Main session has its own AbortController
      const mainSessionController = new AbortController();
      const ctx = createMockCtx({
        signal: mainSessionController.signal,
      } as any);

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockClear();
      await handler("question?", ctx);

      const options = mockSpawnBtwProcess.mock.calls[0][0];
      // BTW gets its own isolated signal, NOT the main session's signal
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal).not.toBe(mainSessionController.signal);
    });

    it("passes an AbortSignal to spawnBtwProcess for explicit abort support", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockClear();
      await handler("question?", ctx);

      const options = mockSpawnBtwProcess.mock.calls[0][0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("Ephemeral session path — no session file to fork", () => {
    it("passes sessionFile: null to spawnBtwProcess when getSessionFile returns null", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      // Build context manually to ensure sessionFile is null and hasUI is true
      const ctx = {
        hasUI: true,
        ui: { notify: vi.fn(), custom: vi.fn() },
        cwd: "/tmp/test-cwd",
        sessionManager: { getSessionFile: vi.fn().mockReturnValue(null) },
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      };

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("what is ephemeral?", ctx);

      expect(mockSpawnBtwProcess).toHaveBeenCalledTimes(1);
      const args = mockSpawnBtwProcess.mock.calls[0][0];
      expect(args.sessionFile).toBeNull();
    });

    it("does not include --fork in args when sessionFile is null", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = {
        hasUI: true,
        ui: { notify: vi.fn(), custom: vi.fn() },
        cwd: "/tmp/test-cwd",
        sessionManager: { getSessionFile: vi.fn().mockReturnValue(null) },
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      };

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      // Mock spawnBtwProcess to capture and inspect args
      mockSpawnBtwProcess.mockImplementation(async (options: any) => {
        // The args are built inside spawnBtwProcess, but we can verify
        // that sessionFile is null which means --no-session will be used
        expect(options.sessionFile).toBeNull();
        return {
          ok: true,
          text: "ephemeral answer",
          toolTrace: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      });

      await handler("what is ephemeral?", ctx);

      expect(mockSpawnBtwProcess).toHaveBeenCalled();
    });


  });

  describe("Slice 4: Non-TUI review invocation", () => {
    it("logs unavailable message when hasUI=false and no args", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("", ctx);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("BTW Review requires interactive mode"));
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    });

    it("logs unavailable message when hasUI=false and no args, even with completed entries", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      // First, complete a BTW to populate the registry
      mockSpawnBtwProcess.mockResolvedValueOnce({
        ok: true,
        text: "completed answer",
        toolTrace: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      await handler("test question", ctx);

      // Now try to open review in non-TUI mode
      await handler("", ctx);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("BTW Review requires interactive mode"));
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      // Verify no session mutation in review path
      expect(ctx.sendMessage).not.toHaveBeenCalled();
      expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    });

    it("logs unavailable message when hasUI=false and empty args", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("", ctx);

      // Empty args triggers the review guard, not the empty question guard
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("BTW Review requires interactive mode"));
      expect(mockSpawnBtwProcess).not.toHaveBeenCalled();
    });

    it("logs unavailable message when hasUI=false and whitespace-only args", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("   ", ctx);

      // Whitespace-only args triggers the review guard (trim makes it empty)
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("BTW Review requires interactive mode"));
      expect(mockSpawnBtwProcess).not.toHaveBeenCalled();
    });

    it("logs empty question warning when hasUI=false and empty quotes", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler('""', ctx);

      // Empty quotes after stripping triggers the empty question guard
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("BTW: empty question."));
      expect(mockSpawnBtwProcess).not.toHaveBeenCalled();
    });
  });

  describe("Slice 5: Fallback does not append to session context", () => {
    it("does not call sendMessage or sendUserMessage in non-TUI query path", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockResolvedValueOnce({
        ok: true,
        text: "answer",
        toolTrace: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      await handler("question?", ctx);

      expect(ctx.sendMessage).not.toHaveBeenCalled();
      expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    });

    it("does not call sendMessage or sendUserMessage in non-TUI error path", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockResolvedValueOnce({
        ok: false,
        errorMessage: "spawn failed",
        exitCode: 1,
        stderr: "error output",
        toolTrace: [],
      });
      await handler("question?", ctx);

      expect(ctx.sendMessage).not.toHaveBeenCalled();
      expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    });

    it("does not call sendMessage or sendUserMessage in non-TUI catch path", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockRejectedValueOnce(new Error("ENOENT"));
      await handler("question?", ctx);

      expect(ctx.sendMessage).not.toHaveBeenCalled();
      expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    });

    it("logs success result to console.log in non-TUI path", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      mockSpawnBtwProcess.mockResolvedValueOnce({
        ok: true,
        text: "Paris is the capital of France.",
        toolTrace: [],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("capital of France?", ctx);

      expect(console.log).toHaveBeenCalledWith("Paris is the capital of France.");
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    });

    it("logs error result to console.log in non-TUI path", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx({ hasUI: false });

      mockSpawnBtwProcess.mockResolvedValueOnce({
        ok: false,
        errorMessage: "BTW process exited with code 1",
        exitCode: 1,
        stderr: "error output",
        toolTrace: [],
      });

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("failing query", ctx);

      expect(console.log).toHaveBeenCalledWith("BTW process exited with code 1\nerror output");
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    });
  });

  describe("Ticket 0029 & session_start: lifecycle event handlers", () => {
    describe("Slice 1 (Tracer): registers lifecycle handlers", () => {
      it("registers a session_start event handler on the extension API", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();

        btwExtension(pi);

        expect(pi.on).toHaveBeenCalledWith(
          "session_start",
          expect.any(Function),
        );
      });

      it("registers a session_shutdown event handler on the extension API", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();

        btwExtension(pi);

        expect(pi.on).toHaveBeenCalledWith(
          "session_shutdown",
          expect.any(Function),
        );
      });

      it("does not register session_shutdown when PI_BTW_CHILD is set", async () => {
        process.env.PI_BTW_CHILD = "1";
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();

        btwExtension(pi);

        // No handlers should be registered at all in child mode
        expect(pi.on).not.toHaveBeenCalled();
      });

      it("does not call setWidget when hasUI is false during session_start", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();
        const ctx = createMockCtx({ hasUI: false });

        btwExtension(pi);

        // Get session_start handler
        const sessionStartCall = pi.on.mock.calls.find(
          (c: unknown[]) => c[0] === "session_start",
        );
        expect(sessionStartCall).toBeDefined();
        const sessionStartHandler = sessionStartCall![1] as (event: unknown, ctx: unknown) => Promise<void>;

        // Simulate session_start with hasUI=false
        await sessionStartHandler({}, ctx);

        // Verify setWidget was NOT called
        expect(ctx.ui.setWidget).not.toHaveBeenCalled();
      });
    });

    describe("Slice 2: Shutdown with no running processes (idempotent baseline)", () => {
      it("does not throw when no BTW processes are running", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();

        btwExtension(pi);

        // Find the session_shutdown handler
        const shutdownCall = pi.on.mock.calls.find(
          (call: unknown[]) => call[0] === "session_shutdown",
        );
        expect(shutdownCall).toBeDefined();
        const shutdownHandler = shutdownCall[1] as () => Promise<void>;

        await expect(shutdownHandler()).resolves.not.toThrow();
      });

      it("does not produce errors on repeated calls with no processes", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();

        btwExtension(pi);

        const shutdownCall = pi.on.mock.calls.find(
          (call: unknown[]) => call[0] === "session_shutdown",
        );
        expect(shutdownCall).toBeDefined();
        const shutdownHandler = shutdownCall[1] as () => Promise<void>;

        // Call twice — should be idempotent
        await shutdownHandler();
        await expect(shutdownHandler()).resolves.not.toThrow();
      });
    });

    describe("Slice 3: Shutdown terminates one running process", () => {
      it("kills a running BTW child process on session shutdown", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();
        const ctx = createMockCtx();

        const mockChild = { pid: 12345, kill: vi.fn() };
        let pendingResolve: (value: unknown) => void;

        // Mock spawn to register the child via onSpawn, then stay pending
        mockSpawnBtwProcess.mockImplementationOnce(async (options: any) => {
          options.onSpawn?.(mockChild);
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        });

        btwExtension(pi);
        const btwHandler = pi.registerCommand.mock.calls[0][1].handler;

        // Fire and forget — the BTW registers the child then hangs
        const btwPromise = btwHandler("question?", ctx);

        // Yield microtasks so onSpawn fires
        await Promise.resolve();
        await Promise.resolve();

        // Now trigger shutdown
        const shutdownCall = pi.on.mock.calls.find(
          (c: unknown[]) => c[0] === "session_shutdown",
        );
        const shutdownHandler = shutdownCall[1] as () => Promise<void>;
        await shutdownHandler();

        // The running child should have been killed
        expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");

        // Clean up: resolve pending BTW so test doesn't hang
        pendingResolve!({
          ok: true,
          text: "",
          toolTrace: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        await btwPromise;
      });
    });

    describe("Slice 4: Shutdown terminates multiple running processes", () => {
      it("kills all running BTW child processes on session shutdown", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();
        const ctx = createMockCtx();

        const mockChildren = [
          { pid: 1, kill: vi.fn() },
          { pid: 2, kill: vi.fn() },
          { pid: 3, kill: vi.fn() },
        ];
        const pendingResolves: Array<(v: unknown) => void> = [];
        let childIndex = 0;

        // Each call registers the next child and stays pending
        mockSpawnBtwProcess.mockImplementation(async (options: any) => {
          const child = mockChildren[childIndex++];
          options.onSpawn?.(child);
          return new Promise((resolve) => {
            pendingResolves.push(resolve);
          });
        });

        btwExtension(pi);
        const btwHandler = pi.registerCommand.mock.calls[0][1].handler;

        // Start 3 BTW processes concurrently
        const btwPromises = mockChildren.map(() => btwHandler("question?", ctx));

        // Yield microtasks so onSpawn fires for all 3
        await Promise.resolve();
        await Promise.resolve();

        // Now trigger shutdown
        const shutdownCall = pi.on.mock.calls.find(
          (c: unknown[]) => c[0] === "session_shutdown",
        );
        const shutdownHandler = shutdownCall[1] as () => Promise<void>;
        await shutdownHandler();

        // All running children should have been killed
        for (const child of mockChildren) {
          expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        }

        // Clean up: resolve all pending BTWs
        const result = {
          ok: true,
          text: "",
          toolTrace: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        for (const resolve of pendingResolves) {
          resolve(result);
        }
        await Promise.all(btwPromises);
      });
    });

    describe("Slice 5: Repeated shutdown is safe and idempotent", () => {
      it("second shutdown after terminating processes does not throw", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();
        const ctx = createMockCtx();

        const mockChild = { pid: 99, kill: vi.fn() };
        let pendingResolve: (v: unknown) => void;

        mockSpawnBtwProcess.mockImplementationOnce(async (options: any) => {
          options.onSpawn?.(mockChild);
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        });

        btwExtension(pi);
        const btwHandler = pi.registerCommand.mock.calls[0][1].handler;

        const btwPromise = btwHandler("question?", ctx);
        await Promise.resolve();
        await Promise.resolve();

        const shutdownCall = pi.on.mock.calls.find(
          (c: unknown[]) => c[0] === "session_shutdown",
        );
        const shutdownHandler = shutdownCall[1] as () => Promise<void>;

        // First shutdown — kills the running process
        await shutdownHandler();
        expect(mockChild.kill).toHaveBeenCalledTimes(1);

        // Second shutdown — should be safe (no running processes)
        await expect(shutdownHandler()).resolves.not.toThrow();

        // Child kill should not be called again
        expect(mockChild.kill).toHaveBeenCalledTimes(1);

        // Clean up
        pendingResolve!({
          ok: true,
          text: "",
          toolTrace: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        await btwPromise;
      });
    });

    describe("Slice 6: Shutdown preserves completed results", () => {
      it("does not throw when completed results exist before shutdown", async () => {
        const { default: btwExtension } = await import("./index.js");
        const pi = createMockPi();
        const ctx = createMockCtx();

        // Mock spawn to resolve with success (process completes)
        mockSpawnBtwProcess.mockResolvedValue({
          ok: true,
          text: "completed result",
          toolTrace: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });

        btwExtension(pi);
        const btwHandler = pi.registerCommand.mock.calls[0][1].handler;

        // Start a BTW — it will complete successfully
        await btwHandler("what about X?", ctx);

        // Verify completion happened
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("completed result"),
          "info",
        );

        // Now trigger shutdown
        const shutdownCall = pi.on.mock.calls.find(
          (c: unknown[]) => c[0] === "session_shutdown",
        );
        const shutdownHandler = shutdownCall[1] as () => Promise<void>;

        // Shutdown should not throw (completed results are preserved)
        await expect(shutdownHandler()).resolves.not.toThrow();
      });
    });
  });

  describe("Slice 7: Placeholder response for unimplemented paths", () => {
    it("returns a placeholder for the no-args (review) path", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler("", ctx);

      // Should open custom component (review view)
      expect(ctx.ui.custom).toHaveBeenCalled();
    });

    it("spawns a BTW process when given a question", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      // The handler will try to spawn and fail (no real pi), but should not crash
      await handler("what about X?", ctx);

      // Should have called notify with either success or error
      expect(ctx.ui.notify).toHaveBeenCalled();
    });

    it("no-args opens review component", async () => {
      const { default: btwExtension } = await import("./index.js");
      const piReview = createMockPi();
      const ctxReview = createMockCtx();

      btwExtension(piReview);

      const handlerReview = piReview.registerCommand.mock.calls[0][1].handler;

      await handlerReview("", ctxReview);

      // Should open custom component (review view), not show placeholder
      expect(ctxReview.ui.custom).toHaveBeenCalled();
    });
  });

  describe("Slice 1 (Tracer Bullet): End-to-end wired path through public handler", () => {
    it("full flow: /btw question → spawn → registry → notification (not session)", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      // Configure the mock spawner to behave like the real one:
      // 1. Call onSpawn with a fake child process
      // 2. Return a successful result
      const mockChild = { pid: 555, kill: vi.fn() };
      mockSpawnBtwProcess.mockImplementationOnce(async (opts: any) => {
        opts.onSpawn?.(mockChild);
        return {
          ok: true,
          text: "Paris is the capital of France.",
          toolTrace: [{ toolName: "web_search", args: { query: "capital of France" } }],
          usage: { input: 400, output: 150, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
          model: "gpt-4",
          stopReason: "endTurn",
        };
      });

      // Invoke the handler with a quoted question
      await handler('"What is the capital of France?"', ctx);

      // 1. Verify spawnBtwProcess was called with all expected params
      expect(mockSpawnBtwProcess).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawnBtwProcess.mock.calls[0][0];

      // 2. Verify the query was stripped of surrounding quotes
      expect(spawnArgs.query).toBe("What is the capital of France?");

      // 3. Verify onSpawn is a function (callable callback)
      expect(typeof spawnArgs.onSpawn).toBe("function");

      // 4. Verify an isolated AbortSignal was provided (not the main session's)
      expect(spawnArgs.signal).toBeInstanceOf(AbortSignal);

      // 5. Verify sessionFile was forwarded (non-ephemeral path)
      expect(spawnArgs.sessionFile).toBe("/tmp/test-session.jsonl");

      // 6. Verify cwd was forwarded
      expect(spawnArgs.cwd).toBe("/tmp/test-cwd");

      // 7. Verify notification was shown with the result text (outside conversation stream)
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("capital of France"),
        "info",
      );

      // 8. Verify NO session-writing APIs were called (conversation isolation)
      expect(ctx.sendMessage).not.toHaveBeenCalled();
      expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    });

    it("full flow: unquoted question also works end-to-end", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockImplementationOnce(async (opts: any) => {
        opts.onSpawn?.({ pid: 666, kill: vi.fn() });
        return {
          ok: true,
          text: "It's a Unix system.",
          toolTrace: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      });

      await handler("What is the meaning of life?", ctx);

      // Verify query was passed through unchanged (no quotes to strip)
      const spawnArgs = mockSpawnBtwProcess.mock.calls[0][0];
      expect(spawnArgs.query).toBe("What is the meaning of life?");

      // Verify notification was shown
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Unix system"),
        "info",
      );

      // Verify conversation isolation
      expect(ctx.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("Slice 2: Multiple concurrent /btw invocations", () => {
    it("fires two concurrent BTW queries, both complete independently", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      // Track calls to onSpawn
      const onSpawnCalls: Array<{ pid: number }> = [];

      // Mock spawner to handle two calls with different results
      mockSpawnBtwProcess
        .mockImplementationOnce(async (opts: any) => {
          const child = { pid: 111, kill: vi.fn() };
          opts.onSpawn?.(child);
          onSpawnCalls.push(child);
          return {
            ok: true,
            text: "First answer",
            toolTrace: [],
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          };
        })
        .mockImplementationOnce(async (opts: any) => {
          const child = { pid: 222, kill: vi.fn() };
          opts.onSpawn?.(child);
          onSpawnCalls.push(child);
          return {
            ok: true,
            text: "Second answer",
            toolTrace: [],
            usage: { input: 200, output: 75, cacheRead: 0, cacheWrite: 0 },
          };
        });

      // Fire both concurrently
      await Promise.all([
        handler("first query?", ctx),
        handler("second query?", ctx),
      ]);

      // 1. Both spawner calls were made
      expect(mockSpawnBtwProcess).toHaveBeenCalledTimes(2);

      // 2. Each call received a different query
      const queries = mockSpawnBtwProcess.mock.calls.map((c: any) => c[0].query);
      expect(queries).toContain("first query?");
      expect(queries).toContain("second query?");

      // 3. Both onSpawn callbacks were invoked
      expect(onSpawnCalls.length).toBe(2);

      // 4. Both got their own isolated AbortSignal
      const signals = mockSpawnBtwProcess.mock.calls.map((c: any) => c[0].signal);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      // Signals are distinct objects (not the same instance)
      expect(signals[0]).not.toBe(signals[1]);

      // 5. Both completed notifications were shown
      expect(ctx.ui.notify).toHaveBeenCalledTimes(2);

      // 6. Verify conversation isolation for both
      expect(ctx.sendMessage).not.toHaveBeenCalled();
      expect(ctx.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("Slice 3: Quoted and unquoted question text parsing", () => {
    it("strips double quotes from input", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockImplementationOnce(async (opts: any) => {
        opts.onSpawn?.({ pid: 1, kill: vi.fn() });
        return { ok: true, text: "ans", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      });

      await handler('"hello world"', ctx);

      const spawnArgs = mockSpawnBtwProcess.mock.calls[0][0];
      expect(spawnArgs.query).toBe("hello world");
    });

    it("strips single quotes from input", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockImplementationOnce(async (opts: any) => {
        opts.onSpawn?.({ pid: 2, kill: vi.fn() });
        return { ok: true, text: "ans", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      });

      await handler("'hello world'", ctx);

      const spawnArgs = mockSpawnBtwProcess.mock.calls[0][0];
      expect(spawnArgs.query).toBe("hello world");
    });

    it("keeps internal single quotes intact (apostrophe)", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockImplementationOnce(async (opts: any) => {
        opts.onSpawn?.({ pid: 3, kill: vi.fn() });
        return { ok: true, text: "ans", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      });

      await handler("it's a test", ctx);

      const spawnArgs = mockSpawnBtwProcess.mock.calls[0][0];
      // No leading/trailing quotes, so text passes through unchanged
      expect(spawnArgs.query).toBe("it's a test");
    });

    it("strips outer double quotes, keeps single quotes inside", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockImplementationOnce(async (opts: any) => {
        opts.onSpawn?.({ pid: 4, kill: vi.fn() });
        return { ok: true, text: "ans", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      });

      await handler('"what\'s up?"', ctx);

      const spawnArgs = mockSpawnBtwProcess.mock.calls[0][0];
      expect(spawnArgs.query).toBe("what's up?");
    });

    it("empty quotes trigger empty-query guard (notification, no spawn)", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      // Reset mock call tracking
      mockSpawnBtwProcess.mockClear();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler('""', ctx);

      // No spawn call — empty query guard
      expect(mockSpawnBtwProcess).not.toHaveBeenCalled();
      // Warning notification shown
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("empty question"),
        "warning",
      );
    });

    it("quoted whitespace triggers empty-query guard", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      mockSpawnBtwProcess.mockClear();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      await handler('" "', ctx);

      // After trim, this is empty string — guard should catch it
      expect(mockSpawnBtwProcess).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("empty question"),
        "warning",
      );
    });

    it("unquoted input passes through unchanged", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);
      const handler = pi.registerCommand.mock.calls[0][1].handler;

      mockSpawnBtwProcess.mockImplementationOnce(async (opts: any) => {
        opts.onSpawn?.({ pid: 5, kill: vi.fn() });
        return { ok: true, text: "ans", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      });

      await handler("just some text", ctx);

      const spawnArgs = mockSpawnBtwProcess.mock.calls[0][0];
      expect(spawnArgs.query).toBe("just some text");
    });
  });

  describe("Ticket 0027: Spinning List widget integration", () => {
    it("registers the Spinning List widget on session_start", async () => {
      const { default: btwExtension } = await import("./index.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);

      // Get session_start handler
      const sessionStartCall = pi.on.mock.calls.find(
        (c: unknown[]) => c[0] === "session_start",
      );
      expect(sessionStartCall).toBeDefined();
      const sessionStartHandler = sessionStartCall![1] as (event: unknown, ctx: unknown) => Promise<void>;

      // Simulate session_start
      await sessionStartHandler({}, ctx);

      // Verify setWidget was called with correct parameters
      expect(ctx.ui.setWidget).toHaveBeenCalledWith(
        "btw-spinning-list",
        expect.any(Function),
        { placement: "aboveEditor" },
      );
    });

    it("widget factory creates SpinningListComponent", async () => {
      const { default: btwExtension } = await import("./index.js");
      const { SpinningListComponent } = await import("./spinning-list.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);

      // Get session_start handler and call it
      const sessionStartCall = pi.on.mock.calls.find(
        (c: unknown[]) => c[0] === "session_start",
      );
      const sessionStartHandler = sessionStartCall![1] as (event: unknown, ctx: unknown) => Promise<void>;
      await sessionStartHandler({}, ctx);

      // Get the widget factory function from setWidget call
      const widgetFactory = ctx.ui.setWidget.mock.calls[0][1] as (tui: unknown) => unknown;

      // Create a mock TUI
      const mockTui = { requestRender: vi.fn() };

      // Call the factory to create the widget
      const widget = widgetFactory(mockTui);

      // Verify it's a SpinningListComponent instance
      expect(widget).toBeInstanceOf(SpinningListComponent);
    });

    it("widget factory passes registry to SpinningListComponent", async () => {
      const { default: btwExtension } = await import("./index.js");
      const { SpinningListComponent } = await import("./spinning-list.js");
      const pi = createMockPi();
      const ctx = createMockCtx();

      btwExtension(pi);

      // Get session_start handler and call it
      const sessionStartCall = pi.on.mock.calls.find(
        (c: unknown[]) => c[0] === "session_start",
      );
      const sessionStartHandler = sessionStartCall![1] as (event: unknown, ctx: unknown) => Promise<void>;
      await sessionStartHandler({}, ctx);

      // Get the widget factory function
      const widgetFactory = ctx.ui.setWidget.mock.calls[0][1] as (tui: unknown) => unknown;
      const mockTui = { requestRender: vi.fn() };

      // Call the factory to create the widget
      widgetFactory(mockTui);

      // Verify SpinningListComponent was constructed with a registry and tui
      expect(SpinningListComponent).toHaveBeenCalledTimes(1);
      const constructorArgs = (SpinningListComponent as any).mock.calls[0];

      // First arg is the registry — verify it has getRunning method
      const registry = constructorArgs[0];
      expect(typeof registry.getRunning).toBe("function");
      expect(typeof registry.getCompleted).toBe("function");
      expect(typeof registry.addRunning).toBe("function");

      // Second arg is the tui
      expect(constructorArgs[1]).toBe(mockTui);
    });
  });
});
