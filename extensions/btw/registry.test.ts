import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRegistry } from "./registry.js";

describe("BTW Registry", () => {
  describe("Slice 1: Tracer bullet — addRunning + getRunning", () => {
    it("addRunning() adds an entry visible in getRunning()", () => {
      const registry = createRegistry();
      const mockChild = { pid: 12345 } as any;

      registry.addRunning("btw-1", "What is the capital of France?", mockChild);

      const running = registry.getRunning();
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe("btw-1");
      expect(running[0].query).toBe("What is the capital of France?");
      expect(running[0].childProcess).toBe(mockChild);
      expect(running[0].startedAt).toBeInstanceOf(Date);
    });

    it("getRunning() returns empty array when no entries added", () => {
      const registry = createRegistry();
      expect(registry.getRunning()).toEqual([]);
    });

    it("addRunning() with the same id overwrites the previous entry", () => {
      const registry = createRegistry();
      const child1 = { pid: 111 } as any;
      const child2 = { pid: 222 } as any;

      registry.addRunning("btw-1", "First query", child1);
      registry.addRunning("btw-1", "Second query", child2);

      const running = registry.getRunning();
      expect(running).toHaveLength(1);
      expect(running[0].childProcess).toBe(child2);
    });
  });

  describe("Slice 2: complete — success result moves entry to completed", () => {
    it("complete() removes entry from running", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "What is pi?", { pid: 1 } as any);

      registry.complete("btw-1", { type: "success", text: "3.14159", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      expect(registry.getRunning()).toHaveLength(0);
    });

    it("complete() adds a success result to completed entries", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "What is pi?", { pid: 1 } as any);

      registry.complete("btw-1", { type: "success", text: "3.14159", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      const completed = registry.getCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe("btw-1");
      expect(completed[0].query).toBe("What is pi?");
      expect(completed[0].result.type).toBe("success");
      if (completed[0].result.type === "success") {
        expect(completed[0].result.text).toBe("3.14159");
        expect(completed[0].result.toolTrace).toEqual([]);
      }
      expect(completed[0].completedAt).toBeInstanceOf(Date);
    });

    it("complete() on unknown id is a no-op", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1 } as any);

      registry.complete("btw-999", { type: "success", text: "irrelevant", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      // Original entry still running
      expect(registry.getRunning()).toHaveLength(1);
      expect(registry.getCompleted()).toHaveLength(0);
    });
  });

  describe("Slice 3: fail — error result moves entry to completed", () => {
    it("fail() removes entry from running", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Question?", { pid: 1 } as any);

      registry.fail("btw-1", "Process timed out");

      expect(registry.getRunning()).toHaveLength(0);
    });

    it("fail() adds an error result to completed entries", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Question?", { pid: 1 } as any);

      registry.fail("btw-1", "Process timed out");

      const completed = registry.getCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe("btw-1");
      expect(completed[0].result.type).toBe("error");
      if (completed[0].result.type === "error") {
        expect(completed[0].result.error).toBe("Process timed out");
        expect(completed[0].result.toolTrace).toEqual([]);
      }
    });

    it("fail() on unknown id is a no-op", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1 } as any);

      registry.fail("btw-999", "Error");

      expect(registry.getRunning()).toHaveLength(1);
      expect(registry.getCompleted()).toHaveLength(0);
    });

    it("fail() with full error details preserves exitCode, stderr, toolTrace, partialText", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Question?", { pid: 1 } as any);

      registry.fail("btw-1", "exited with code 1", {
        exitCode: 1,
        stderr: "Error: model not found",
        toolTrace: [{ toolName: "read", args: { path: "/foo" } }],
        partialText: "partial answer",
      });

      const completed = registry.getCompleted();
      expect(completed).toHaveLength(1);
      if (completed[0].result.type === "error") {
        expect(completed[0].result.error).toBe("exited with code 1");
        expect(completed[0].result.exitCode).toBe(1);
        expect(completed[0].result.stderr).toBe("Error: model not found");
        expect(completed[0].result.toolTrace).toHaveLength(1);
        expect(completed[0].result.toolTrace[0].toolName).toBe("read");
        expect(completed[0].result.partialText).toBe("partial answer");
      }
    });

    it("fail() without details defaults to empty toolTrace and undefined optional fields", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Question?", { pid: 1 } as any);

      registry.fail("btw-1", "timeout");

      const completed = registry.getCompleted();
      if (completed[0].result.type === "error") {
        expect(completed[0].result.toolTrace).toEqual([]);
        expect(completed[0].result.exitCode).toBeUndefined();
        expect(completed[0].result.stderr).toBeUndefined();
        expect(completed[0].result.partialText).toBeUndefined();
      }
    });
  });

  describe("Slice 4: Multiple concurrent running entries", () => {
    it("multiple entries can coexist without overwriting", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1 } as any);
      registry.addRunning("btw-2", "Q2", { pid: 2 } as any);
      registry.addRunning("btw-3", "Q3", { pid: 3 } as any);

      const running = registry.getRunning();
      expect(running).toHaveLength(3);
      const ids = running.map((e) => e.id).sort();
      expect(ids).toEqual(["btw-1", "btw-2", "btw-3"]);
    });

    it("completing one entry does not affect other running entries", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1 } as any);
      registry.addRunning("btw-2", "Q2", { pid: 2 } as any);

      registry.complete("btw-1", { type: "success", text: "Answer 1", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      expect(registry.getRunning()).toHaveLength(1);
      expect(registry.getRunning()[0].id).toBe("btw-2");
      expect(registry.getCompleted()).toHaveLength(1);
      expect(registry.getCompleted()[0].id).toBe("btw-1");
    });
  });

  describe("Slice 5: Newest-first ordering of completed entries", () => {
    it("getCompleted() returns newest-first", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Old", { pid: 1 } as any);
      registry.addRunning("btw-2", "Middle", { pid: 2 } as any);
      registry.addRunning("btw-3", "New", { pid: 3 } as any);

      registry.complete("btw-1", { type: "success", text: "A", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      registry.complete("btw-2", { type: "success", text: "B", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      registry.complete("btw-3", { type: "success", text: "C", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      const completed = registry.getCompleted();
      expect(completed).toHaveLength(3);
      expect(completed[0].id).toBe("btw-3"); // most recent first
      expect(completed[1].id).toBe("btw-2");
      expect(completed[2].id).toBe("btw-1"); // oldest last
    });

    it("newest-first ordering holds with mixed success and failure", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "First", { pid: 1 } as any);
      registry.addRunning("btw-2", "Second", { pid: 2 } as any);

      registry.complete("btw-1", { type: "success", text: "OK", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      registry.fail("btw-2", "Error");

      const completed = registry.getCompleted();
      expect(completed[0].id).toBe("btw-2"); // more recent
      expect(completed[1].id).toBe("btw-1");
    });
  });

  describe("Slice 6: killAll — terminate all running processes", () => {
    it("killAll() terminates all running child processes", () => {
      const registry = createRegistry();
      const killed: number[] = [];
      const child1 = { pid: 1, kill: (sig: string) => { killed.push(1); } } as any;
      const child2 = { pid: 2, kill: (sig: string) => { killed.push(2); } } as any;

      registry.addRunning("btw-1", "Q1", child1);
      registry.addRunning("btw-2", "Q2", child2);

      registry.killAll();

      expect(killed).toEqual(expect.arrayContaining([1, 2]));
    });

    it("killAll() clears the running map", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any);

      registry.killAll();

      expect(registry.getRunning()).toHaveLength(0);
    });

    it("killAll() is safe when no entries are running", () => {
      const registry = createRegistry();
      expect(() => registry.killAll()).not.toThrow();
    });

    it("killAll() preserves completed entries", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any);
      registry.complete("btw-1", { type: "success", text: "OK", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      // After completion, running is empty, completed has the entry
      expect(registry.getRunning()).toHaveLength(0);
      expect(registry.getCompleted()).toHaveLength(1);

      // killAll should not affect completed entries
      registry.killAll();

      expect(registry.getCompleted()).toHaveLength(1);
      const entry = registry.getCompleted()[0];
      expect(entry.id).toBe("btw-1");
      expect(entry.result.type).toBe("success");
      if (entry.result.type === "success") {
        expect(entry.result.text).toBe("OK");
      }
    });
  });

  describe("Slice 7: clear — resets all state", () => {
    it("clear() removes running entries", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any);

      registry.clear();

      expect(registry.getRunning()).toHaveLength(0);
    });

    it("clear() removes completed entries", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1 } as any);
      registry.complete("btw-1", { type: "success", text: "OK", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      registry.clear();

      expect(registry.getCompleted()).toHaveLength(0);
    });

    it("clear() resets both running and completed simultaneously", () => {
      const registry = createRegistry();
      registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any);
      registry.addRunning("btw-2", "Q2", { pid: 2 } as any);
      registry.complete("btw-2", { type: "success", text: "OK", toolTrace: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

      registry.clear();

      expect(registry.getRunning()).toHaveLength(0);
      expect(registry.getCompleted()).toHaveLength(0);
    });
  });

  describe("Slice 8: abort — explicit abort signal for a specific BTW", () => {
    it("abort() calls AbortController.abort() on the stored controller", () => {
      const registry = createRegistry();
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, "abort");

      registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any, controller);
      registry.abort("btw-1");

      expect(abortSpy).toHaveBeenCalled();
    });

    it("abort() is a no-op when the entry id is unknown", () => {
      const registry = createRegistry();
      expect(() => registry.abort("btw-nonexistent")).not.toThrow();
    });

    it("addRunning() stores the abort controller and does not throw without one", () => {
      const registry = createRegistry();
      // Without controller — should work (backward compatible)
      expect(() => registry.addRunning("btw-1", "Q1", { pid: 1, kill: () => {} } as any)).not.toThrow();

      // With controller
      const controller = new AbortController();
      expect(() => registry.addRunning("btw-2", "Q2", { pid: 2, kill: () => {} } as any, controller)).not.toThrow();
      expect(registry.getRunning()).toHaveLength(2);
    });
  });
});
