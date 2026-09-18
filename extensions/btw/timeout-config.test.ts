import { describe, it, expect } from "vitest";

// ── Tests ────────────────────────────────────────────────────────────

describe("btw timeout config", () => {
  describe("Slice 1: Tracer bullet — default timeout", () => {
    it("returns 300000ms (5 minutes) when no btw settings exist", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({})).toBe(300_000);
    });
  });

  describe("Slice 2: Configured timeout", () => {
    it("returns the configured timeout value when btw.timeoutMs is set", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: { timeoutMs: 60_000 } })).toBe(60_000);
    });
  });

  describe("Slice 3: Missing settings", () => {
    it("returns the default timeout when btw settings exist but timeoutMs is missing", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: {} })).toBe(300_000);
    });

    it("returns the default timeout when btw settings exist but timeoutMs is undefined", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: { timeoutMs: undefined } })).toBe(300_000);
    });
  });

  describe("Slice 4: Invalid values", () => {
    it("returns the default timeout when timeoutMs is NaN", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: { timeoutMs: NaN } })).toBe(300_000);
    });

    it("returns the default timeout when timeoutMs is Infinity", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: { timeoutMs: Infinity } })).toBe(300_000);
    });

    it("returns the default timeout when timeoutMs is negative", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: { timeoutMs: -1 } })).toBe(300_000);
    });

    it("returns the default timeout when timeoutMs is zero", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: { timeoutMs: 0 } })).toBe(300_000);
    });

    it("returns the default timeout when timeoutMs is a string", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout({ btw: { timeoutMs: "five minutes" } })).toBe(300_000);
    });

    it("returns the default timeout for null/undefined settings", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(parseBtwTimeout(null)).toBe(300_000);
      expect(parseBtwTimeout(undefined)).toBe(300_000);
    });
  });

  describe("Slice 5: Parsed timeout available", () => {
    it("exports the DEFAULT_BTW_TIMEOUT_MS constant", async () => {
      const { DEFAULT_BTW_TIMEOUT_MS } = await import("./timeout-config.js");

      expect(DEFAULT_BTW_TIMEOUT_MS).toBe(300_000);
    });

    it("exports the loadBtwTimeout function", async () => {
      const { loadBtwTimeout } = await import("./timeout-config.js");

      expect(typeof loadBtwTimeout).toBe("function");
    });

    it("exports the parseBtwTimeout function", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      expect(typeof parseBtwTimeout).toBe("function");
    });
  });
});