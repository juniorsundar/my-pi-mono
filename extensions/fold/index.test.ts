import { expect, test } from "vitest";
import { scan, summary } from "./index.js";

test("scan starts a new run after assistant text and keeps open runs open", () => {
  const runs = new Map<string, any>();
  const toolRun = new Map<string, string>();
  const msg = (timestamp: number, ...content: any[]) => ({ type: "message", message: { role: "assistant", content, timestamp } });
  const call = (id: string) => ({ type: "toolCall", id });
  const result = (toolCallId: string, timestamp: number, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId, timestamp, isError } });
  const entries = [
    { type: "message", message: { role: "user", content: "go" } },
    msg(1000, { type: "thinking", thinking: "hm" }, call("a"), call("b")),
    result("a", 2000),
    result("b", 3000, true),
    msg(4000, call("c")),
    result("c", 43000),
    msg(44000, { type: "text", text: "narration" }, call("d")), // text first: d starts a new run
    result("d", 45000),
    msg(46000, { type: "text", text: "done" }),
  ];
  scan(entries, runs, toolRun);
  expect([...toolRun]).toEqual([["a", "a"], ["b", "a"], ["c", "a"], ["d", "d"]]);
  expect(summary(runs.get("a"))).toBe("▸ 3 tool calls · 2 turns · 42s · 1 failed");
  expect(summary(runs.get("d"))).toBe("▸ 1 tool call · 1 turn · 1s");

  runs.get("d").open = true;
  scan(entries, runs, toolRun);
  expect(summary(runs.get("d"))).toBe("▾ 1 tool call · 1 turn · 1s");
});
