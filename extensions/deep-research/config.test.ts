import { describe, it, expect } from "vitest";
import { parseDeepresearchConfig } from "./config.js";

describe("parseDeepresearchConfig", () => {
  it("returns found=false when deepresearch key is missing", () => {
    const { config, found } = parseDeepresearchConfig({});
    expect(found).toBe(false);
    expect(config.subagentModel).toBeUndefined();
    expect(config.orchestratorModel).toBeUndefined();
  });

  it("returns found=false when deepresearch is not an object", () => {
    const { config, found } = parseDeepresearchConfig({
      deepresearch: "ollama/gemma4:31b",
    } as Record<string, unknown>);
    expect(found).toBe(false);
    expect(config.subagentModel).toBeUndefined();
  });

  it("returns found=false when deepresearch is an array", () => {
    const { config, found } = parseDeepresearchConfig({
      deepresearch: [],
    } as Record<string, unknown>);
    expect(found).toBe(false);
    expect(config.subagentModel).toBeUndefined();
  });

  it("extracts subagentModel", () => {
    const { config, found } = parseDeepresearchConfig({
      deepresearch: {
        subagentModel: "ollama/gemma4:31b",
      },
    });
    expect(found).toBe(true);
    expect(config.subagentModel).toBe("ollama/gemma4:31b");
  });

  it("extracts orchestratorModel", () => {
    const { config, found } = parseDeepresearchConfig({
      deepresearch: {
        orchestratorModel: "opencode-go/deepseek-v4-flash",
      },
    });
    expect(found).toBe(true);
    expect(config.orchestratorModel).toBe("opencode-go/deepseek-v4-flash");
  });

  it("extracts both models together", () => {
    const { config, found } = parseDeepresearchConfig({
      deepresearch: {
        subagentModel: "ollama/gemma4:31b",
        orchestratorModel: "opencode-go/deepseek-v4-flash",
      },
    });
    expect(found).toBe(true);
    expect(config.subagentModel).toBe("ollama/gemma4:31b");
    expect(config.orchestratorModel).toBe("opencode-go/deepseek-v4-flash");
  });

  it("handles empty deepresearch config", () => {
    const { config, found } = parseDeepresearchConfig({
      deepresearch: {},
    });
    expect(found).toBe(true);
    expect(config.subagentModel).toBeUndefined();
    expect(config.orchestratorModel).toBeUndefined();
  });

  it("ignores unknown fields", () => {
    const { config, found } = parseDeepresearchConfig({
      deepresearch: {
        subagentModel: "ollama/gemma4:31b",
        ollamaHost: "http://localhost:11434",
        temperature: 0.1,
      },
    });
    expect(found).toBe(true);
    expect(config.subagentModel).toBe("ollama/gemma4:31b");
    // orchestratorModel is undefined (not set)
    expect(config.orchestratorModel).toBeUndefined();
  });
});
