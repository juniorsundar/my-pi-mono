import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

function makeNixStorePi(): { entryPoint: string; launcher: string } {
  const store = makeTempDir();
  const launcher = makeExecutable(store);
  const entryPoint = join(
    store,
    "lib",
    "pi",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  mkdirSync(dirname(entryPoint), { recursive: true });
  writeFileSync(entryPoint, "");
  return { entryPoint, launcher };
}

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
    }, join(makeTempDir(), "cli.js"))).toThrow(/Add pi to PATH/);
  });

  it("finds pi inside a Nix-store layout when PATH has no pi", () => {
    const { entryPoint, launcher } = makeNixStorePi();

    expect(resolvePiExecutable(undefined, {
      PATH: makeTempDir(),
      PI_CODING_AGENT_DIR: makeTempDir(),
    }, entryPoint)).toBe(launcher);
  });

  it("finds pi through PI_PACKAGE_DIR for store installs", () => {
    const { entryPoint, launcher } = makeNixStorePi();
    const packageDir = join(dirname(entryPoint), "..", "..", "..", "..");

    expect(resolvePiExecutable(undefined, {
      PATH: makeTempDir(),
      PI_CODING_AGENT_DIR: makeTempDir(),
      PI_PACKAGE_DIR: packageDir,
    }, join(makeTempDir(), "cli.js"))).toBe(launcher);
  });
});
