import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseSubagentsEnabled, loadSubagentsEnabled } from "../src/config.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-config-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseSubagentsEnabled", () => {
  it("defaults to enabled", () => {
    expect(parseSubagentsEnabled({})).toBe(true);
    expect(parseSubagentsEnabled(undefined)).toBe(true);
  });

  it("disables only on an explicit false", () => {
    expect(parseSubagentsEnabled({ subagents: { enabled: false } })).toBe(false);
    expect(parseSubagentsEnabled({ subagents: { enabled: "false" } })).toBe(true);
    expect(parseSubagentsEnabled({ subagents: { enabled: true } })).toBe(true);
  });

  it("ignores a malformed subagents section", () => {
    expect(parseSubagentsEnabled({ subagents: false })).toBe(true);
    expect(parseSubagentsEnabled({ subagents: [] })).toBe(true);
  });
});

describe("loadSubagentsEnabled", () => {
  it("honors subagents.enabled: false in settings.json", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ subagents: { enabled: false } }));

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(loadSubagentsEnabled()).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("stays enabled when settings.json has no subagents key", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ deepresearch: {} }));

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(loadSubagentsEnabled()).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});
