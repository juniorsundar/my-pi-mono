import { afterEach, expect, test, vi } from "vitest";

vi.mock("../src/herdr.js", () => ({ default: vi.fn() }));
vi.mock("../src/index.js", () => ({ default: vi.fn() }));
vi.mock("../src/spawner.js", () => ({ spawnSubagent: vi.fn() }));

import entry from "../index.js";
import herdr from "../src/herdr.js";
import classic from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("inside herdr only the herdr subagents activate", () => {
  vi.stubEnv("HC_TERMINAL_ID", "t1");
  entry({} as any);
  expect(herdr).toHaveBeenCalledOnce();
  expect(classic).not.toHaveBeenCalled();
});

test("outside herdr only the process subagents activate", () => {
  vi.stubEnv("HC_TERMINAL_ID", "");
  entry({} as any);
  expect(classic).toHaveBeenCalledOnce();
  expect(herdr).not.toHaveBeenCalled();
});
