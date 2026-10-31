// Run: node --experimental-vm-modules --test extensions/web-search/startup.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";

const source = stripTypeScriptTypes(await readFile(new URL("./index.ts", import.meta.url), "utf8"));

async function setup({ content = "document content", failImport = false } = {}) {
  const loaded = new Set(), tools = new Map(), commands = new Map(), events = new Map();
  const calls = [], artifacts = [], messages = [];
  const context = createContext({ __dirname: "/extension" });
  const modules = {
    "@earendil-works/pi-ai/compat": { StringEnum: () => ({}) },
    typebox: { Type: new Proxy({}, { get: () => () => ({}) }) },
    "node:fs": { existsSync: () => false },
    "node:path": { join: (...parts) => parts.join("/") },
    "node:os": { homedir: () => "/isolated-home" },
    "./src/search.js": { search: async () => ({ results: [] }) },
    "./src/fetch.js": { fetchUrl: async (url, options) => {
      calls.push({ url, options });
      return { url, statusCode: 200, content, format: options.format };
    } },
    "./src/representation.js": { writeContentArtifact: (text, format) => {
      artifacts.push({ text, format });
      return "/artifact/document.md";
    } },
  };
  const cache = new Map();
  function resolve(specifier) {
    loaded.add(specifier);
    if (failImport && specifier === "./src/fetch.js") throw new Error("fetch module unavailable");
    assert.ok(modules[specifier], `unexpected import: ${specifier}`);
    if (!cache.has(specifier)) {
      const exports = modules[specifier];
      cache.set(specifier, new SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context }));
    }
    return cache.get(specifier);
  }
  const module = new SourceTextModule(source, {
    context,
    importModuleDynamically: async (specifier) => {
      const dependency = resolve(specifier);
      if (dependency.status === "unlinked") await dependency.link(resolve);
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    },
  });
  await module.link(resolve);
  await module.evaluate();
  module.namespace.default({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    sendMessage: (message) => messages.push(message),
  });
  return { loaded, tools, commands, events, calls, artifacts, messages };
}

const ctx = { ui: { notify() {} } };

test("registration and session start do not load fetch/parser modules", async () => {
  const app = await setup();
  await app.events.get("session_start")({}, ctx);
  assert.equal(app.tools.size, 2);
  assert.equal(app.loaded.has("./src/fetch.js"), false);
  assert.equal(app.loaded.has("./src/representation.js"), false);
});

test("first web_fetch lazily loads the fetcher and returns formatted text", async () => {
  const app = await setup();
  const result = await app.tools.get("web_fetch").execute("call", { url: "https://example.test", raw: true });
  assert.equal(app.loaded.has("./src/fetch.js"), true);
  assert.match(result.content[0].text, /document content/);
  assert.equal(app.calls[0].options.raw, true);
});

test("large content still produces an artifact and bounded preview", async () => {
  const content = "x".repeat(2000);
  const app = await setup({ content });
  const result = await app.tools.get("web_fetch").execute("call", { url: "https://example.test" });
  assert.equal(app.artifacts[0].text, content);
  assert.match(result.content[0].text, /Full content.*artifact\/document.md/);
  assert.ok(!result.content[0].text.includes(content));
});

test("web-fetch command awaits the formatter", async () => {
  const app = await setup();
  await app.commands.get("web-fetch").handler("https://example.test --format text", ctx);
  assert.equal(typeof app.messages[0].content, "string");
  assert.match(app.messages[0].content, /document content/);
  assert.equal(app.calls[0].options.format, "text");
});

test("deferred import errors use the existing fetch error result", async () => {
  const app = await setup({ failImport: true });
  const result = await app.tools.get("web_fetch").execute("call", { url: "https://example.test" });
  assert.match(result.content[0].text, /Fetch failed: fetch module unavailable/);
});
