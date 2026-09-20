import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import personasExtension from "./index.js";

// ── Fake extension API ───────────────────────────────────────────────

type FakeHandler = (event: any, ctx: any) => unknown;

function createFakePi() {
  const handlers = new Map<string, FakeHandler[]>();
  const commands: Array<{ name: string; options: any }> = [];
  const tools: unknown[] = [];
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const messages: Array<{ customType: string; content: string }> = [];

  const pi = {
    on: (event: string, handler: FakeHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, options: any) => commands.push({ name, options }),
    registerTool: (tool: unknown) => tools.push(tool),
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
    sendMessage: (message: { customType: string; content: string }) =>
      messages.push(message),
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    handlers,
    commands,
    tools,
    entries,
    messages,
    sendUserMessage: pi.sendUserMessage,
  };
}

type FakePi = ReturnType<typeof createFakePi>;

function getHandlers(fake: FakePi, event: string): FakeHandler[] {
  const found = fake.handlers.get(event);
  expect(found, `no handler registered for "${event}"`).toBeDefined();
  return found!;
}

function commandHandler(fake: FakePi, name = "persona"): FakeHandler {
  const command = fake.commands.find((c) => c.name === name);
  expect(command, `command "${name}" not registered`).toBeDefined();
  return command!.options.handler;
}

// ── Scripted UI context ──────────────────────────────────────────────

function createContext(overrides: Record<string, unknown> = {}) {
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    theme: { fg: (_name: string, text: string) => text },
  };
  const ctx = {
    cwd: "/tmp/test-project",
    hasUI: true,
    mode: "tui",
    ui,
    isIdle: () => true,
    waitForIdle: async () => {},
    sessionManager: { getEntries: () => [], getSessionFile: () => "/tmp/session.jsonl" },
    ...overrides,
  };
  return { ctx, ui, notify: ui.notify, setStatus: ui.setStatus };
}

// ── Temp persona directories ─────────────────────────────────────────

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePersonaDefinition(
  dir: string,
  stem: string,
  fields: Record<string, string> = {},
  body = `You are the ${stem} persona.`,
): string {
  const yamlLines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  const content = `---\n${yamlLines.join("\n")}\n---\n${body}`;
  writeFileSync(join(dir, `${stem}.md`), content, "utf8");
  return content;
}

function makeGlobalDir(): string {
  return makeTempDir("personas-global-");
}

const BUILT_IN_PROMPT = "You are pi, a coding agent.";

function beforeAgentStart(fake: FakePi, event: Partial<{ systemPrompt: string; prompt: string }> = {}) {
  const [handler] = getHandlers(fake, "before_agent_start");
  return handler(
    { type: "before_agent_start", prompt: "hello", systemPrompt: BUILT_IN_PROMPT, ...event },
    createContext().ctx,
  );
}

