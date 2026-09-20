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
  const messages: Array<{ customType: string; content: string; display?: boolean }> = [];

  const pi = {
    on: (event: string, handler: FakeHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, options: any) => commands.push({ name, options }),
    registerTool: (tool: unknown) => tools.push(tool),
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
    sendMessage: (message: { customType: string; content: string; display?: boolean }) =>
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

function switchTo(fake: FakePi, args: string, overrides: Record<string, unknown> = {}) {
  const { ctx, ui, notify, setStatus } = createContext(overrides);
  const promise = commandHandler(fake)(args, ctx);
  return { promise, ui, notify, setStatus };
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
      expect(fake.entries).toHaveLength(0);
      expect(fake.messages).toHaveLength(0);
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
    it("opens a selector listing every persona plus the Default entry", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", description: "Guides learning" });
      writePersonaDefinition(globalDir, "reviewer", { name: "reviewer" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, ui } = switchTo(fake, "");
      await promise;

      expect(ui.select).toHaveBeenCalledWith("Switch persona", [
        "mentor — Guides learning",
        "reviewer",
        "Default — pi's built-in prompt",
      ]);
    });

    it("surfaces broken definitions as warnings but leaves them out of the selector", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "broken", { name: "broken", colour: "blue" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, ui, notify } = switchTo(fake, "");
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("colour"), "warning");
      expect(ui.select).toHaveBeenCalledWith("Switch persona", [
        "mentor",
        "Default — pi's built-in prompt",
      ]);
    });

    it("switches to the persona chosen in the selector", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, ui, setStatus } = switchTo(fake, "");
      ui.select.mockResolvedValue("mentor");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });

    it("selecting Default clears the active persona and the status line", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      const { promise, ui, setStatus } = switchTo(fake, "");
      ui.select.mockResolvedValue("Default — pi's built-in prompt");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
      expect(fake.entries.at(-1)).toEqual({ customType: "personas-state", data: { persona: undefined } });
      expect(fake.messages.at(-1)?.content).toBe("Persona switched: default — pi's built-in prompt");
    });

    it("prefers a colliding persona label over the Default entry", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(
        globalDir,
        "default",
        { name: "Default", description: "pi's built-in prompt" },
        "Actual persona.",
      );
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, ui, setStatus } = switchTo(fake, "");
      ui.select.mockResolvedValue("Default — pi's built-in prompt");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:Default");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nActual persona.` });
    });

    it("re-checks idle after the picker resolves and rejects if a run started", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      let idle = true;

      const { promise, ui, notify, setStatus } = switchTo(fake, "", {
        isIdle: () => idle,
        waitForIdle: async () => {},
      });
      ui.select.mockImplementation(async () => {
        idle = false;
        return "mentor";
      });
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("rejected"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("cancelling the selector changes nothing", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      const { promise, ui, setStatus } = switchTo(fake, "");
      ui.select.mockResolvedValue(undefined);
      await promise;

      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake).systemPrompt).toContain("Mentor the user.");
    });
  });

  describe("clearing aliases", () => {
    it.each(["off", "default", "none"])("/persona %s clears the active persona and status line", async (alias) => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      const { promise, setStatus } = switchTo(fake, alias);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });
  });

  describe("session persistence and switch notices", () => {
    const stateEntry = (persona: string | undefined) => ({
      type: "custom",
      customType: "personas-state",
      data: { persona },
    });

    function sessionStart(
      fake: FakePi,
      entries: unknown[],
      reason: "startup" | "reload" | "new" | "resume" | "fork" = "resume",
    ) {
      const { ctx, notify, setStatus } = createContext({
        sessionManager: { getEntries: () => entries, getSessionFile: () => "/tmp/session.jsonl" },
      });
      const [handler] = getHandlers(fake, "session_start");
      return { promise: handler({ type: "session_start", reason }, ctx), notify, setStatus };
    }

    function recordedEntries(fake: FakePi): unknown[] {
      return fake.entries.map((entry, index) => ({ type: "custom", id: `e${index}`, ...entry }));
    }

    it("switching to a persona appends a persona-state entry that is not a context message", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      await switchTo(fake, "mentor").promise;

      expect(fake.entries).toEqual([{ customType: "personas-state", data: { persona: "mentor" } }]);
      expect(fake.sendUserMessage).not.toHaveBeenCalled();
    });

    it("entering a persona injects a context-visible switch notice with name and description", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", description: "Guides learning" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      await switchTo(fake, "mentor").promise;

      expect(fake.messages).toEqual([
        {
          customType: "personas-switch-notice",
          content: "Persona switched: mentor — Guides learning",
          display: true,
        },
      ]);
    });

    it("every persona-to-persona switch injects its own notice", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", description: "Mentors." }, "Mentor the user.");
      writePersonaDefinition(globalDir, "reviewer", { name: "reviewer", description: "Reviews." }, "Review skeptically.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      await switchTo(fake, "mentor").promise;
      await switchTo(fake, "reviewer").promise;

      expect(fake.messages.map((message) => message.content)).toEqual([
        "Persona switched: mentor — Mentors.",
        "Persona switched: reviewer — Reviews.",
      ]);
    });

    it("a persona without a description gets a notice naming just the persona", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      await switchTo(fake, "mentor").promise;

      expect(fake.messages[0]?.content).toBe("Persona switched: mentor");
    });

    it("returning to default injects the default-shaped notice and records the cleared state", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      await switchTo(fake, "off").promise;

      expect(fake.entries).toEqual([
        { customType: "personas-state", data: { persona: "mentor" } },
        { customType: "personas-state", data: { persona: undefined } },
      ]);
      expect(fake.messages).toEqual([
        { customType: "personas-switch-notice", content: "Persona switched: mentor", display: true },
        {
          customType: "personas-switch-notice",
          content: "Persona switched: default — pi's built-in prompt",
          display: true,
        },
      ]);
    });

    it("a rejected switch records nothing and injects no notice", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;
      const entriesBefore = [...fake.entries];
      const messagesBefore = [...fake.messages];

      const unknown = switchTo(fake, "ghost");
      await unknown.promise;

      expect(unknown.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown persona"), "warning");
      expect(fake.entries).toEqual(entriesBefore);
      expect(fake.messages).toEqual(messagesBefore);
    });

    it("session-start restores the active persona from the last persona-state entry", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, setStatus } = sessionStart(fake, [
        { type: "message", role: "user", content: "earlier" },
        stateEntry("mentor"),
      ]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
      expect(fake.messages).toHaveLength(0);
    });

    it("the latest persona-state entry wins when several were recorded", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      writePersonaDefinition(globalDir, "reviewer", { name: "reviewer" }, "Review skeptically.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, setStatus } = sessionStart(fake, [stateEntry("mentor"), stateEntry("reviewer")]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:reviewer");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nReview skeptically.` });
    });

    it("a cleared-state entry resumes with no persona", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, setStatus } = sessionStart(fake, [stateEntry("mentor"), stateEntry(undefined)]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("sessions recorded before this extension have no persona entry and start with none", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, setStatus } = sessionStart(fake, [{ type: "message", role: "user", content: "hi" }]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("a persona-state entry with malformed data starts with none", async () => {
      const globalDir = makeGlobalDir();
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, setStatus } = sessionStart(fake, [
        { type: "custom", customType: "personas-state", data: { persona: 42 } },
      ]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("a saved persona whose definition no longer exists resumes with none and a warning", async () => {
      const globalDir = makeGlobalDir();
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify, setStatus } = sessionStart(fake, [stateEntry("ghost")]);
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("ghost"), "warning");
      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("a forked child session (BTW) honors the parent's active persona", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, setStatus } = sessionStart(fake, [stateEntry("mentor")], "fork");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
    });

    it("the persona survives compaction: the override still applies and the entry stays restorable", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });

      const { promise, setStatus } = sessionStart(fake, [...recordedEntries(fake), { type: "compaction", id: "c1" }], "reload");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
    });

    it("persona → persona → default → persona keeps the right entry, notice, and status at each step", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", description: "Guides learning" }, "Mentor the user.");
      writePersonaDefinition(globalDir, "reviewer", { name: "reviewer", description: "Reviews." }, "Review skeptically.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const first = switchTo(fake, "mentor");
      await first.promise;
      expect(first.setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(fake.entries.at(-1)).toEqual({ customType: "personas-state", data: { persona: "mentor" } });
      expect(fake.messages.at(-1)?.content).toBe("Persona switched: mentor — Guides learning");

      const second = switchTo(fake, "reviewer");
      await second.promise;
      expect(second.setStatus).toHaveBeenCalledWith("persona", "persona:reviewer");
      expect(fake.entries.at(-1)).toEqual({ customType: "personas-state", data: { persona: "reviewer" } });
      expect(fake.messages.at(-1)?.content).toBe("Persona switched: reviewer — Reviews.");

      const third = switchTo(fake, "default");
      await third.promise;
      expect(third.setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(fake.entries.at(-1)).toEqual({ customType: "personas-state", data: { persona: undefined } });
      expect(fake.messages.at(-1)?.content).toBe("Persona switched: default — pi's built-in prompt");
      expect(beforeAgentStart(fake)).toBeUndefined();

      const fourth = switchTo(fake, "mentor");
      await fourth.promise;
      expect(fourth.setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(fake.entries.at(-1)).toEqual({ customType: "personas-state", data: { persona: "mentor" } });
      expect(fake.messages.at(-1)?.content).toBe("Persona switched: mentor — Guides learning");

      const resume = sessionStart(fake, recordedEntries(fake));
      await resume.promise;
      expect(resume.setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
    });
  });

  describe("idle guard", () => {
    it("waits for idle before applying the switch", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });
      let idle = false;

      const { promise, notify, setStatus } = switchTo(fake, "mentor", {
        isIdle: () => idle,
        waitForIdle: async () => {
          idle = true;
        },
      });
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("rejected"), "warning");
    });

    it("rejects the switch with a notification when the agent is still running after waiting", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify, setStatus } = switchTo(fake, "mentor", {
        isIdle: () => false,
        waitForIdle: async () => {},
      });
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("rejected"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("rejects the switch when waiting for idle is aborted", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = createFakePi();
      personasExtension(fake.pi as any, { globalDir });

      const { promise, notify, setStatus } = switchTo(fake, "mentor", {
        isIdle: () => false,
        waitForIdle: async () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          throw abortError;
        },
      });
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("rejected"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
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