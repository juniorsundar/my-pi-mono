import { expect, test } from "vitest";
import { scan, summary } from "./index.js";

test("scan maps tool calls to their run and applies settled stats", () => {
  const runs = new Map<string, any>();
  const toolRun = new Map<string, string>();
  const call = (id: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id }] } });
  scan(
    [
      call("before"), // recorded without the extension: stays unfolded
      { type: "custom", customType: "fold", data: { id: "r1" } },
      call("a"),
      call("b"),
      { type: "custom", customType: "fold-end", data: { id: "r1", tools: 2, failed: 1, turns: 3, ms: 42000 } },
      call("after"),
    ],
    runs,
    toolRun,
  );
  expect([...toolRun]).toEqual([["a", "r1"], ["b", "r1"]]);
  expect(summary(runs.get("r1"))).toBe("▸ 2 tool calls · 3 turns · 42s · 1 failed");
});
