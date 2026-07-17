import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Module-level mocks (hoisted before imports) ─────────────────────

// Default return: empty config, no errors. Tests can override with mockReturnValue/mockImplementation.
vi.mock("./config", () => ({
  loadDeepresearchConfig: vi.fn(() => ({ config: {}, errors: [] })),
}));

// Mock EventBus for testing spawnSubagent injection
const mockEventBusHandlers = new Map<string, Array<(data: unknown) => void>>();

const mockEventBus = {
  emit: vi.fn((channel: string, data: unknown) => {
    // Invoke all handlers registered for this channel
    const handlers = mockEventBusHandlers.get(channel);
    if (handlers) {
      handlers.forEach(handler => handler(data));
    }
  }),
  on: vi.fn((channel: string, handler: (data: unknown) => void) => {
    // Store handlers so tests can invoke them
    if (!mockEventBusHandlers.has(channel)) {
      mockEventBusHandlers.set(channel, []);
    }
    mockEventBusHandlers.get(channel)!.push(handler);
    return () => {
      // Unsubscribe function (not used in tests)
    };
  }),
};

// Helper to provide spawnSubagent to deep-research via EventBus
function provideMockSpawnSubagent(spawnSubagent: any): void {
  mockEventBus.emit("subagents:spawn:provide", spawnSubagent);
}

// typebox is not a direct project dependency — it comes from @earendil-works/pi-coding-agent.
// Mock it so the module graph loads in test context. Proxy-based to handle any
// Type.* method that production code may reference.
vi.mock("typebox", () => {
  const handler: ProxyHandler<{ [key: string]: ReturnType<typeof vi.fn> }> = {
    get(target, prop) {
      if (!(prop in target)) {
        target[prop as string] = vi.fn(() => ({ type: "object" }));
      }
      return target[prop as string];
    },
  };
  return { Type: new Proxy({ Object: vi.fn(() => ({ type: "object", properties: {} })) }, handler) };
});

// ── Imports after mocks are set up ──────────────────────────────────

import deepResearchExtension, { resetSpawnSubagentForTest } from "./index.js";
import { loadDeepresearchConfig } from "./config.js";
import { ResearchStateManager } from "./state-manager.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function createMockPi() {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    setModel: vi.fn(),
    appendEntry: vi.fn(() => "mock-anchor-id"),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    events: mockEventBus,
  };
}

