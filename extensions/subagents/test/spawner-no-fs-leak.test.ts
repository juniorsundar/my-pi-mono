import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural regression guard (characterization test) — deletion-test sweep.
 *
 * Pins the acceptance criteria from issue-06 / PRD user story #3: after the
 * workspace deepening, all run-file fs calls and path literals are concentrated
 * in TaskWorkspace / WorkspaceStore. No caller in spawner, process-registry,
 * or the extension entrypoint (index.ts) constructs a workspace path or calls
 * fs on a run-produced file (task.md, manifest.json, events.jsonl,
 * progress.jsonl, output.md, run.log, process.json).
 *
 * ADR-0002 allows exactly one path literal in the spawner:
 *   `join(workDir, ".pi", "subagents")`  — the subagents root handed to
 *   `new WorkspaceStore(...)`. That is NOT a run file and is permitted.
 */
describe("spawner — no run-file fs/path leakage", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spawnerSrc = readFileSync(join(here, "..", "src", "spawner.ts"), "utf-8");

  const RUN_FILES = [
    "task.md",
    "manifest.json",
    "events.jsonl",
    "progress.jsonl",
    "output.md",
    "run.log",
    "process.json",
  ];

  const FS_SYNC_CALLS = [
    "writeFileSync",
    "readFileSync",
    "appendFileSync",
    "existsSync",
    "mkdirSync",
    "statSync",
    "copyFileSync",
    "unlinkSync",
    "rmSync",
    "rmdirSync",
    "readdirSync",
  ];

  /** Strip //-style and block comments so commented-out code can't mask a leak. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
  }

  it("does not import fs sync primitives for run files (readdirSync for agent defs is allowed)", () => {
    // readdirSync is the ONLY fs sync primitive the spawner may import, and
    // only for listing agent definitions — never a run file.
    const fsImports = spawnerSrc
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l))
      .filter((l) => /\bfrom\s+["'](?:node:)?fs["']/.test(l));

    for (const line of fsImports) {
      for (const call of FS_SYNC_CALLS) {
        if (call === "readdirSync") continue; // permitted for agent defs
        expect(line, `spawner must not import ${call} from fs`).not.toContain(call);
      }
    }
  });

  it("does not call fs sync primitives directly (all run-file I/O goes through the workspace)", () => {
    const code = stripComments(spawnerSrc);
    for (const call of FS_SYNC_CALLS) {
      if (call === "readdirSync") continue; // permitted for agent definitions
      const callPattern = new RegExp(`\\b${call}\\s*\\(`);
      expect(
        code,
        `spawner must not call ${call}( directly — use TaskWorkspace`,
      ).not.toMatch(callPattern);
    }
  });

  it("does not join a taskDir path to a run-file name", () => {
    const code = stripComments(spawnerSrc);
    // Catch `join(taskDir, "output.md")`, `join(ws.directory, "task.md")`, etc.
    for (const file of RUN_FILES) {
      const joinToFile = new RegExp(
        `join\\s*\\([^)]*\\b(?:taskDir|ws\\.directory|workspace\\.directory|dir)\\b[^)]*["'\`]${file}["'\`]`,
      );
      expect(
        code,
        `spawner must not join a taskDir to ${file} — use the workspace`,
      ).not.toMatch(joinToFile);
    }
  });

  it("does not construct any run-file path literal outside the workspace", () => {
    // The only path literal the spawner owns is the subagents ROOT
    // `join(workDir, ".pi", "subagents")` (ADR-0002). Run-file names may appear
    // in string literals only inside error messages (e.g. "no output.md"),
    // never as an argument to join() or fs.
    const code = stripComments(spawnerSrc);

    // Permitted literal: the subagents root handed to WorkspaceStore.
    const rootLiteral = /join\(\s*workDir,\s*"\.pi",\s*"subagents"\s*\)/;
    expect(code, "the only spawner-owned path literal is the subagents root").toMatch(
      rootLiteral,
    );

    // No run-file name may appear as a join() argument.
    for (const file of RUN_FILES) {
      const joinWithFile = new RegExp(`join\\s*\\([^)]*["'\`]${file}["'\`]`);
      expect(
        code,
        `spawner must not pass ${file} to join() — workspace owns run-file paths`,
      ).not.toMatch(joinWithFile);
    }
  });

  it("routes run-file writes/reads through the workspace (TaskWorkspace import present)", () => {
    expect(spawnerSrc, "spawner must import TaskWorkspace").toMatch(
      /import(?:\s+type)?\s+\{[^}]*\bTaskWorkspace\b[^}]*\}\s+from\s+["']\.\/task-workspace\.js["']/,
    );
  });

  it("creates its task workspace through WorkspaceStore.create (issue-05 AC3)", () => {
    // The spawner must own exactly one path literal — the subagents root —
    // hand it to `new WorkspaceStore(...)`, and create the task workspace via
    // `store.create(agentId)`. If a later change reverts to a direct
    // `TaskWorkspace.create(join(...))` or `mkdirSync` for the agent dir, this
    // fails. Behavioral coverage exists in spawner.test.ts (it reopens via
    // `new WorkspaceStore(...).open(agentId)`), but this pin makes the
    // invariant explicit at the source level.
    expect(spawnerSrc, "spawner must import WorkspaceStore").toMatch(
      /import(?:\s+type)?\s+\{[^}]*\bWorkspaceStore\b[^}]*\}\s+from\s+["']\.\/workspace-store\.js["']/,
    );
    expect(spawnerSrc, "spawner must construct a WorkspaceStore with the subagents root").toMatch(
      /new\s+WorkspaceStore\s*\(\s*join\s*\(\s*workDir,\s*"\.pi",\s*"subagents"\s*\)\s*\)/,
    );
    expect(spawnerSrc, "spawner must create the workspace via store.create(agentId)").toMatch(
      /store\.create\s*\(\s*agentId\s*\)/,
    );
  });
});

// ── Shared constants and helpers ──

const RUN_FILES = [
  "task.md",
  "manifest.json",
  "events.jsonl",
  "progress.jsonl",
  "output.md",
  "run.log",
  "process.json",
];

const FS_SYNC_CALLS = [
  "writeFileSync",
  "readFileSync",
  "appendFileSync",
  "existsSync",
  "mkdirSync",
  "statSync",
  "copyFileSync",
  "unlinkSync",
  "rmSync",
  "rmdirSync",
  "readdirSync",
];

/** Strip //-style and block comments so commented-out code can't mask a leak. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// ── process-registry sweep ──

describe("process-registry — no run-file fs/path leakage (deletion-test sweep)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const registrySrc = readFileSync(join(here, "..", "src", "process-registry.ts"), "utf-8");

  it("does not import any fs sync primitives (pure process concern)", () => {
    const fsImports = registrySrc
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l))
      .filter((l) => /\bfrom\s+["'](?:node:)?fs["']/.test(l));

    expect(
      fsImports,
      "process-registry must not import from fs — it is a pure process concern",
    ).toHaveLength(0);
  });

  it("does not call any fs sync primitive directly", () => {
    const code = stripComments(registrySrc);
    for (const call of FS_SYNC_CALLS) {
      const callPattern = new RegExp(`\\b${call}\\s*\\(`);
      expect(
        code,
        `process-registry must not call ${call}( directly — use TaskWorkspace`,
      ).not.toMatch(callPattern);
    }
  });

  it("does not contain any run-file path literal in actual code (comments only)", () => {
    // Run-file names may appear in comments explaining the workspace seam,
    // but never in executable code — not in join(), not in fs calls, not in
    // any expression that constructs or references a run file.
    const code = stripComments(registrySrc);
    for (const file of RUN_FILES) {
      expect(
        code,
        `process-registry must not reference ${file} in executable code`,
      ).not.toContain(file);
    }
  });

  it("routes all workspace I/O through the workspace/store seam", () => {
    expect(
      registrySrc,
      "process-registry must import WorkspaceStore type",
    ).toMatch(
      /import\s+type\s+\{[^}]*\bWorkspaceStore\b[^}]*\}\s+from\s+["']\.\/workspace-store\.js["']/,
    );
    expect(
      registrySrc,
      "process-registry must import TaskWorkspace type",
    ).toMatch(
      /import\s+type\s+\{[^}]*\bTaskWorkspace\b[^}]*\}\s+from\s+["']\.\/task-workspace\.js["']/,
    );
  });
});

// ── entrypoint (index.ts) sweep ──

describe("extension entrypoint — no run-file fs/path leakage (deletion-test sweep)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");

  it("does not call fs sync primitives on run-produced files", () => {
    // index.ts may use fs for config files (models.json, settings.json) but
    // NEVER for run-produced files (task.md, manifest.json, events.jsonl,
    // progress.jsonl, output.md, run.log, process.json). The workspace owns
    // all run-file I/O.
    const code = stripComments(indexSrc);

    // For each run file, assert no fs sync call references it.
    for (const file of RUN_FILES) {
      const escaped = file.replace(/\./g, "\\.");
      // Match fs call + any reference to this run file within a reasonable window
      for (const call of FS_SYNC_CALLS) {
        const pattern = new RegExp(`\\b${call}\\s*\\([^)]*['"\`]${escaped}['"\`]`);
        expect(
          code,
          `entrypoint must not use ${call}(${file}) — use TaskWorkspace`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("does not pass any run-file name to join() as a path segment", () => {
    const code = stripComments(indexSrc);
    for (const file of RUN_FILES) {
      const escaped = file.replace(/\./g, "\\.");
      const joinPattern = new RegExp(`join\\s*\\([^)]*['"\`]${escaped}['"\`]`);
      expect(
        code,
        `entrypoint must not join path to ${file} — use TaskWorkspace`,
      ).not.toMatch(joinPattern);
    }
  });

  it("does not reference any run-produced file in non-comment code", () => {
    // The strongest and simplest invariant: run-file names (task.md,
    // manifest.json, events.jsonl, progress.jsonl, output.md, run.log,
    // process.json) must not appear anywhere in index.ts executable code.
    // They may appear in comments or error messages in the workspace module,
    // but the entrypoint never touches them.
    const code = stripComments(indexSrc);
    for (const file of RUN_FILES) {
      expect(
        code,
        `entrypoint must not reference ${file} in executable code — use TaskWorkspace`,
      ).not.toContain(file);
    }
  });
});