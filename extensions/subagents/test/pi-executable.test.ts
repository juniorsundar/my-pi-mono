import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePiExecutable } from "../src/pi-executable.js";

const tempDirs: string[] = [];

function makeExecutable(path: string): string {
  mkdirSync(join(path, "bin"), { recursive: true });
  const executable = join(path, "bin", "pi");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  return executable;
}

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-executable-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolvePiExecutable", () => {
  it("prefers an executable found on PATH", () => {
    const pathDir = makeTempDir();
    const agentDir = makeTempDir();
    const pathExecutable = makeExecutable(pathDir);
    makeExecutable(agentDir);

    expect(resolvePiExecutable(undefined, {
      PATH: join(pathDir, "bin"),
      PI_CODING_AGENT_DIR: agentDir,
    })).toBe(pathExecutable);
  });

  it("falls back to the Pi agent directory when PATH has no pi", () => {
    const agentDir = makeTempDir();
    const executable = makeExecutable(agentDir);

    expect(resolvePiExecutable(undefined, {
      PATH: makeTempDir(),
      PI_CODING_AGENT_DIR: agentDir,
    })).toBe(executable);
  });

  it("honors an explicit executable override", () => {
    expect(resolvePiExecutable("/custom/pi", { PATH: "" })).toBe("/custom/pi");
  });

  it("fails with setup guidance when no executable is found", () => {
    const agentDir = makeTempDir();

    expect(() => resolvePiExecutable(undefined, {
      PATH: makeTempDir(),
      PI_CODING_AGENT_DIR: agentDir,
    })).toThrow(/Add pi to PATH or set PI_CODING_AGENT_DIR/);
  });
});