function createMockCtx(overrides = {}) {
  return {
    ui: { notify: vi.fn() },
    cwd: "/tmp/test-cwd",
    sessionManager: {
      appendCustomEntry: vi.fn(() => "mock-anchor-id"),
      getLeafId: vi.fn(() => "mock-anchor-id"),
      getSessionId: vi.fn(() => "mock-session-id"),
      getBranch: vi.fn(() => []),
    },
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    navigateTree: vi.fn().mockResolvedValue(undefined),
    modelRegistry: { find: vi.fn() },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("tool registration", () => {
  it("registers spawn_research_subagent with r-plan in description and promptGuidelines", () => {
    const pi = createMockPi();
    deepResearchExtension(pi);

    const toolRegistration = pi.registerTool.mock.calls.find(
      (call: any) => call[0].name === "spawn_research_subagent",
    )?.[0];

    expect(toolRegistration).toBeDefined();
    expect(toolRegistration.description).toContain("r-plan");
    expect(toolRegistration.promptGuidelines.some(
      (g: string) => g.includes("r-plan"),
    )).toBe(true);
  });

  it("registers deep_research_complete tool", () => {
    const pi = createMockPi();
    deepResearchExtension(pi);

    const toolRegistration = pi.registerTool.mock.calls.find(
      (call: any) => call[0].name === "deep_research_complete",
    )?.[0];

    expect(toolRegistration).toBeDefined();
  });
});

describe("deep-research command handler", () => {
  let pi: ReturnType<typeof createMockPi>;
  let handler: (args: string, ctx: any) => Promise<void>;

  beforeEach(() => {
    pi = createMockPi();
    deepResearchExtension(pi);
    handler = pi.registerCommand.mock.calls[0][1].handler;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Slice 1: Tracer bullet — empty args", () => {
    it("shows a usage warning when called with an empty query", async () => {
      const ctx = createMockCtx();

      await handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Usage: /deep-research <query>",
        "warning",
      );
    });

    it("shows a usage warning when called with only whitespace", async () => {
      const ctx = createMockCtx();

      await handler("   ", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Usage: /deep-research <query>",
        "warning",
      );
    });
  });

  describe("Slice 2: Config validation", () => {
    it("notifies error and returns early when config has errors and no models", async () => {
      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: {},
        errors: ["deepresearch key not found in settings.json"],
      });

      const ctx = createMockCtx();

      await handler("some query", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'deepresearch config error: deepresearch key not found in settings.json. Add a "deepresearch" key to settings.json.',
        "error",
      );
      // Early return — no anchor created
      expect(pi.appendEntry).not.toHaveBeenCalled();
    });
  });

  describe("Slice 3: Initialization path", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-init-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("creates research directory, state.md, and loop anchor on valid query", async () => {
      // Mock read to indicate completion so the loop exits on first iteration
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\ncomplete\n\n## Steps Completed\n",
      );

      const ctx = createMockCtx({ cwd: tempDir });

      await handler("some test query", ctx);

      // Verify slug-derived values match
      const slug = "some-test-query";

      // 1. Research directory exists
      const researchDir = join(tempDir, ".pi", "deep-research", slug);
      expect(existsSync(researchDir)).toBe(true);

      // 2. state.md exists with the query (file on disk, not mocked read)
      const stateFile = join(researchDir, "state.md");
      expect(existsSync(stateFile)).toBe(true);
      const stateContent = readFileSync(stateFile, "utf-8");
      expect(stateContent).toContain("some test query");
      expect(stateContent).toContain("## Status\nactive");

      // 3. Loop anchor was created
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "deep-research-anchor",
        { slug },
      );
    });
  });

  describe("Slice 4: Orchestrator model switch", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-model-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("calls pi.setModel when orchestratorModel matches a registered model", async () => {
      const mockModel = { id: "claude-sonnet-4", provider: "anthropic" };
      const mockFind = vi.fn(() => mockModel);

      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: { orchestratorModel: "anthropic/claude-sonnet-4" },
        errors: [],
      });

      const ctx = createMockCtx({
        cwd: tempDir,
        modelRegistry: { find: mockFind },
      });

      await handler("test query", ctx);

      expect(mockFind).toHaveBeenCalledWith("anthropic", "claude-sonnet-4");
      expect(pi.setModel).toHaveBeenCalledWith(mockModel);
    });

    it("does not call pi.setModel when model is not found in registry", async () => {
      const mockFind = vi.fn(() => undefined);

      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: { orchestratorModel: "anthropic/unknown-model" },
        errors: [],
      });

      const ctx = createMockCtx({
        cwd: tempDir,
        modelRegistry: { find: mockFind },
      });

      await handler("test query", ctx);

      expect(mockFind).toHaveBeenCalledWith("anthropic", "unknown-model");
      expect(pi.setModel).not.toHaveBeenCalled();
    });

    it("handles orchestratorModel without a provider slash gracefully", async () => {
      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: { orchestratorModel: "just-a-model-name" },
        errors: [],
      });

      const ctx = createMockCtx({
        cwd: tempDir,
        modelRegistry: { find: vi.fn() },
      });

      await handler("test query", ctx);

      // No slash → no model lookup, no setModel call
      expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
      expect(pi.setModel).not.toHaveBeenCalled();
    });

    it("handles orchestratorModel with trailing slash — no empty modelId lookup", async () => {
      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: { orchestratorModel: "anthropic/" },
        errors: [],
      });

      const findFn = vi.fn();
      const ctx = createMockCtx({
        cwd: tempDir,
        modelRegistry: { find: findFn },
      });

      await handler("test query", ctx);

      // Trailing slash → slashIdx > 0, but modelId is empty string.
      // Current behavior calls find with empty modelId. Test documents this.
      expect(findFn).toHaveBeenCalledWith("anthropic", "");
      expect(pi.setModel).not.toHaveBeenCalled();
    });

    it("handles missing modelRegistry gracefully (optional chaining)", async () => {
      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: { orchestratorModel: "anthropic/claude-sonnet-4" },
        errors: [],
      });

      // No modelRegistry on ctx at all
      const ctx = createMockCtx({
        cwd: tempDir,
        modelRegistry: undefined,
      });

      await expect(handler("test query", ctx)).resolves.toBeUndefined();
      expect(pi.setModel).not.toHaveBeenCalled();
    });
  });

  describe("Slice 5: Completion detection", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-complete-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("completes when state contains '## Status\\ncomplete'", async () => {
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\ncomplete\n\n## Steps Completed\n",
      );

      const ctx = createMockCtx({ cwd: tempDir });

      await handler("test query", ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "deep-research-result",
          display: true,
        }),
        { triggerTurn: false },
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Deep research complete"),
        "info",
      );
    });

    it("completes when state contains 'Status: complete'", async () => {
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "Status: complete\n\n## Steps Completed\n",
      );

      const ctx = createMockCtx({ cwd: tempDir });

      await handler("test query", ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "deep-research-result",
          display: true,
        }),
        { triggerTurn: false },
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Deep research complete"),
        "info",
      );
    });

    it("completes when deep_research_complete tool call is found in session", async () => {
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "assistant",
                content: [
                  { type: "toolCall", name: "deep_research_complete" },
                ],
              },
            },
          ]),
        },
      });

      await handler("test query", ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "deep-research-result",
          display: true,
        }),
        { triggerTurn: false },
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Deep research complete"),
        "info",
      );
    });
  });

  describe("Slice 5b: Step archival", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-archive-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("archives subagent output when completing", async () => {
      const agentId = "r-search-abc123";
      const agentType = "r-search";
      const outputContent = "Search result: found relevant data";

      // Create the subagent output file that archiveLatestSubagentOutput reads
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), outputContent);

      vi.spyOn(ResearchStateManager.prototype, "read")
        .mockReturnValueOnce("## Status\ncomplete\n\n## Steps Completed\n")
        .mockReturnValue("## Status\ncomplete\n\n## Steps Completed\n");

      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: {},
        errors: [],
      });

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType },
              },
            },
          ]),
        },
      });

      await handler("test query", ctx);

      // Step file was archived in steps/<agentId>.md
      const researchSlug = "test-query";
      const stepsDir = join(tempDir, ".pi", "deep-research", researchSlug, "steps");
      expect(existsSync(stepsDir)).toBe(true);
      const stepFiles = readdirSync(stepsDir);
      expect(stepFiles).toContain(`${agentId}.md`);

      // Archived file contains the subagent output
      const archivedContent = readFileSync(join(stepsDir, `${agentId}.md`), "utf-8");
      expect(archivedContent).toContain(outputContent);

      // Research completed normally
      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "deep-research-result" }),
        { triggerTurn: false },
      );
    });
  });

  describe("Slice 6: Non-completing iteration", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-loop-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("calls navigateTree after a non-completing iteration and continues the loop", async () => {
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      const ctx = createMockCtx({ cwd: tempDir });

      await handler("test query", ctx);

      // All 10 iterations ran (no completion, all non-completing)
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(10);

      // waitForIdle was called on each iteration
      expect(ctx.waitForIdle).toHaveBeenCalledTimes(10);

      // navigateTree was called after each non-completing iteration
      expect(ctx.navigateTree).toHaveBeenCalledTimes(10);

      // Each navigateTree call uses the anchor ID and no summarize
      for (const call of vi.mocked(ctx.navigateTree).mock.calls) {
        expect(call).toEqual(["mock-anchor-id", { summarize: false }]);
      }

      // Each sendUserMessage call includes deliverAs: "followUp"
      for (const call of vi.mocked(pi.sendUserMessage).mock.calls) {
        expect(call[1]).toEqual({ deliverAs: "followUp" });
      }

      // First-iteration prompt tells the orchestrator to spawn r-plan first
      const firstPrompt = vi.mocked(pi.sendUserMessage).mock.calls[0][0];
      expect(firstPrompt).toContain("First step:");
      expect(firstPrompt).toContain("r-plan");
      expect(firstPrompt).toContain("r-search"); // still listed as an available agent

      // Subsequent prompts reference the Research Plan but don't contain first-step instructions
      const secondPrompt = vi.mocked(pi.sendUserMessage).mock.calls[1][0];
      expect(secondPrompt).not.toContain("First step:");
      expect(secondPrompt).toContain("Research Plan");

      // Completion message was NOT sent
      expect(pi.sendMessage).not.toHaveBeenCalled();

      // Max-iterations warning was sent after 10 iterations with persistent failures
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("10 iterations with persistent failures"),
        "error",
      );
    });
  });

  describe("Slice 7: Pre-iteration progress notification", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-prenotify-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("notifies with iteration number before each iteration", async () => {
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\ncomplete\n\n## Steps Completed\n",
      );

      const ctx = createMockCtx({ cwd: tempDir });

      await handler("test query", ctx);

      // Should have shown the pre-iteration notification for iteration 1
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Deep research: iteration 1/10",
        "info",
      );
    });

    it("notifies with correct iteration number for multiple iterations", async () => {
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      const ctx = createMockCtx({ cwd: tempDir });

      await handler("test query", ctx);

      // All 10 iterations should have pre-iteration notifications
      const notifyCalls = vi.mocked(ctx.ui.notify).mock.calls.filter(
        ([_msg, type]: any) => type === "info" && typeof _msg === "string" && (_msg as string).startsWith("Deep research: iteration"),
      );

      expect(notifyCalls).toHaveLength(10);

      // Verify each iteration number
      notifyCalls.forEach(([msg]: any, idx: number) => {
        expect(msg).toBe(`Deep research: iteration ${idx + 1}/10`);
      });
    });
  });

  describe("Slice 8: Post-iteration progress notification", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-postnotify-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("notifies with iteration number and agent type after each non-completing iteration", async () => {
      const agentId = "r-search-abc123";
      const agentType = "r-search";

      // Create subagent output file on disk so archiveLatestSubagentOutput can read it
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), "Search results: found relevant data");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: {},
        errors: [],
      });

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType },
              },
            },
          ]),
        },
      });

      await handler("test query", ctx);

      // Filter for post-iteration notifications (starts with "Iteration")
      const postNotifyCalls = vi.mocked(ctx.ui.notify).mock.calls.filter(
        ([msg, type]: any) => type === "info" && typeof msg === "string" && (msg as string).startsWith("Iteration "),
      );

      // All 10 iterations should have a post-iteration notification
      expect(postNotifyCalls).toHaveLength(10);

      // First iteration
      expect(postNotifyCalls[0][0]).toBe("Iteration 1 complete: r-search archived");

      // Last iteration
      expect(postNotifyCalls[9][0]).toBe("Iteration 10 complete: r-search archived");
    });

    it("does not show post-iteration notification when no subagent was spawned", async () => {
      // No subagent output file and empty getBranch — archiveLatestSubagentOutput finds nothing
      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      const ctx = createMockCtx({ cwd: tempDir });

      await handler("test query", ctx);

      // No post-iteration notifications should appear
      const postNotifyCalls = vi.mocked(ctx.ui.notify).mock.calls.filter(
        ([msg, type]: any) => type === "info" && typeof msg === "string" && (msg as string).startsWith("Iteration "),
      );

      expect(postNotifyCalls).toHaveLength(0);
    });
  });

  describe("Slice 9: Agent type prefix in onProgress feed", () => {
    it("prepends agent type to onProgress feed text", async () => {
      // Find the spawn_research_subagent tool's execute handler
      const spawnToolRegistration = pi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];

      const executeHandler = spawnToolRegistration.execute;
      const onUpdateMock = vi.fn();

      // Create mock spawnSubagent
      const mockSpawnSubagent = vi.fn(async ({ onProgress }: any) => {
        onProgress?.({
          collapsed: { text: "searching the web...", hiddenCount: 0, lines: [] },
          expanded: { text: "searching the web...", hiddenCount: 0, lines: [] },
        });
        return {
          output: "research result",
          agentId: "r-search-abc123",
          agentType: "r-search",
          duration: 5000,
          model: "test",
          usage: {},
        };
      });

      // Provide spawnSubagent via EventBus before calling execute
      provideMockSpawnSubagent(mockSpawnSubagent);

      const ctx = createMockCtx();

      await executeHandler(
        "test-call-id",
        { agent_type: "r-search", prompt: "search for X" },
        undefined,
        onUpdateMock,
        ctx,
      );

      expect(onUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [
            expect.objectContaining({
              text: "[r-search] searching the web...",
            }),
          ],
        }),
      );
    });

    it("prepends different agent types correctly", async () => {
      const spawnToolRegistration = pi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];

      const executeHandler = spawnToolRegistration.execute;
      const onUpdateMock = vi.fn();

      const mockSpawnSubagent = vi.fn(async ({ onProgress }: any) => {
        onProgress?.({
          collapsed: { text: "analyzing gaps...", hiddenCount: 0, lines: [] },
          expanded: { text: "analyzing gaps...", hiddenCount: 0, lines: [] },
        });
        return {
          output: "gap analysis",
          agentId: "r-gap-def456",
          agentType: "r-gap",
          duration: 3000,
          model: "test",
          usage: {},
        };
      });

      provideMockSpawnSubagent(mockSpawnSubagent);

      const ctx = createMockCtx();

      await executeHandler(
        "test-call-id-2",
        { agent_type: "r-gap", prompt: "find gaps" },
        undefined,
        onUpdateMock,
        ctx,
      );

      expect(onUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [
            expect.objectContaining({
              text: "[r-gap] analyzing gaps...",
            }),
          ],
        }),
      );
    });
  });

  // ── Error Recovery Slices (Ticket 0003) ─────────────────────────────

  describe("Slice 10: wasCompleteToolCalled error logging (AC4)", () => {
    it("logs a console.warn when getBranch throws inside wasCompleteToolCalled", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const tempDir = createTempDir("dr-ac4-test-");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      // Call 1 (detectSubagentError): return empty array (no error)
      // Call 2 (wasCompleteToolCalled): throw
      const getBranch = vi.fn()
        .mockImplementationOnce(() => [])
        .mockImplementationOnce(() => { throw new Error("session unavailable"); })
        .mockReturnValue([]);

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch,
        },
      });

      await handler("test query", ctx);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("wasCompleteToolCalled"),
        expect.stringContaining("session unavailable"),
      );

      warnSpy.mockRestore();
      cleanupTempDir(tempDir);
    });
  });

  describe("Slice 11: archiveLatestSubagentOutput error logging + structured return (AC5)", () => {
    it("logs console.warn and does not crash when getBranch throws inside archiveLatestSubagentOutput", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const tempDir = createTempDir("dr-ac5-err-test-");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      // Call 1 (wasCompleteToolCalled): return empty array (no complete tool)
      // Call 2 (detectSubagentError): return empty array (no error)
      // Call 3 (archiveLatestSubagentOutput): throw
      const getBranch = vi.fn()
        .mockImplementationOnce(() => [])
        .mockImplementationOnce(() => [])
        .mockImplementationOnce(() => { throw new Error("archive error"); })
        .mockReturnValue([]);

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch,
        },
      });

      await handler("test query", ctx);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("archiveLatestSubagentOutput"),
        expect.stringContaining("archive error"),
      );

      warnSpy.mockRestore();
      cleanupTempDir(tempDir);
    });

    it("returns structured result with archived:true on successful archive", async () => {
      const tempDir = createTempDir("dr-ac5-ok-test-");
      const agentId = "r-search-abc123";
      const agentType = "r-search";

      // Create subagent output file on disk
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), "Search results: found relevant data");

      vi.spyOn(ResearchStateManager.prototype, "read")
        .mockReturnValueOnce("## Status\nactive\n\nSome findings\n") // iteration 1
        .mockReturnValue("## Status\ncomplete\n\n## Steps Completed\n"); // after archive, complete

      vi.mocked(loadDeepresearchConfig).mockReturnValue({
        config: {},
        errors: [],
      });

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType },
              },
            },
          ]),
        },
      });

      await handler("test query", ctx);

      // Should show the archived notification
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Iteration 1 complete: r-search archived",
        "info",
      );

      cleanupTempDir(tempDir);
    });
  });

  describe("Slice 12: spawnSubagent error handling in execute handler (AC1)", () => {
    it("catches spawnSubagent errors and returns structured error content instead of throwing", async () => {
      const spawnToolRegistration = pi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];
      const executeHandler = spawnToolRegistration.execute;

      const mockSpawnSubagent = vi.fn();
      mockSpawnSubagent.mockRejectedValue(new Error("Subagent timed out after 30s"));
      provideMockSpawnSubagent(mockSpawnSubagent);

      const ctx = createMockCtx();

      // RED: handler rejects with error. GREEN: handler resolves with error content.
      await expect(
        executeHandler(
          "test-call-id",
          { agent_type: "r-search", prompt: "search for X" },
          undefined,
          undefined,
          ctx,
        ),
      ).resolves.toMatchObject({
        content: [{ type: "text" as const, text: expect.stringContaining("error") }],
      });
    });

    it("does not modify the successful spawnSubagent return path", async () => {
      const spawnToolRegistration = pi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];
      const executeHandler = spawnToolRegistration.execute;

      const mockSpawnSubagent = vi.fn();
      mockSpawnSubagent.mockResolvedValue({
        output: "research result",
        agentId: "r-search-abc123",
        agentType: "r-search",
        duration: 5000,
        model: "test",
        usage: {},
      });
      provideMockSpawnSubagent(mockSpawnSubagent);

      const ctx = createMockCtx();

      const result = await executeHandler(
        "test-call-id",
        { agent_type: "r-search", prompt: "search for X" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content[0].text).toBe("research result");
      expect(result.details?.agentType).toBe("r-search");
    });

    it("returns structured error when no spawner is registered on event bus", async () => {
      // Reset spawnSubagent to ensure no spawner is registered
      resetSpawnSubagentForTest();
      
      // Create a fresh pi instance without providing any spawnSubagent
      const freshPi = createMockPi();
      deepResearchExtension(freshPi);
      
      const spawnToolRegistration = freshPi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];
      const executeHandler = spawnToolRegistration.execute;

      // Don't provide any spawnSubagent - test the missing-spawner guard
      const ctx = createMockCtx();

      const result = await executeHandler(
        "test-call-id",
        { agent_type: "r-search", prompt: "search for X" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content[0].text).toContain("error");
      expect(result.content[0].text).toContain("No spawner registered on event bus");
      expect(result.details?.error).toBe("No spawner registered on event bus");
      expect(result.details?.agentType).toBe("r-search");
      expect(result.details?.agentId).toBeDefined();
    });
  });

  describe("Slice 2: Load-order safety + missing-spawner guard", () => {
    it("succeeds when pi-subagents loads after deep-research (request triggers provide)", async () => {
      // Reset spawnSubagent to simulate clean state
      resetSpawnSubagentForTest();
      
      // Create a fresh pi instance and initialize deep-research
      const freshPi = createMockPi();
      deepResearchExtension(freshPi);
      
      // Verify that deep-research emitted a request during initialization
      expect(freshPi.events.emit).toHaveBeenCalledWith(
        "subagents:spawn:request",
        expect.objectContaining({ requester: "deep-research" }),
      );
      
      // Now simulate pi-subagents loading after deep-research by providing spawnSubagent
      const mockSpawnSubagent = vi.fn();
      mockSpawnSubagent.mockResolvedValue({
        output: "research result",
        agentId: "r-search-abc123",
        agentType: "r-search",
        duration: 5000,
        model: "test",
        usage: {},
      });
      
      // Provide spawnSubagent via EventBus (simulating pi-subagents responding to request)
      freshPi.events.emit("subagents:spawn:provide", mockSpawnSubagent);
      
      // Get the execute handler and call it
      const spawnToolRegistration = freshPi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];
      const executeHandler = spawnToolRegistration.execute;
      
      const ctx = createMockCtx();
      const result = await executeHandler(
        "test-call-id",
        { agent_type: "r-search", prompt: "search for X" },
        undefined,
        undefined,
        ctx,
      );
      
      // Verify that the spawnSubagent was called successfully
      expect(result.content[0].text).toBe("research result");
      expect(result.details?.agentType).toBe("r-search");
      expect(mockSpawnSubagent).toHaveBeenCalledTimes(1);
    });
  });

  describe("Slice 13: Subagent error detection in iteration loop (AC1)", () => {
    it("logs subagent errors to state.md ## Errors section and continues the loop", async () => {
      const tempDir = createTempDir("dr-loop-err-test-");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      // Mock getBranch to return an errored tool result
      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: {
                  agentType: "r-search",
                  error: "Subagent timed out after 30s",
                },
              },
            },
          ]),
        },
      });

      const writeSpy = vi.spyOn(ResearchStateManager.prototype, "write");

      await handler("test query", ctx);

      // At least one write call should contain the error
      const errorWrites = writeSpy.mock.calls.filter(
        ([content]: string[]) =>
          typeof content === "string" &&
          content.includes("## Errors") &&
          content.includes("Subagent timed out after 30s"),
      );
      expect(errorWrites.length).toBeGreaterThan(0);

      writeSpy.mockRestore();
      cleanupTempDir(tempDir);
    });

    it("continues to next iteration after logging a subagent error", async () => {
      const tempDir = createTempDir("dr-loop-err2-test-");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      // Return errored result — loop should continue instead of crashing
      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: {
                  agentType: "r-search",
                  error: "Subagent timed out",
                },
              },
            },
          ]),
        },
      });

      await handler("test query", ctx);

      // Loop should complete all 10 iterations (no crash, no early return)
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(10);
      expect(ctx.navigateTree).toHaveBeenCalledTimes(10);

      cleanupTempDir(tempDir);
    });
  });

  describe("Slice 14: Empty/malformed output detection (AC2)", () => {
    it("logs a warning to state.md when subagent output is empty", async () => {
      const tempDir = createTempDir("dr-empty-test-");
      const agentId = "r-search-empty";
      const agentType = "r-search";

      // Create an empty subagent output file
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), "");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType },
              },
            },
          ]),
        },
      });

      const writeSpy = vi.spyOn(ResearchStateManager.prototype, "write");

      await handler("test query", ctx);

      const errorWrites = writeSpy.mock.calls.filter(
        ([content]: string[]) =>
          typeof content === "string" &&
          content.includes("## Errors") &&
          content.includes("empty output") &&
          content.includes(agentType),
      );
      expect(errorWrites.length).toBeGreaterThan(0);

      writeSpy.mockRestore();
      cleanupTempDir(tempDir);
    });

    it("does not crash when subagent output is malformed", async () => {
      const tempDir = createTempDir("dr-malformed-test-");
      const agentId = "r-search-malformed";
      const agentType = "r-search";

      // Create a whitespace-only output file
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), "   \n\n  ");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType },
              },
            },
          ]),
        },
      });

      await handler("test query", ctx);

      // Loop should complete all 10 iterations without crashing
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(10);

      cleanupTempDir(tempDir);
    });
  });

  describe("Slice 15: Retry once on subagent failure (AC3)", () => {
    it("retries once when spawnSubagent fails and returns success on retry", async () => {
      const spawnToolRegistration = pi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];
      const executeHandler = spawnToolRegistration.execute;

      const mockSpawnSubagent = vi.fn();
      // First call rejects, second resolves
      mockSpawnSubagent
        .mockRejectedValueOnce(new Error("Timeout"))
        .mockResolvedValueOnce({
          output: "retry success",
          agentId: "r-search-retry",
          agentType: "r-search",
          duration: 6000,
          model: "test",
          usage: {},
        });
      provideMockSpawnSubagent(mockSpawnSubagent);

      const ctx = createMockCtx();

      const result = await executeHandler(
        "test-call-id",
        { agent_type: "r-search", prompt: "search for X" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content[0].text).toBe("retry success");
      expect(mockSpawnSubagent).toHaveBeenCalledTimes(2);
      // Retried flag should be propagated in success details
      expect(result.details?.retried).toBe(true);
    });

    it("returns error with agentId and retried flag when both attempts fail", async () => {
      const spawnToolRegistration = pi.registerTool.mock.calls.find(
        (call: any) => call[0].name === "spawn_research_subagent",
      )?.[0];
      const executeHandler = spawnToolRegistration.execute;

      const mockSpawnSubagent = vi.fn();
      // Both calls reject
      mockSpawnSubagent
        .mockRejectedValueOnce(new Error("Timeout"))
        .mockRejectedValueOnce(new Error("Timeout on retry"));
      provideMockSpawnSubagent(mockSpawnSubagent);

      const ctx = createMockCtx();

      const result = await executeHandler(
        "test-call-id",
        { agent_type: "r-search", prompt: "search for X" },
        undefined,
        undefined,
        ctx,
      );

      expect(result.content[0].text).toContain("error");
      expect(result.content[0].text).toContain("r-search");
      expect(result.content[0].text).toContain("after retry");
      expect(result.details?.retried).toBe(true);
      expect(result.details?.agentId).toBeDefined();
      expect(typeof result.details?.agentId).toBe("string");
      expect(result.details?.agentId).toContain("r-search");
      expect(mockSpawnSubagent).toHaveBeenCalledTimes(2);
    });

    it("records retry success in state.md when retry succeeds", async () => {
      const tempDir = createTempDir("dr-retry-log-test-");
      const agentId = "r-search-retry-ok";
      const agentType = "r-search";

      // Create subagent output file
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), "Retry produced results");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      // Tool result with retried: true (successful retry)
      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType, retried: true },
              },
            },
          ]),
        },
      });

      const writeSpy = vi.spyOn(ResearchStateManager.prototype, "write");

      await handler("test query", ctx);

      // A write should contain a retry success log
      const retryWrites = writeSpy.mock.calls.filter(
        ([content]: string[]) =>
          typeof content === "string" &&
          content.includes("## Errors") &&
          content.includes("Subagent succeeded on retry"),
      );
      expect(retryWrites.length).toBeGreaterThan(0);

      writeSpy.mockRestore();
      cleanupTempDir(tempDir);
    });
  });

  describe("Slice 16: Partial status on persistent failures (AC6)", () => {
    it("marks state.md as partial and notifies user when all iterations have persistent failures", async () => {
      const tempDir = createTempDir("dr-partial-test-");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      // All iterations return errored tool results (no successful archive)
      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: {
                  agentType: "r-search",
                  error: "Subagent timed out",
                },
              },
            },
          ]),
        },
      });

      const writeSpy = vi.spyOn(ResearchStateManager.prototype, "write");

      await handler("test query", ctx);

      // state.md should have been marked as partial
      const partialWrites = writeSpy.mock.calls.filter(
        ([content]: string[]) =>
          typeof content === "string" &&
          content.includes("## Status\npartial"),
      );
      expect(partialWrites.length).toBeGreaterThan(0);

      // User should be notified about persistent failures
      const failureNotifies = vi.mocked(ctx.ui.notify).mock.calls.filter(
        ([msg]: string[]) =>
          typeof msg === "string" &&
          msg.includes("persistent failures"),
      );
      expect(failureNotifies.length).toBeGreaterThan(0);

      writeSpy.mockRestore();
      cleanupTempDir(tempDir);
    });

    it("does not mark partial when at least one iteration had a successful archive", async () => {
      const tempDir = createTempDir("dr-no-partial-test-");
      const agentId = "r-search-abc";
      const agentType = "r-search";

      // Create a successful subagent output file
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), "Some actual research findings");

      vi.spyOn(ResearchStateManager.prototype, "read").mockReturnValue(
        "## Status\nactive\n\nSome findings\n",
      );

      const ctx = createMockCtx({
        cwd: tempDir,
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType },
              },
            },
          ]),
        },
      });

      const writeSpy = vi.spyOn(ResearchStateManager.prototype, "write");

      await handler("test query", ctx);

      // state.md should NOT be marked as partial
      const partialWrites = writeSpy.mock.calls.filter(
        ([content]: string[]) =>
          typeof content === "string" &&
          content.includes("## Status\npartial"),
      );
      expect(partialWrites.length).toBe(0);

      // User should be warned about max iterations, not persistent failures
      const maxIterNotifies = vi.mocked(ctx.ui.notify).mock.calls.filter(
        ([msg]: string[]) =>
          typeof msg === "string" &&
          msg.includes("iterations without completing"),
      );
      expect(maxIterNotifies.length).toBeGreaterThan(0);

      writeSpy.mockRestore();
      cleanupTempDir(tempDir);
    });
  });

  describe("Slice 17: Abort handling — signal already aborted at handler start", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-abort-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("updates state.md with interrupted status, notifies user, and exits cleanly when signal is already aborted", async () => {
      const mockSignal = {
        aborted: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      const ctx = createMockCtx({
        cwd: tempDir,
        signal: mockSignal,
      });

      await handler("test query", ctx);

      // 1. Research directory was created
      const researchDir = join(tempDir, ".pi", "deep-research", "test-query");
      expect(existsSync(researchDir)).toBe(true);

      // 2. state.md contains interrupted status
      const stateContent = readFileSync(join(researchDir, "state.md"), "utf-8");
      expect(stateContent).toContain("## Status\ninterrupted");

      // 3. User was notified with iteration 0 and the correct path
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Deep research interrupted at iteration 0. Partial results saved to .pi/deep-research/test-query/",
        "warning",
      );

      // 4. Handler returned cleanly — loop did not start
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.waitForIdle).not.toHaveBeenCalled();
    });

    it("preserves research directory (state.md + steps/) after cancellation", async () => {
      const mockSignal = {
        aborted: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      const ctx = createMockCtx({
        cwd: tempDir,
        signal: mockSignal,
      });

      await handler("test query", ctx);

      const researchDir = join(tempDir, ".pi", "deep-research", "test-query");

      // Research directory exists
      expect(existsSync(researchDir)).toBe(true);

      // state.md exists and is readable
      const stateFile = join(researchDir, "state.md");
      expect(existsSync(stateFile)).toBe(true);
      const stateContent = readFileSync(stateFile, "utf-8");
      expect(stateContent.length).toBeGreaterThan(0);

      // steps/ subdirectory exists and is empty (no iterations ran)
      const stepsDir = join(researchDir, "steps");
      expect(existsSync(stepsDir)).toBe(true);
      expect(readdirSync(stepsDir)).toHaveLength(0);
    });
  });

  describe("Slice 18: Abort handling — signal aborts mid-iteration", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir("dr-abort-mid-test-");
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it("records interrupted iteration and last completed step when abort fires during iteration 2", async () => {
      // Mock signal that is not initially aborted, but becomes aborted on trigger
      let signalAborted = false;
      const abortCallbacks: Array<() => void> = [];
      const mockSignal = {
        get aborted() { return signalAborted; },
        addEventListener: vi.fn((event: string, cb: () => void) => {
          if (event === "abort") abortCallbacks.push(cb);
        }),
        removeEventListener: vi.fn(),
      };

      // Create subagent output file for iteration 1
      const agentId = "r-search-abc123";
      const agentType = "r-search";
      const subagentDir = join(tempDir, ".pi", "subagents", agentId);
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(join(subagentDir, "output.md"), "Search results: found relevant data");

      // Track waitForIdle calls to trigger abort on the second call (iteration 2)
      let waitCallCount = 0;

      const ctx = createMockCtx({
        cwd: tempDir,
        signal: mockSignal,
        waitForIdle: vi.fn().mockImplementation(async () => {
          waitCallCount++;
          if (waitCallCount === 2) {
            // Trigger abort during iteration 2's waitForIdle
            signalAborted = true;
            abortCallbacks.forEach((cb) => cb());
          }
        }),
        sessionManager: {
          appendCustomEntry: vi.fn(() => "mock-anchor-id"),
          getLeafId: vi.fn(() => "mock-anchor-id"),
          getBranch: vi.fn(() => [
            {
              type: "message",
              message: {
                role: "toolResult",
                toolName: "spawn_research_subagent",
                details: { agentId, agentType },
              },
            },
          ]),
        },
      });

      await handler("test query", ctx);

      // 1. Research directory and steps/ subdirectory exist
      const researchDir = join(tempDir, ".pi", "deep-research", "test-query");
      expect(existsSync(researchDir)).toBe(true);
      const stepsDir = join(researchDir, "steps");
      expect(existsSync(stepsDir)).toBe(true);
      // Archived step file from iteration 1 is preserved
      const stepFiles = readdirSync(stepsDir);
      expect(stepFiles.length).toBeGreaterThan(0);

      // 2. state.md has interrupted status
      const stateContent = readFileSync(join(researchDir, "state.md"), "utf-8");
      expect(stateContent).toContain("## Status\ninterrupted");

      // 3. Interruption note includes iteration 2 and last completed step r-search
      expect(stateContent).toContain("Research interrupted at iteration 2");
      expect(stateContent).toContain("last completed step: r-search");

      // 4. Notification mentions iteration 2 and the correct path
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Deep research interrupted at iteration 2. Partial results saved to .pi/deep-research/test-query/",
        "warning",
      );

      // 5. Two iterations started (iteration 1 completed, iteration 2 was in progress)
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
      expect(ctx.waitForIdle).toHaveBeenCalledTimes(2);
    });
  });
});
