import { describe, it, expect } from "vitest";
import { parseEventLine } from "../src/progress-event.js";
import type { ProgressEvent } from "../src/progress-event.js";

// ── Slice 1: parseEventLine accepts a valid NDJSON line ──

describe("parseEventLine — accepts valid line", () => {
  it("returns { ok: true, event } for a line with all required fields", () => {
    const line = JSON.stringify({
      type: "lifecycle",
      text: "Subagent started",
      timestamp: "2026-01-01T00:00:00Z",
    });

    const result = parseEventLine(line);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.event).toEqual({
      type: "lifecycle",
      text: "Subagent started",
      timestamp: "2026-01-01T00:00:00Z",
    });
  });

  it("preserves optional fields when present", () => {
    const line = JSON.stringify({
      type: "tool",
      text: "bash: ls -la /tmp",
      timestamp: "2026-01-01T00:00:00Z",
      status: "started",
      toolCallId: "call_123",
      toolName: "bash",
      toolArgs: { command: "ls -la /tmp" },
      toolResultPreview: "file-a file-b",
    } satisfies ProgressEvent);

    const result = parseEventLine(line);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.event).toEqual({
      type: "tool",
      text: "bash: ls -la /tmp",
      timestamp: "2026-01-01T00:00:00Z",
      status: "started",
      toolCallId: "call_123",
      toolName: "bash",
      toolArgs: { command: "ls -la /tmp" },
      toolResultPreview: "file-a file-b",
    });
  });

  it("accepts all valid event types", () => {
    const types: ProgressEvent["type"][] = [
      "lifecycle",
      "tool",
      "assistant_text",
      "thinking",
      "terminal",
      "usage",
    ];

    for (const type of types) {
      const line = JSON.stringify({
        type,
        text: `event: ${type}`,
        timestamp: "2026-01-01T00:00:00Z",
      });

      const result = parseEventLine(line);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.type).toBe(type);
      }
    }
  });
});

// ── Slice 2: parseEventLine rejects lines missing required fields ──

describe("parseEventLine — rejects missing required fields", () => {
  it("returns { ok: false, reason: 'missing-fields' } when type is absent", () => {
    const line = JSON.stringify({ text: "hello", timestamp: "2026-01-01T00:00:00Z" });
    const result = parseEventLine(line);
    expect(result).toEqual({ ok: false, reason: "missing-fields" });
  });

  it("returns { ok: false, reason: 'missing-fields' } when text is absent", () => {
    const line = JSON.stringify({ type: "lifecycle", timestamp: "2026-01-01T00:00:00Z" });
    const result = parseEventLine(line);
    expect(result).toEqual({ ok: false, reason: "missing-fields" });
  });

  it("returns { ok: false, reason: 'missing-fields' } when timestamp is absent", () => {
    const line = JSON.stringify({ type: "lifecycle", text: "hello" });
    const result = parseEventLine(line);
    expect(result).toEqual({ ok: false, reason: "missing-fields" });
  });

  it("returns { ok: false, reason: 'missing-fields' } when a required field is not a string", () => {
    const line = JSON.stringify({ type: 123, text: "hello", timestamp: "2026-01-01T00:00:00Z" });
    const result = parseEventLine(line);
    expect(result).toEqual({ ok: false, reason: "missing-fields" });
  });

  it("returns { ok: false, reason: 'missing-fields' } when the JSON is an array, not an object", () => {
    const line = JSON.stringify(["lifecycle", "hello", "2026-01-01T00:00:00Z"]);
    const result = parseEventLine(line);
    expect(result).toEqual({ ok: false, reason: "missing-fields" });
  });

  it("returns { ok: false, reason: 'missing-fields' } when the JSON is null", () => {
    const line = "null";
    const result = parseEventLine(line);
    expect(result).toEqual({ ok: false, reason: "missing-fields" });
  });

  it("returns { ok: false, reason: 'missing-fields' } when type is an unrecognized string", () => {
    const line = JSON.stringify({ type: "bogus", text: "hello", timestamp: "2026-01-01T00:00:00Z" });
    const result = parseEventLine(line);
    expect(result).toEqual({ ok: false, reason: "missing-fields" });
  });
});

// ── Slice 3: parseEventLine rejects non-JSON lines ──

describe("parseEventLine — rejects invalid JSON", () => {
  it("returns { ok: false, reason: 'invalid-json' } for a plain string", () => {
    const result = parseEventLine("this is not valid json");
    expect(result).toEqual({ ok: false, reason: "invalid-json" });
  });

  it("returns { ok: false, reason: 'invalid-json' } for a truncated line", () => {
    const result = parseEventLine('{"type":"lifecycle","text":"hello"');
    expect(result).toEqual({ ok: false, reason: "invalid-json" });
  });

  it("returns { ok: false, reason: 'invalid-json' } for an empty string", () => {
    const result = parseEventLine("");
    expect(result).toEqual({ ok: false, reason: "invalid-json" });
  });
});
