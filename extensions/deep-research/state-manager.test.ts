import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ResearchStateManager } from "./state-manager.js";

let tempDir: string;
let workDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dr-state-test-"));
  workDir = join(tempDir, "project");
  const { mkdirSync } = require("fs");
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ResearchStateManager", () => {
  describe("slugify", () => {
    it("converts a topic to a URL-safe slug", () => {
      expect(ResearchStateManager.slugify("Why did Rust 2024 change range syntax?")).toBe(
        "why-did-rust-2024-change-range-syntax",
      );
    });

    it("collapses multiple special characters", () => {
      expect(ResearchStateManager.slugify("Hello   World!!!")).toBe("hello-world");
    });

    it("trims leading and trailing dashes", () => {
      expect(ResearchStateManager.slugify("--hello--")).toBe("hello");
    });

    it("truncates to 80 characters", () => {
      const long = "a".repeat(200);
      expect(ResearchStateManager.slugify(long).length).toBeLessThanOrEqual(80);
    });

    it("handles empty string", () => {
      expect(ResearchStateManager.slugify("")).toBe("");
    });
  });

  describe("initialize", () => {
    it("creates the research directory and state.md", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test Topic", "What is the answer?");

      expect(existsSync(mgr.stateFile)).toBe(true);
      expect(existsSync(join(mgr["baseDir"], "steps"))).toBe(true);
    });

    it("writes initial state with topic and question", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test Topic", "What is the answer?");

      const content = readFileSync(mgr.stateFile, "utf-8");
      expect(content).toContain("Test Topic");
      expect(content).toContain("What is the answer?");
      expect(content).toContain("## Status\nactive");
    });

    it("includes a Research Plan section in initial state", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const content = readFileSync(mgr.stateFile, "utf-8");
      expect(content).toContain("## Research Plan");
      expect(content).toContain("No plan yet — awaiting r-plan");
      // Research Plan is positioned between Original Question and Summary
      const originalQIndex = content.indexOf("## Original Question");
      const planIndex = content.indexOf("## Research Plan");
      const summaryIndex = content.indexOf("## Summary");
      expect(planIndex).toBeGreaterThan(originalQIndex);
      expect(summaryIndex).toBeGreaterThan(planIndex);
    });
  });

  describe("read and write", () => {
    it("reads back written content", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");
      mgr.write("# Custom content\nHello");
      expect(mgr.read()).toBe("# Custom content\nHello");
    });
  });

  describe("archiveStep", () => {
    it("writes step output to steps/<agent-id>.md and returns a StepRecord", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const record = mgr.archiveStep("Search result: found X", "r-search", "r-search-abc123");

      expect(record.agentType).toBe("r-search");
      expect(record.agentId).toBe("r-search-abc123");
      expect(record.outputFile).toContain("r-search-abc123.md");

      // Check the file was written
      expect(existsSync(record.outputFile)).toBe(true);
      const stepContent = readFileSync(record.outputFile, "utf-8");
      expect(stepContent).toContain("Search result: found X");
      expect(stepContent).toContain("r-search-abc123");
    });
  });

  describe("appendStepToState", () => {
    it("adds a step record to the Steps Completed section", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const state = mgr.read();
      const record = {
        agentType: "r-search",
        agentId: "r-search-abc",
        timestamp: 1700000000000,
        summary: "Found relevant results",
        outputFile: "/path/to/step.md",
      };
      const updated = mgr.appendStepToState(state, record);

      expect(updated).toContain("r-search-abc");
      expect(updated).toContain("Found relevant results");
      expect(updated).toContain("## Steps Completed");
    });
  });

  describe("markComplete", () => {
    it("changes status from active to complete", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");
      const state = mgr.read();
      const updated = mgr.markComplete(state);
      expect(updated).toContain("## Status\ncomplete");
      expect(updated).not.toContain("## Status\nactive");
    });
  });

  describe("exists", () => {
    it("returns false when state.md does not exist", () => {
      const mgr = new ResearchStateManager(workDir, "nonexistent");
      expect(mgr.exists()).toBe(false);
    });

    it("returns true after initialize", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");
      expect(mgr.exists()).toBe(true);
    });
  });

  describe("full lifecycle", () => {
    it("supports a complete research iteration flow", () => {
      const slug = ResearchStateManager.slugify("What is the meaning of life?");
      const mgr = new ResearchStateManager(workDir, slug);
      mgr.initialize("Meaning of Life", "What is the meaning of life?");

      // Initial state
      let state = mgr.read();
      expect(state).toContain("Meaning of Life");
      expect(state).toContain("## Status\nactive");

      // Simulate r-search step
      const searchRecord = mgr.archiveStep("Found: 42 (source: h2g2)", "r-search", "r-search-42");
      state = mgr.appendStepToState(state, searchRecord);
      mgr.write(state);

      // Simulate r-synth step
      const synthRecord = mgr.archiveStep(
        "The meaning of life is 42, according to Deep Thought.",
        "r-synth", "r-synth-42",
      );
      state = mgr.read();
      state = mgr.appendStepToState(state, synthRecord);
      state = mgr.markComplete(state);
      mgr.write(state);

      // Final state
      const finalState = mgr.read();
      expect(finalState).toContain("## Status\ncomplete");
      expect(finalState).toContain("r-search-42");
      expect(finalState).toContain("r-synth-42");

      // Steps are archived
      const stepsDir = join(mgr["baseDir"], "steps");
      const files = readdirSync(stepsDir);
      expect(files).toContain("r-search-42.md");
      expect(files).toContain("r-synth-42.md");
    });
  });

  describe("appendErrorToState", () => {
    it("appends an error line to an existing ## Errors section", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const errorRecord = {
        agentType: "r-search",
        agentId: "r-search-abc",
        message: "Subagent timed out after 30s",
        timestamp: 1700000000000,
      };

      // Inject a ## Errors section first
      const stateWithErrors = mgr.read() + "\n## Errors\n*No errors yet.*\n";
      const updated = mgr.appendErrorToState(stateWithErrors, errorRecord);

      expect(updated).toContain("## Errors");
      expect(updated).toContain("r-search-abc");
      expect(updated).toContain("Subagent timed out after 30s");
      expect(updated).toContain("1700000000000");
    });

    it("adds an ## Errors section if one does not exist", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const state = mgr.read(); // No ## Errors section
      const errorRecord = {
        agentType: "r-search",
        agentId: "r-search-abc",
        message: "Subagent timed out",
        timestamp: 1700000000000,
      };

      const updated = mgr.appendErrorToState(state, errorRecord);

      expect(updated).toContain("## Errors");
      expect(updated).toContain("1700000000000 — **r-search** (`r-search-abc`) — Subagent timed out");
    });

    it("appends multiple errors sequentially", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      let state = mgr.read();

      const error1 = {
        agentType: "r-search",
        agentId: "r-search-1",
        message: "Timeout",
        timestamp: 1000,
      };
      const error2 = {
        agentType: "r-gap",
        agentId: "r-gap-2",
        message: "Empty output",
        timestamp: 2000,
      };

      state = mgr.appendErrorToState(state, error1);
      state = mgr.appendErrorToState(state, error2);

      expect(state).toContain("1000 — **r-search** (`r-search-1`) — Timeout");
      expect(state).toContain("2000 — **r-gap** (`r-gap-2`) — Empty output");
    });
  });

  describe("markPartial", () => {
    it("changes status from active to partial", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const state = mgr.read();
      const updated = mgr.markPartial(state);

      expect(updated).toContain("## Status\npartial");
      expect(updated).not.toContain("## Status\nactive");
    });

    it("does not change status if already complete", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      let state = mgr.read();
      state = mgr.markComplete(state);
      const updated = mgr.markPartial(state);

      expect(updated).toContain("## Status\ncomplete");
    });

    it("does not change status if already partial", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const state = mgr.read();
      const once = mgr.markPartial(state);
      const twice = mgr.markPartial(once);

      expect(twice).toContain("## Status\npartial");
      // Should only have one ## Status line
      expect(twice.match(/## Status/g)).toHaveLength(1);
    });
  });

  describe("markInterrupted", () => {
    it("changes status from active to interrupted", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const state = mgr.read();
      const updated = mgr.markInterrupted(state, { iteration: 3 });

      expect(updated).toContain("## Status\ninterrupted");
      expect(updated).not.toContain("## Status\nactive");
    });

    it("adds interruption note with iteration number to ## Errors", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const state = mgr.read();
      const updated = mgr.markInterrupted(state, { iteration: 5 });

      expect(updated).toContain("## Errors");
      expect(updated).toContain("Research interrupted at iteration 5");
      expect(updated).toContain("**interrupted**");
    });

    it("includes last completed step type when provided", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test", "Q?");

      const state = mgr.read();
      const updated = mgr.markInterrupted(state, { iteration: 3, lastStep: "r-search" });

      expect(updated).toContain("Research interrupted at iteration 3");
      expect(updated).toContain("last completed step: r-search");
    });

    it("preserves other state sections", () => {
      const mgr = new ResearchStateManager(workDir, "test-topic");
      mgr.initialize("Test Topic", "What is the question?");

      const state = mgr.read();
      const updated = mgr.markInterrupted(state, { iteration: 2, lastStep: "r-search" });

      expect(updated).toContain("Test Topic");
      expect(updated).toContain("What is the question?");
      expect(updated).toContain("## Original Question");
      expect(updated).toContain("## Steps Completed");
    });
  });
});
