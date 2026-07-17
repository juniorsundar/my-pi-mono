import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSource = (file: string) => readFile(join(__dirname, file), "utf-8");

describe("btw stream parser", () => {
  it("returns empty defaults for empty input", async () => {
    const { parseBtwOutput } = await import("./parser.js");

    const result = parseBtwOutput([]);
    expect(result.text).toBe("");
    expect(result.toolTrace).toEqual([]);
    expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(result.model).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
  });

  describe("assistant text extraction", () => {
    it("extracts final assistant text from message_end with text content blocks", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
          { type: "text", text: "Paris is the capital of France." },
        ] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("Paris is the capital of France.");
    });

    it("extracts text from string content (not array)", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: "Simple string answer." } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("Simple string answer.");
    });

    it("joins multiple text blocks with newlines", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
          { type: "text", text: "First paragraph." },
          { type: "text", text: "Second paragraph." },
        ] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("First paragraph.\nSecond paragraph.");
    });

    it("ignores non-assistant message_end events", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "user msg" }] } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "actual answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("actual answer");
    });

    it("takes the last assistant message_end when multiple exist", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("final answer");
    });

    it("returns empty text when no message_end events present", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "agent_start" }),
        JSON.stringify({ type: "turn_start", turnIndex: 0 }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("");
    });
  });

  describe("tool trace extraction", () => {
    it("extracts tool calls from tool_execution_start events", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "web_search", input: { query: "capital of France" } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.toolTrace).toHaveLength(1);
      expect(result.toolTrace[0].toolName).toBe("web_search");
      expect(result.toolTrace[0].args).toEqual({ query: "capital of France" });
    });

    it("extracts tool calls from tool_call events", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "tool_call", toolCallId: "tc-2", toolName: "read", args: { path: "/foo.ts" } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.toolTrace).toHaveLength(1);
      expect(result.toolTrace[0].toolName).toBe("read");
      expect(result.toolTrace[0].args).toEqual({ path: "/foo.ts" });
    });

    it("deduplicates tool calls by toolCallId", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "web_search", input: { query: "Q1" } }),
        JSON.stringify({ type: "tool_call", toolCallId: "tc-1", toolName: "web_search", args: { query: "Q1" } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.toolTrace).toHaveLength(1);
    });

    it("preserves multiple distinct tool calls in order", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "web_search", input: {} }),
        JSON.stringify({ type: "tool_execution_start", toolCallId: "tc-2", toolName: "read", input: {} }),
        JSON.stringify({ type: "tool_execution_start", toolCallId: "tc-3", toolName: "bash", input: {} }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.toolTrace).toHaveLength(3);
      expect(result.toolTrace.map(t => t.toolName)).toEqual(["web_search", "read", "bash"]);
    });

    it("returns empty toolTrace when no tool events present", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.toolTrace).toEqual([]);
    });
  });

  describe("usage stats, model, stop reason", () => {
    it("extracts usage stats from message_end", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "answer" }],
          usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 },
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.usage).toEqual({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 });
    });

    it("extracts model from message_end", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "answer" }],
          model: "anthropic/claude-sonnet-4-20250514",
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
    });

    it("extracts stopReason from message_end", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "answer" }],
          stopReason: "endTurn",
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.stopReason).toBe("endTurn");
    });

    it("returns default usage when no usage in event", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "answer" }],
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("handles missing model and stopReason gracefully", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "answer" }],
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.model).toBeUndefined();
      expect(result.stopReason).toBeUndefined();
    });

    it("extracts cost from usage when present", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "answer" }],
          usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.05 },
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.usage.cost).toBe(0.05);
    });

    it("accumulates usage across multiple message_end events", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 },
        } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "second" }],
          usage: { input: 300, output: 150, cacheRead: 50, cacheWrite: 0 },
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("second");
      expect(result.usage).toEqual({ input: 1300, output: 650, cacheRead: 250, cacheWrite: 50 });
    });

    it("preserves accumulated usage when final message_end has no usage block", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "final" }],
          // No usage block on final event
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("final");
      expect(result.usage).toEqual({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: undefined });
    });

    it("accumulates cost across multiple message_end events", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
        } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "second" }],
          usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
        } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "third" }],
          usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0 },
          // No cost on this event
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("third");
      expect(result.usage.cost).toBe(0.05);
      expect(result.usage.input).toBe(1000);
      expect(result.usage.output).toBe(350);
    });

    it("handles content blocks with non-string text field", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [
            { type: "text", text: 123 },  // number, not string
            { type: "text", text: "valid answer" },
          ],
        } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("valid answer");
    });
  });

  describe("edge cases: malformed output and empty input", () => {
    it("returns empty results for empty lines array", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const result = parseBtwOutput([]);
      expect(result.text).toBe("");
      expect(result.toolTrace).toEqual([]);
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("skips malformed JSON lines without throwing", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        "not json at all",
        "",  // empty line
        "{broken json",
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "valid answer" }] } }),
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("valid answer");
    });

    it("handles empty lines between valid events", async () => {
      const { parseBtwOutput } = await import("./parser.js");

      const lines = [
        "",
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
        "",
      ];

      const result = parseBtwOutput(lines);
      expect(result.text).toBe("answer");
    });
  });

  describe("architectural constraints", () => {
    it("parser.ts does not import from spawner or child_process", async () => {
      const source = await readSource("parser.ts");
      expect(source).not.toMatch(/from\s+["']\.\/spawner/);
      expect(source).not.toMatch(/from\s+["']node:child_process/);
      expect(source).not.toMatch(/from\s+["']child_process/);
    });

    it("types.ts declares the canonical BtwToolTraceEntry and BtwUsage interfaces", async () => {
      const source = await readSource("types.ts");
      expect(source).toMatch(/export interface BtwToolTraceEntry/);
      expect(source).toMatch(/export interface BtwUsage/);
    });

    it("parser.ts does not declare its own BtwToolTraceEntry or BtwUsage (only re-exports)", async () => {
      const source = await readSource("parser.ts");
      expect(source).not.toMatch(/interface BtwToolTraceEntry/);
      expect(source).not.toMatch(/interface BtwUsage/);
    });

    it("parser.ts re-exports BtwToolTraceEntry and BtwUsage from types", async () => {
      const source = await readSource("parser.ts");
      expect(source).toMatch(/export\s+type\s+\{[^}]*BtwToolTraceEntry[^}]*\}\s*from\s*["']\.\/types/);
      expect(source).toMatch(/export\s+type\s+\{[^}]*BtwUsage[^}]*\}\s*from\s*["']\.\/types/);
    });

    it("spawner.ts no longer exports parseBtwOutput after extraction", async () => {
      const source = await readSource("spawner.ts");
      expect(source).not.toMatch(/export\s+function\s+parseBtwOutput/);
    });
  });
});