function switchTo(fake: FakePi, args: string) {
  const { ctx, notify, setStatus } = createContext();
  const promise = commandHandler(fake)(args, ctx);
  return { promise, notify, setStatus };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// ── Tests ────────────────────────────────────────────────────────────

describe("personas extension", () => {
  describe("loading without a global persona directory", () => {
    it("registers only the persona command and no tools", () => {
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir: join(makeTempDir("personas-missing-"), "gone") });

      expect(fake.commands).toHaveLength(1);
      expect(fake.commands[0].name).toBe("persona");
      expect(fake.commands[0].options.description).toBeTypeOf("string");
      expect(fake.tools).toHaveLength(0);
    });

    it("per-turn hook returns nothing when no persona is active", () => {
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir: join(makeTempDir("personas-missing-"), "gone") });

      expect(beforeAgentStart(fake)).toBeUndefined();
    });
  });

  describe("/persona <name> switches from the global directory", () => {
    it("switches to a valid persona and shows it in the status line", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", {
        name: "mentor",
        description: "Guides learning",
      });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify, setStatus } = switchTo(fake, "mentor");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(notify).toHaveBeenCalled();
    });

    it("composes built-in prompt plus persona body on every subsequent turn", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      const first = beforeAgentStart(fake);
      const second = beforeAgentStart(fake, { systemPrompt: "A different built-in prompt" });

      expect(first).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
      expect(second).toEqual({ systemPrompt: "A different built-in prompt\n\nMentor the user." });
    });

    it("leaves the session and conversation history untouched", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      await switchTo(fake, "mentor").promise;

      expect(fake.entries).toHaveLength(0);
      expect(fake.messages).toHaveLength(0);
      expect(fake.sendUserMessage).not.toHaveBeenCalled();
    });

    it("switching again replaces the active persona", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      writePersonaDefinition(globalDir, "reviewer", { name: "reviewer" }, "Review skeptically.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      await switchTo(fake, "mentor").promise;
      await switchTo(fake, "reviewer").promise;

      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nReview skeptically.`,
      });
      expect(beforeAgentStart(fake, { systemPrompt: BUILT_IN_PROMPT }).systemPrompt).not.toContain(
        "Mentor the user.",
      );
    });
  });

  describe("prompt composition modes", () => {
    it("defaults to append mode when systemPromptMode is omitted", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });

    it("append mode keeps the built-in prompt when systemPromptMode is append", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", systemPromptMode: "append" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)?.systemPrompt).toContain(BUILT_IN_PROMPT);
    });

    it("replace-mode personas are not switchable in this slice", async () => {
      // Ticket 0063 adds replace-mode switching together with its confirmation.
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "ghost", { name: "ghost", systemPromptMode: "replace" }, "Be a ghost.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify, setStatus } = switchTo(fake, "ghost");
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("replace"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("caches the active definition: per-turn application never re-reads disk until re-switched", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Version one.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Version two.");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nVersion one.` });

      await switchTo(fake, "mentor").promise;
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nVersion two.` });
    });
  });

  describe("frontmatter validation", () => {
    it("unknown frontmatter field produces a parse error on direct switch", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "broken", { name: "broken", colour: "blue" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify, setStatus } = switchTo(fake, "broken");
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("colour"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("missing name produces a parse error", async () => {
      const globalDir = makeGlobalDir();
      writeFileSync(join(globalDir, "noname.md"), "---\ndescription: nothing\n---\nBody.", "utf8");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify } = switchTo(fake, "noname");
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("name"), "warning");
    });

    it("invalid systemPromptMode value produces a parse error", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "sideways", { name: "sideways", systemPromptMode: "sideways" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify } = switchTo(fake, "sideways");
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("systemPromptMode"), "warning");
    });

    it("broken files do not prevent valid personas from switching", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "broken", { name: "broken", colour: "blue" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });
  });

  describe("unknown persona names", () => {
    it("notifies with available personas and keeps no persona active", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify, setStatus } = switchTo(fake, "mentor");
      await promise;
      (notify as any).mockClear();
      (setStatus as any).mockClear();

      const unknown = switchTo(fake, "mentor typo");
      await unknown.promise;

      expect(unknown.notify).toHaveBeenCalledWith(
        expect.stringContaining("Available: mentor"),
        "warning",
      );
      expect(unknown.setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake).systemPrompt).toContain("Mentor the user.");
    });
  });

  describe("/persona with no arguments", () => {
    it("lists available personas and broken definitions with their errors", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", description: "Guides learning" });
      writePersonaDefinition(globalDir, "broken", { name: "broken", colour: "blue" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify } = switchTo(fake, "");
      await promise;

      const listing = String(notify.mock.calls[0]?.[0]);
      expect(listing).toContain("mentor");
      expect(listing).toContain("Guides learning");
      expect(listing).toContain("broken.md");
      expect(listing).toContain("colour");
    });
  });

  describe("injected directories", () => {
    it("accepts project/global/bundled options and wires the global directory", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, {
        projectDir: makeGlobalDir(),
        globalDir,
        bundledDir: makeGlobalDir(),
      });

      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });

    it("project personas are not wired in this slice", async () => {
      // Ticket 0062 wires the project persona directory; this pins the slice boundary.
      const projectDir = makeGlobalDir();
      mkdirSync(join(projectDir, "personas"), { recursive: true });
      writePersonaDefinition(join(projectDir, "personas"), "local", { name: "local" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { projectDir });

      const { promise, notify } = switchTo(fake, "local");
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("local"), "warning");
      expect(beforeAgentStart(fake)).toBeUndefined();
    });
  });
});