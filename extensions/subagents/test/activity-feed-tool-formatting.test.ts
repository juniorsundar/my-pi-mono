import { describe, expect, it } from "vitest";
import { summarizeToolArgs } from "../src/activity-feed-tool-formatting.js";

describe("summarizeToolArgs", () => {
  it("formats Pendant-style subagent arguments", () => {
    expect(summarizeToolArgs("subagent", {
      agent: "scout",
      task: "inspect the entry point",
    })).toBe("scout — inspect the entry point");
  });
});
