// Run: node --experimental-vm-modules --test extensions/deep-research/startup.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";

const source = stripTypeScriptTypes(await readFile(new URL("./index.ts", import.meta.url), "utf8"));

async function setup({ failImport = false } = {}) {
  const context = createContext({ Error, console: { warn() {} } });
  const tools = new Map(), calls = [];
  let imports = 0;
  const exports = {
    typebox: { Type: new Proxy({}, { get: () => () => ({}) }) },
    fs: { existsSync() {}, readFileSync() {}, writeFileSync() {} },
    path: { join: (...parts) => parts.join("/") },
    os: { homedir: () => "/isolated-home" },
    "./config.js": { loadDeepresearchConfig: () => ({ config: {} }) },
    "../subagents/src/config.js": { loadSubagentsEnabled: () => true },
    "./state-manager.js": { ResearchStateManager: class {} },
    "../subagents/index.js": { spawnSubagent: async (options) => {
      calls.push(options);
      return { output: options.task, agentId: options.task, agentType: options.agentType };
    } },
  };
  function resolve(specifier) {
    if (specifier === "../subagents/index.js") imports++;
    assert.ok(exports[specifier], `unexpected import: ${specifier}`);
    const values = exports[specifier];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  }
  const module = new SourceTextModule(source, {
    context,
    importModuleDynamically: async (specifier) => {
      const dependency = resolve(specifier);
      // Yield so concurrent first calls overlap while the import is pending.
      await Promise.resolve();
      if (failImport) throw new Error("barrel unavailable");
      await dependency.link(resolve);
      await dependency.evaluate();
      return dependency;
    },
  });
  await module.link(resolve);
  await module.evaluate();
  module.namespace.default({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand() {},
  });
  const execute = (task, signal) => tools.get("spawn_research_subagent").execute(
    task, { agent_type: "r-search", prompt: task }, signal, undefined, { cwd: "/isolated-work" },
  );
  return { imports: () => imports, calls, execute };
}

test("registration defers subagents; concurrent and repeated calls share one import", async () => {
  const app = await setup();
  assert.equal(app.imports(), 0);
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([app.execute("task-a", signal), app.execute("task-b", signal)]);
  assert.equal(app.imports(), 1);
  assert.equal(a.content[0].text, "task-a");
  assert.equal(b.content[0].text, "task-b");
  assert.equal(app.calls.length, 2);
  assert.ok(app.calls.every((call) => call.signal === signal));
  await app.execute("task-c", signal);
  assert.equal(app.imports(), 1);
});

test("failed shared import returns the existing retry-exhausted error result", async () => {
  const app = await setup({ failImport: true });
  const result = await app.execute("task");
  assert.equal(app.imports(), 1);
  assert.equal(app.calls.length, 0);
  assert.equal(result.details.retried, true);
  assert.match(result.content[0].text, /failed after retry: barrel unavailable/);
});
