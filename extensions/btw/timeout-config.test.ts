import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Tests ────────────────────────────────────────────────────────────

describe("btw timeout config", () => {
  describe("Slice 1: Tracer bullet — default timeout", () => {
    it("returns 300000ms (5 minutes) when no btw settings exist", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({});

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
    });
  });

  describe("Slice 2: Configured timeout", () => {
    it("returns the configured timeout value when btw.timeoutMs is set", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: 60_000 } });

      expect(result.timeout).toBe(60_000);
      expect(result.source).toBe("config");
    });
  });

  describe("Slice 3: Missing settings", () => {
    it("returns the default timeout when btw settings exist but timeoutMs is missing", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: {} });

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
    });

    it("returns the default timeout when btw settings exist but timeoutMs is undefined", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: undefined } });

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
    });
  });

  describe("Slice 4: Invalid values", () => {
    it("returns the default timeout when timeoutMs is NaN", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: NaN } });

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
    });

    it("returns the default timeout when timeoutMs is Infinity", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: Infinity } });

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
    });

    it("returns the default timeout when timeoutMs is negative", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: -1 } });

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
    });

    it("returns the default timeout when timeoutMs is zero", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: 0 } });

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
    });

    it("returns the default timeout when timeoutMs is a string", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: "five minutes" } });

      expect(result.timeout).toBe(300_000);
      expect(result.source).toBe("default");
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

    it("exports the BtwTimeoutResult type", async () => {
      const { parseBtwTimeout } = await import("./timeout-config.js");

      const result = parseBtwTimeout({ btw: { timeoutMs: 60_000 } });
      expect(result).toHaveProperty("timeout");
      expect(result).toHaveProperty("source");
    });
  });
});
