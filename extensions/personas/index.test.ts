import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import personasExtension from "./index.js";
import { parsePersonaDefinition, type PersonaDefinition } from "./persona-definition-parser.js";
import { sessionSettingsArgs } from "./persona-session-args.js";

// ── Fake extension API ───────────────────────────────────────────────

type FakeHandler = (event: any, ctx: any) => unknown;

function createFakePi() {
  const handlers = new Map<string, FakeHandler[]>();
  const commands: Array<{ name: string; options: any }> = [];
  const tools: unknown[] = [];
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const messages: Array<{ customType: string; content: string; display?: boolean }> = [];
  const messageOptions: unknown[] = [];

  const pi = {
    on: (event: string, handler: FakeHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, options: any) => commands.push({ name, options }),
    registerTool: (tool: unknown) => tools.push(tool),
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
    sendMessage: (message: { customType: string; content: string; display?: boolean }, options?: unknown) => {
      messages.push(message);
      messageOptions.push(options);
    },
    sendUserMessage: vi.fn(),
    exec: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "", killed: false })),
  };

  return {
    pi,
    handlers,
    commands,
    tools,
    entries,
    messages,
    messageOptions,
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
    input: vi.fn(),
  };
  const ctx = {
    cwd: "/tmp/test-project",
    hasUI: true,
    mode: "tui",
    ui,
    isIdle: () => true,
    waitForIdle: async () => {},
    isProjectTrusted: () => true,
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
): void {
  const yamlLines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  const content = `---\n${yamlLines.join("\n")}\n---\n${body}`;
  writeFileSync(join(dir, `${stem}.md`), content, "utf8");
}

function makeGlobalDir(): string {
  return makeTempDir("personas-global-");
}

function missingDir(): string {
  return join(makeTempDir("personas-missing-"), "gone");
}

// Standard instantiation: fake pi plus directory options.
function setup(options: Record<string, unknown> = {}): FakePi {
  const fake = createFakePi();
  personasExtension(fake.pi as any, options as any);
  return fake;
}

// setup plus one persona definition written into a fresh global directory.
function setupGlobalPersona(
  stem: string,
  fields: Record<string, string> = { name: stem },
  body = `You are the ${stem} persona.`,
): FakePi {
  const globalDir = makeGlobalDir();
  writePersonaDefinition(globalDir, stem, fields, body);
  return setup({ globalDir });
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

function stateEntry(persona: string | undefined) {
  return { type: "custom", customType: "personas-state", data: { persona } };
}

function sessionStart(
  fake: FakePi,
  entries: unknown[],
  reason: "startup" | "reload" | "new" | "resume" | "fork" = "resume",
) {
  const { ctx, ui, notify, setStatus } = createContext({
    sessionManager: { getEntries: () => entries, getSessionFile: () => "/tmp/session.jsonl" },
  });
  const [handler] = getHandlers(fake, "session_start");
  return { promise: handler({ type: "session_start", reason }, ctx), ui, notify, setStatus };
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
      const fake = setup({ globalDir: join(makeTempDir("personas-missing-"), "gone") });

      expect(fake.commands).toHaveLength(1);
      expect(fake.commands[0].name).toBe("persona");
      expect(fake.commands[0].options.description).toBeTypeOf("string");
      expect(fake.tools).toHaveLength(0);
    });

    it("per-turn hook returns nothing when no persona is active", () => {
      const fake = setup({ globalDir: join(makeTempDir("personas-missing-"), "gone") });

      expect(beforeAgentStart(fake)).toBeUndefined();
    });
  });

  describe("/persona <name> switches from the global directory", () => {
    it("switches to a valid persona and shows it in the status line", async () => {
      const fake = setupGlobalPersona("mentor", {
        name: "mentor",
        description: "Guides learning",
      });

      const { promise, notify, setStatus } = switchTo(fake, "mentor");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(notify).toHaveBeenCalled();
    });

    it("composes built-in prompt plus persona body on every subsequent turn", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");
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
      const fake = setup({ globalDir });

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
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");
      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });

    it("caches the active definition: per-turn application never re-reads disk until re-switched", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Version one.");
      const fake = setup({ globalDir });
      await switchTo(fake, "mentor").promise;

      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Version two.");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nVersion one.` });

      await switchTo(fake, "mentor").promise;
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nVersion two.` });
    });
  });

  describe("replace mode", () => {
    const CONTEXT_FILE = { path: "/tmp/test-project/AGENTS.md", content: "Project context body." };
    const SKILL = { name: "implement", description: "Implement tickets.", filePath: "/skills/implement/SKILL.md" };
    const REPLACE_OPTIONS = {
      cwd: "/tmp/test-project",
      selectedTools: ["read", "bash", "edit", "write"],
      contextFiles: [CONTEXT_FILE],
      skills: [SKILL],
    };

    // Simulates pi's fully assembled prompt: built-in core plus attached context and skills.
    function replaceModeEvent(overrides: Record<string, unknown> = {}) {
      return {
        systemPrompt: `${BUILT_IN_PROMPT}\n\n<project_context>\n\n${CONTEXT_FILE.content}\n</project_context>\n`,
        systemPromptOptions: REPLACE_OPTIONS,
        ...overrides,
      };
    }

    function makeReplaceDir(): string {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "ghost", { name: "ghost", systemPromptMode: "replace" }, "Be a ghost.");
      return globalDir;
    }

    it("uses the persona body as the custom prompt with project context and skills still attached", async () => {
      const fake = setup({ globalDir: makeReplaceDir() });

      const { promise, ui } = switchTo(fake, "ghost");
      ui.confirm.mockResolvedValue(true);
      await promise;

      const prompt = (beforeAgentStart(fake, replaceModeEvent()) as { systemPrompt: string }).systemPrompt;
      expect(prompt).toBe(
        `Be a ghost.

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="${CONTEXT_FILE.path}">
${CONTEXT_FILE.content}
</project_instructions>

</project_context>
${formatSkillsForPrompt([SKILL])}
Current working directory: /tmp/test-project`,
      );
      expect(prompt).not.toContain(BUILT_IN_PROMPT);
    });

    it("keeps the user's append prompt but drops the skills section when the read tool is absent", async () => {
      const fake = setup({ globalDir: makeReplaceDir() });

      const { promise, ui } = switchTo(fake, "ghost");
      ui.confirm.mockResolvedValue(true);
      await promise;

      const event = replaceModeEvent({
        systemPromptOptions: {
          cwd: "/tmp/test-project",
          selectedTools: ["bash"],
          appendSystemPrompt: "User append.",
          skills: [SKILL],
        },
      });
      const prompt = (beforeAgentStart(fake, event) as { systemPrompt: string }).systemPrompt;
      expect(prompt).toBe(
        "Be a ghost.\n\nUser append.\nCurrent working directory: /tmp/test-project",
      );
      expect(prompt).not.toContain("<available_skills>");
    });

    it("asks for confirmation before the first replace-mode switch applies", async () => {
      const fake = setup({ globalDir: makeReplaceDir() });

      const { promise, ui, setStatus } = switchTo(fake, "ghost");
      ui.confirm.mockResolvedValue(true);
      await promise;

      expect(ui.confirm).toHaveBeenCalledTimes(1);
      expect(ui.confirm.mock.calls[0][1]).toContain("built-in");
      expect(setStatus).toHaveBeenCalledWith("persona", "persona:ghost");
      expect(fake.entries).toEqual([{ customType: "personas-state", data: { persona: "ghost" } }]);
      expect(fake.messages.at(-1)?.content).toBe("Persona switched: ghost");
    });

    it("declining the confirmation leaves the active persona unchanged", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      writePersonaDefinition(globalDir, "ghost", { name: "ghost", systemPromptMode: "replace" }, "Be a ghost.");
      const fake = setup({ globalDir });
      await switchTo(fake, "mentor").promise;

      const { promise, ui, setStatus } = switchTo(fake, "ghost");
      ui.confirm.mockResolvedValue(false);
      await promise;

      expect(setStatus).not.toHaveBeenCalled();
      expect(fake.entries).toEqual([{ customType: "personas-state", data: { persona: "mentor" } }]);
      expect(fake.messages).toHaveLength(1);
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
    });

    it("confirming once means later replace-mode switches in the same session do not re-confirm", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "ghost", { name: "ghost", systemPromptMode: "replace" }, "Be a ghost.");
      writePersonaDefinition(globalDir, "wraith", { name: "wraith", systemPromptMode: "replace" }, "Haunt the code.");
      const fake = setup({ globalDir });

      const first = switchTo(fake, "ghost");
      first.ui.confirm.mockResolvedValue(true);
      await first.promise;
      const second = switchTo(fake, "wraith");
      await second.promise;

      expect(first.ui.confirm).toHaveBeenCalledTimes(1);
      expect(second.ui.confirm).not.toHaveBeenCalled();
      expect(second.setStatus).toHaveBeenCalledWith("persona", "persona:wraith");
      expect(beforeAgentStart(fake, replaceModeEvent()).systemPrompt).toContain("Haunt the code.");
    });

    it("a declined confirmation does not burn the one-time rule", async () => {
      const fake = setup({ globalDir: makeReplaceDir() });

      const declined = switchTo(fake, "ghost");
      declined.ui.confirm.mockResolvedValue(false);
      await declined.promise;

      const retried = switchTo(fake, "ghost");
      retried.ui.confirm.mockResolvedValue(true);
      await retried.promise;

      expect(retried.ui.confirm).toHaveBeenCalledTimes(1);
      expect(beforeAgentStart(fake, replaceModeEvent()).systemPrompt).toContain("Be a ghost.");
    });

    it("a new session re-arms the confirmation", async () => {
      const fake = setup({ globalDir: makeReplaceDir() });

      const first = switchTo(fake, "ghost");
      first.ui.confirm.mockResolvedValue(true);
      await first.promise;

      await sessionStart(fake, [], "new").promise;

      const again = switchTo(fake, "ghost");
      await again.promise;

      expect(first.ui.confirm).toHaveBeenCalledTimes(1);
      expect(again.ui.confirm).toHaveBeenCalledTimes(1);
    });

    it("restoring a replace-mode persona on resume does not re-confirm, and later switches stay confirmation-free", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "ghost", { name: "ghost", systemPromptMode: "replace" }, "Be a ghost.");
      writePersonaDefinition(globalDir, "wraith", { name: "wraith", systemPromptMode: "replace" }, "Haunt the code.");
      const fake = setup({ globalDir });

      const resume = sessionStart(fake, [stateEntry("ghost")]);
      await resume.promise;

      expect(resume.ui.confirm).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake, replaceModeEvent()).systemPrompt).toContain("Be a ghost.");

      const later = switchTo(fake, "wraith");
      await later.promise;

      expect(later.ui.confirm).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake, replaceModeEvent()).systemPrompt).toContain("Haunt the code.");
    });

    it("resuming a session that never established replace mode still confirms a fresh replace-mode switch", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      writePersonaDefinition(globalDir, "ghost", { name: "ghost", systemPromptMode: "replace" }, "Be a ghost.");
      const fake = setup({ globalDir });

      await sessionStart(fake, [stateEntry("mentor")]).promise;

      const fresh = switchTo(fake, "ghost");
      fresh.ui.confirm.mockResolvedValue(true);
      await fresh.promise;

      expect(fresh.ui.confirm).toHaveBeenCalledTimes(1);
      expect(beforeAgentStart(fake, replaceModeEvent()).systemPrompt).toContain("Be a ghost.");
    });

    it("re-checks idle after the confirmation resolves and rejects if a run started", async () => {
      const fake = setup({ globalDir: makeReplaceDir() });
      let idle = true;

      const { promise, ui, notify, setStatus } = switchTo(fake, "ghost", {
        isIdle: () => idle,
        waitForIdle: async () => {},
      });
      ui.confirm.mockImplementation(async () => {
        idle = false;
        return true;
      });
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("rejected"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake, replaceModeEvent())).toBeUndefined();
    });

    it("append-mode personas never trigger a confirmation", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");

      const { promise, ui } = switchTo(fake, "mentor");
      await promise;

      expect(ui.confirm).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
    });

    it("selecting a replace persona from the picker confirms before applying", async () => {
      const fake = setup({ globalDir: makeReplaceDir() });

      const { promise, ui, setStatus } = switchTo(fake, "");
      ui.select.mockResolvedValue("ghost");
      ui.confirm.mockResolvedValue(true);
      await promise;

      expect(ui.confirm).toHaveBeenCalledTimes(1);
      expect(setStatus).toHaveBeenCalledWith("persona", "persona:ghost");
      expect(beforeAgentStart(fake, replaceModeEvent()).systemPrompt).toContain("Be a ghost.");
    });
  });

  describe("invalid persona definitions surfaced, never thrown", () => {
    it("unknown frontmatter field, missing name, and broken YAML each yield a distinct, file-attributed parse error", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "unknown-field", { name: "ghost", colour: "blue" });
      writeFileSync(join(globalDir, "missing-name.md"), "---\ndescription: nothing\n---\nBody.", "utf8");
      writeFileSync(join(globalDir, "broken-yaml.md"), "---\nname: [unclosed\n---\nBody.", "utf8");
      const fake = setup({ globalDir });

      const expectedReasons: Record<string, string> = {
        "unknown-field": "colour",
        "missing-name": "'name'",
        "broken-yaml": "Failed to parse YAML frontmatter",
      };
      const errors: string[] = [];
      for (const stem of ["unknown-field", "missing-name", "broken-yaml"]) {
        const { promise, notify } = switchTo(fake, stem);
        await promise;
        const [message, type] = notify.mock.calls.at(-1)!;
        expect(type).toBe("warning");
        expect(message).toContain(`${stem}.md`);
        expect(message).toContain(expectedReasons[stem]);
        errors.push(message as string);
      }
      expect(new Set(errors).size).toBe(3);
    });

    it("a direct switch to an invalid persona notifies the parse error instead of switching", async () => {
      const fake = setupGlobalPersona("broken", { name: "broken", colour: "blue" });

      const { promise, notify, setStatus } = switchTo(fake, "broken");
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken.md"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("an invalid systemPromptMode value yields a file-attributed parse error", async () => {
      const fake = setupGlobalPersona("sideways", { name: "sideways", systemPromptMode: "sideways" });

      const { promise, notify } = switchTo(fake, "sideways");
      await promise;

      const [message] = notify.mock.calls[0];
      expect(message).toContain("sideways.md");
      expect(message).toContain("systemPromptMode");
    });

    it("broken files do not prevent valid personas from switching", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "broken", { name: "broken", colour: "blue" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = setup({ globalDir });

      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });

    it("the picker renders invalid definitions as disabled entries carrying their parse error", async () => {
      const projectDir = makeGlobalDir();
      writeFileSync(join(projectDir, "broken.md"), "---\nname: [unclosed\n---\nBody.", "utf8");
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", description: "Guides learning" });
      const fake = setup({ projectDir, globalDir, bundledDir: missingDir() });

      const { promise, ui, notify } = switchTo(fake, "");
      await promise;

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toHaveLength(3);
      expect(options[0]).toBe("mentor — Guides learning");
      expect(options[1]).toMatch(/^broken\.md — Failed to parse YAML frontmatter:/);
      expect(options[1]).toContain("[unclosed");
      expect(options[2]).toBe("Default — pi's built-in prompt");
      expect(notify).not.toHaveBeenCalled();

      const selection = switchTo(fake, "");
      selection.ui.select.mockResolvedValue("mentor — Guides learning");
      await selection.promise;

      expect(selection.setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
    });

    it("selecting a disabled picker entry notifies the parse error and switches nothing", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "broken", { name: "broken", colour: "blue" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = setup({ globalDir, bundledDir: missingDir() });
      await switchTo(fake, "mentor").promise;

      const { promise, ui, notify, setStatus } = switchTo(fake, "");
      ui.select.mockImplementation(async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("broken.md")),
      );
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken.md"), "warning");
      expect(setStatus).not.toHaveBeenCalled();
      expect(beforeAgentStart(fake).systemPrompt).toContain("Mentor the user.");
    });

    it("the non-UI listing includes broken definitions with their errors", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "broken", { name: "broken", colour: "blue" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = setup({ globalDir, bundledDir: missingDir() });

      const { promise, notify } = switchTo(fake, "", { hasUI: false });
      await promise;

      const [message, type] = notify.mock.calls[0];
      expect(type).toBe("info");
      expect(message).toContain("mentor");
      expect(message).toContain("broken.md");
      expect(message).toContain("colour");
    });

    it("session startup succeeds with broken definition files present", async () => {
      const globalDir = makeGlobalDir();
      writeFileSync(join(globalDir, "broken.md"), "---\nname: [unclosed\n---\nBody.", "utf8");
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = setup({ globalDir });

      const { promise, notify, setStatus } = sessionStart(fake, [stateEntry("mentor")]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("session settings in persona definitions", () => {
    it("a persona carrying every Session setting still switches only the system prompt", async () => {
      const globalDir = makeGlobalDir();
      const fullyConfigured = [
        "model: claude-sonnet-4",
        "thinking: high",
        "tools: [read, bash]",
        "inheritProjectContext: false",
        "inheritSkills: false",
        "inheritExtensions: false",
        "extraArgs: ['--verbose', './extra.md']",
      ].join("\n");
      writeFileSync(
        join(globalDir, "mentor.md"),
        `---\nname: mentor\n${fullyConfigured}\n---\nMentor the user.`,
        "utf8",
      );
      const fake = setup({ globalDir });

      const { promise, notify, setStatus } = switchTo(fake, "mentor");
      await promise;

      const applied = beforeAgentStart(fake) as Record<string, unknown>;
      expect(applied).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
      expect(Object.keys(applied)).toEqual(["systemPrompt"]);
      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(notify.mock.calls.some(([, type]) => type === "warning")).toBe(false);
      expect(fake.entries).toEqual([{ customType: "personas-state", data: { persona: "mentor" } }]);
    });

    it("a wrongly typed Session setting is a parse error the picker shows as a disabled entry", async () => {
      const projectDir = makeGlobalDir();
      const wrongFields: Record<string, { field: string; line: string }> = {
        "bad-model": { field: "model", line: "model: 3" },
        "bad-thinking": { field: "thinking", line: "thinking: [high]" },
        "bad-tools": { field: "tools", line: "tools: 5" },
        "bad-project-context": {
          field: "inheritProjectContext",
          line: "inheritProjectContext: 'no'",
        },
        "bad-skills": { field: "inheritSkills", line: "inheritSkills: yes" },
        "bad-inherit-extensions": {
          field: "inheritExtensions",
          line: "inheritExtensions: 'false'",
        },
        "bad-extensions": { field: "extensions", line: "extensions: 1" },
        "bad-extra-args": { field: "extraArgs", line: "extraArgs: { verbose: true }" },
      };
      for (const [stem, { line }] of Object.entries(wrongFields)) {
        writeFileSync(
          join(projectDir, `${stem}.md`),
          `---\nname: ${stem}\n${line}\n---\nBody.`,
          "utf8",
        );
      }
      const fake = setup({ projectDir, globalDir: missingDir(), bundledDir: missingDir() });

      for (const [stem, { field }] of Object.entries(wrongFields)) {
        const { promise, notify, setStatus } = switchTo(fake, stem);
        await promise;
        const [message, type] = notify.mock.calls.at(-1)!;
        expect(type).toBe("warning");
        expect(message).toContain(`${stem}.md`);
        expect(message).toContain(`'${field}'`);
        expect(setStatus).not.toHaveBeenCalled();
      }

      const { promise, ui, notify } = switchTo(fake, "");
      await promise;
      const options = ui.select.mock.calls[0][1] as string[];
      for (const [stem, { field }] of Object.entries(wrongFields)) {
        const entry = options.find((option) => option.startsWith(`${stem}.md — `));
        expect(entry, `no disabled picker entry for ${stem}`).toBeDefined();
        expect(entry).toContain(`'${field}'`);
      }
      expect(notify).not.toHaveBeenCalled();
    });

    it("timeout and enabled stay unknown fields", async () => {
      const projectDir = makeGlobalDir();
      writeFileSync(
        join(projectDir, "timed.md"),
        "---\nname: timed\ntimeout: 60\n---\nBody.",
        "utf8",
      );
      writeFileSync(
        join(projectDir, "disabled.md"),
        "---\nname: disabled\nenabled: false\n---\nBody.",
        "utf8",
      );
      const fake = setup({ projectDir, globalDir: missingDir(), bundledDir: missingDir() });

      for (const [stem, key] of [
        ["timed", "timeout"],
        ["disabled", "enabled"],
      ]) {
        const { promise, notify } = switchTo(fake, stem);
        await promise;
        const [message] = notify.mock.calls.at(-1)!;
        expect(message).toContain(`${stem}.md`);
        expect(message).toContain(`Unknown persona definition frontmatter key: ${key}`);
      }
    });

    describe("argv mapping as in herdr agent definitions", () => {
      const DEFINITION_DIR = "/definitions/personas";

      function definition(frontmatter: string, directory = DEFINITION_DIR): PersonaDefinition {
        return parsePersonaDefinition(`---\nname: mentor\n${frontmatter}\n---\nBody.`, directory);
      }

      it("maps every field to its pi flag", () => {
        const persona = definition(
          [
            "model: claude-sonnet-4",
            "thinking: high",
            "tools: [read, bash]",
            "inheritProjectContext: false",
            "inheritSkills: false",
            "inheritExtensions: false",
            'extraArgs: ["--verbose", "./extra.md"]',
          ].join("\n"),
        );

        expect(sessionSettingsArgs(persona)).toEqual([
          "--model",
          "claude-sonnet-4",
          "--thinking",
          "high",
          "--tools",
          "read,bash",
          "-nc",
          "-ns",
          "-ne",
          "--verbose",
          "/definitions/personas/extra.md",
        ]);
      });

      it("accepts tools as one whitespace-padded string", () => {
        expect(sessionSettingsArgs(definition('tools: "read, bash"'))).toEqual([
          "--tools",
          "read,bash",
        ]);
      });

      it("adds no flag for a truthy inheritance setting and none when settings are absent", () => {
        expect(
          sessionSettingsArgs(
            definition(
              "inheritProjectContext: true\ninheritSkills: true\ninheritExtensions: true",
            ),
          ),
        ).toEqual([]);
        expect(sessionSettingsArgs(definition("description: plain"))).toEqual([]);
      });

      it("takes extensions: false as the -ne shorthand", () => {
        expect(sessionSettingsArgs(definition("extensions: false"))).toEqual(["-ne"]);
      });

      it("splits extraArgs and resolves ~/ against HOME and ./ ../ against the definition directory", () => {
        const home = process.env.HOME ?? "";
        expect(home).toBeTruthy();

        expect(
          sessionSettingsArgs(
            definition('extraArgs: "--flag ~/notes.md ../shared.md plain.md"', DEFINITION_DIR),
          ),
        ).toEqual(["--flag", `${home}/notes.md`, "/definitions/shared.md", "plain.md"]);
      });
    });
  });

  describe("unknown persona names", () => {
    it("notifies with available personas and keeps no persona active", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");

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
      const fake = setup({ globalDir, bundledDir: missingDir() });

      const { promise, ui } = switchTo(fake, "");
      await promise;

      expect(ui.select).toHaveBeenCalledWith("Switch persona", [
        "mentor — Guides learning",
        "reviewer",
        "Default — pi's built-in prompt",
      ]);
    });

    it("switches to the persona chosen in the selector", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");

      const { promise, ui, setStatus } = switchTo(fake, "");
      ui.select.mockResolvedValue("mentor");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });

    it("selecting Default clears the active persona and the status line", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");
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
      const fake = setup({ globalDir, bundledDir: missingDir() });

      const { promise, ui, setStatus } = switchTo(fake, "");
      ui.select.mockResolvedValue("Default — pi's built-in prompt");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:Default");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nActual persona.` });
    });

    it("re-checks idle after the picker resolves and rejects if a run started", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" });
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
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");
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
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");
      await switchTo(fake, "mentor").promise;

      const { promise, setStatus } = switchTo(fake, alias);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });
  });

  describe("session persistence and switch notices", () => {
    function recordedEntries(fake: FakePi): unknown[] {
      return fake.entries.map((entry, index) => ({ type: "custom", id: `e${index}`, ...entry }));
    }

    it("switching to a persona appends a persona-state entry that is not a context message", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" });

      await switchTo(fake, "mentor").promise;

      expect(fake.entries).toEqual([{ customType: "personas-state", data: { persona: "mentor" } }]);
      expect(fake.sendUserMessage).not.toHaveBeenCalled();
    });

    it("entering a persona injects a context-visible switch notice with name and description", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor", description: "Guides learning" });

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
      const fake = setup({ globalDir });

      await switchTo(fake, "mentor").promise;
      await switchTo(fake, "reviewer").promise;

      expect(fake.messages.map((message) => message.content)).toEqual([
        "Persona switched: mentor — Mentors.",
        "Persona switched: reviewer — Reviews.",
      ]);
    });

    it("a persona without a description gets a notice naming just the persona", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" });

      await switchTo(fake, "mentor").promise;

      expect(fake.messages[0]?.content).toBe("Persona switched: mentor");
    });

    it("returning to default injects the default-shaped notice and records the cleared state", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" });
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
      const fake = setupGlobalPersona("mentor", { name: "mentor" });
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
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");

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
      const fake = setup({ globalDir });

      const { promise, setStatus } = sessionStart(fake, [stateEntry("mentor"), stateEntry("reviewer")]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:reviewer");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nReview skeptically.` });
    });

    it("a cleared-state entry resumes with no persona", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" });

      const { promise, setStatus } = sessionStart(fake, [stateEntry("mentor"), stateEntry(undefined)]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("sessions recorded before this extension have no persona entry and start with none", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" });

      const { promise, setStatus } = sessionStart(fake, [{ type: "message", role: "user", content: "hi" }]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("a persona-state entry with malformed data starts with none", async () => {
      const fake = setup({ globalDir: makeGlobalDir() });

      const { promise, setStatus } = sessionStart(fake, [
        { type: "custom", customType: "personas-state", data: { persona: 42 } },
      ]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("a saved persona whose definition no longer exists resumes with none and a warning", async () => {
      const fake = setup({ globalDir: makeGlobalDir() });

      const { promise, notify, setStatus } = sessionStart(fake, [stateEntry("ghost")]);
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("ghost"), "warning");
      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("a forked child session (BTW) honors the parent's active persona", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");

      const { promise, setStatus } = sessionStart(fake, [stateEntry("mentor")], "fork");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
    });

    it("the persona survives compaction: the override still applies and the entry stays restorable", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");
      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });

      const { promise, setStatus } = sessionStart(fake, [...recordedEntries(fake), { type: "compaction", id: "c1" }], "reload");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:mentor");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.` });
    });

  });

  describe("persona session child mode", () => {
    // Child mode is triggered by the PI_PERSONA_SESSION marker, injected here
    // through the factory options instead of process.env.
    it("activates the marker persona and ignores a restored persona-state entry", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      writePersonaDefinition(globalDir, "reviewer", { name: "reviewer" }, "Review skeptically.");
      const fake = setup({ globalDir, personaSession: "reviewer" });

      const { promise, notify, setStatus } = sessionStart(fake, [stateEntry("mentor")]);
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:reviewer");
      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nReview skeptically.`,
      });
      expect(fake.messages).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
    });

    it("applies replace mode without a confirmation dialog or switch notice", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(
        globalDir,
        "ghost",
        { name: "ghost", systemPromptMode: "replace" },
        "Be a ghost.",
      );
      const fake = setup({ globalDir, personaSession: "ghost" });

      const { promise, ui } = sessionStart(fake, [stateEntry("mentor")]);
      await promise;

      expect(ui.confirm).not.toHaveBeenCalled();
      expect(fake.messages).toHaveLength(0);
      const [handler] = getHandlers(fake, "before_agent_start");
      const result = handler(
        {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: BUILT_IN_PROMPT,
          systemPromptOptions: { cwd: "/tmp/test-project", selectedTools: [] },
        },
        createContext().ctx,
      ) as { systemPrompt: string };
      expect(result.systemPrompt).toBe(
        "Be a ghost.\nCurrent working directory: /tmp/test-project",
      );
      expect(result.systemPrompt).not.toContain(BUILT_IN_PROMPT);
    });

    it.each(["", "mentor", "off", "spawn", "send-to mentor hi", "kill mentor"])(
      "refuses /persona %j with a notice and keeps the marker persona active",
      async (args) => {
        const globalDir = makeGlobalDir();
        writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
        const fake = setup({ globalDir, personaSession: "mentor" });
        await sessionStart(fake, []).promise;

        const { promise, ui, notify } = switchTo(fake, args);
        await promise;

        expect(notify).toHaveBeenCalledWith(expect.stringContaining("Persona session"), "warning");
        expect(ui.confirm).not.toHaveBeenCalled();
        expect(ui.select).not.toHaveBeenCalled();
        expect(beforeAgentStart(fake)).toEqual({
          systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
        });
        expect(fake.entries).toHaveLength(0);
      },
    );

    it("warns and leaves no persona active when the marker persona cannot be resolved", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Mentor the user.");
      const fake = setup({ globalDir, personaSession: "ghost" });

      const { promise, notify, setStatus } = sessionStart(fake, [stateEntry("mentor")]);
      await promise;

      expect(notify).toHaveBeenCalledWith(expect.stringContaining("ghost"), "warning");
      expect(setStatus).toHaveBeenCalledWith("persona", undefined);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });
  });

  describe("idle guard", () => {
    it("waits for idle before applying the switch", async () => {
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");
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
      const fake = setupGlobalPersona("mentor", { name: "mentor" }, "Mentor the user.");

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
      const fake = setupGlobalPersona("mentor", { name: "mentor" });

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
      const fake = setup({
        projectDir: makeGlobalDir(),
        globalDir,
        bundledDir: makeGlobalDir(),
      });

      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({
        systemPrompt: `${BUILT_IN_PROMPT}\n\nMentor the user.`,
      });
    });

  });

  describe("three-directory resolution, precedence, and hot reload", () => {
    it("resolves the project persona directory relative to the session working directory", async () => {
      const projectRoot = makeTempDir("personas-project-");
      const projectPersonas = join(projectRoot, ".pi", "personas");
      mkdirSync(projectPersonas, { recursive: true });
      writePersonaDefinition(projectPersonas, "local", { name: "local" }, "Local flavor.");
      const fake = setup({ globalDir: missingDir() });

      const { promise, setStatus } = switchTo(fake, "local", { cwd: projectRoot });
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:local");
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nLocal flavor.` });
    });

    it("a project persona shadows the same-named global persona", async () => {
      const projectDir = makeGlobalDir();
      const globalDir = makeGlobalDir();
      writePersonaDefinition(projectDir, "mentor", { name: "mentor" }, "Project mentor.");
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" }, "Global mentor.");
      const fake = setup({ projectDir, globalDir });

      await switchTo(fake, "mentor").promise;

      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nProject mentor.` });
    });

    it("a global persona shadows the same-named bundled persona", async () => {
      const globalDir = makeGlobalDir();
      const bundledDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "contrarian", { name: "contrarian" }, "Global contrarian.");
      writePersonaDefinition(bundledDir, "contrarian", { name: "contrarian" }, "Bundled contrarian.");
      const fake = setup({ globalDir, bundledDir });

      await switchTo(fake, "contrarian").promise;

      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nGlobal contrarian.` });
    });

    it("a bundled persona switches like any other", async () => {
      const bundledDir = makeGlobalDir();
      writePersonaDefinition(bundledDir, "contrarian", { name: "contrarian" }, "Challenge everything.");
      const fake = setup({ globalDir: missingDir(), bundledDir });

      await switchTo(fake, "contrarian").promise;

      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nChallenge everything.` });
    });

    it("lists personas from all three directories in the picker", async () => {
      const projectDir = makeGlobalDir();
      const globalDir = makeGlobalDir();
      const bundledDir = makeGlobalDir();
      writePersonaDefinition(projectDir, "local", { name: "local" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      writePersonaDefinition(bundledDir, "contrarian", { name: "contrarian" });
      const fake = setup({ projectDir, globalDir, bundledDir });

      const { promise, ui } = switchTo(fake, "");
      await promise;

      expect(ui.select).toHaveBeenCalledWith("Switch persona", [
        "local",
        "mentor",
        "contrarian",
        "Default — pi's built-in prompt",
      ]);
    });

    it("tolerates all three directories missing", async () => {
      const fake = setup({
        projectDir: missingDir(),
        globalDir: missingDir(),
        bundledDir: missingDir(),
      });

      const { promise, ui } = switchTo(fake, "");
      await promise;

      expect(ui.select).toHaveBeenCalledWith("Switch persona", ["Default — pi's built-in prompt"]);
      expect(beforeAgentStart(fake)).toBeUndefined();
    });

    it("a persona definition added mid-session appears in the next picker listing", async () => {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "mentor", { name: "mentor" });
      const fake = setup({ globalDir, bundledDir: missingDir() });

      await switchTo(fake, "").promise;
      writePersonaDefinition(globalDir, "reviewer", { name: "reviewer" });

      const { promise, ui } = switchTo(fake, "");
      await promise;

      expect(ui.select).toHaveBeenLastCalledWith("Switch persona", [
        "mentor",
        "reviewer",
        "Default — pi's built-in prompt",
      ]);
    });
  });

  describe("bundled persona", () => {
    // Only the machine-visible directories are overridden: the bundled directory
    // resolves to the shipped extensions/personas/bundled, so these tests exercise the real shipped file.
    function extensionWithShippedBundled(): FakePi {
      return setup({ projectDir: missingDir(), globalDir: missingDir() });
    }

    it("ships contrarian, switchable out of the box and composed in append mode", async () => {
      const fake = extensionWithShippedBundled();

      const { promise, ui, setStatus } = switchTo(fake, "contrarian");
      await promise;

      expect(setStatus).toHaveBeenCalledWith("persona", "persona:contrarian");
      expect(ui.confirm).not.toHaveBeenCalled();
      expect(fake.messages[0]?.content).toMatch(/^Persona switched: contrarian — \S/);
      const prompt = beforeAgentStart(fake) as { systemPrompt: string };
      expect(prompt.systemPrompt.startsWith(BUILT_IN_PROMPT)).toBe(true);
      expect(prompt.systemPrompt).not.toBe(BUILT_IN_PROMPT);
    });

    it("lists the bundled persona in the picker with its description", async () => {
      const fake = extensionWithShippedBundled();

      const { promise, ui } = switchTo(fake, "");
      await promise;

      expect(ui.select).toHaveBeenCalledWith("Switch persona", [
        expect.stringMatching(/^contrarian — \S/),
        "Default — pi's built-in prompt",
      ]);
    });

    it("a project persona definition shadows the bundled one without touching the package", async () => {
      const projectDir = makeGlobalDir();
      writePersonaDefinition(projectDir, "contrarian", { name: "contrarian" }, "Project contrarian.");
      const fake = setup({ projectDir, globalDir: missingDir() });

      const { promise } = switchTo(fake, "contrarian");
      await promise;

      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nProject contrarian.` });
    });
  });

  describe("persona sessions: spawn, send-to and reply delivery", () => {
    // A fake hc: terminals are plain records the test advances by hand.
    interface FakeTerminal { state: "live" | "finished"; turn: number; status: string; screen: string }
    function installFakeHc(fake: FakePi) {
      const terminals = new Map<string, FakeTerminal>();
      const calls: string[][] = [];
      let next = 1;
      let unavailable = 0;
      let failGets = 0;
      fake.pi.exec.mockImplementation(async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        const ok = (out: unknown = {}) => ({ code: 0, stdout: JSON.stringify(out), stderr: "", killed: false });
        if (cmd !== "hc") return ok();
        const [sub, ...rest] = args;
        const target = rest[rest.length - 1];
        if (sub === "run") {
          const address = `t${next++}`;
          terminals.set(address, { state: "live", turn: 0, status: "idle", screen: "" });
          return ok({ address });
        }
        if (sub === "get") {
          if (failGets > 0) {
            failGets--;
            return { code: 1, stdout: "", stderr: "socket hiccup", killed: false };
          }
          const t = terminals.get(target);
          return t ? ok({ state: t.state, turn: t.turn, status: { state: t.status } }) : { code: 1, stdout: "", stderr: "no terminal", killed: false };
        }
        if (sub === "send") {
          if (unavailable > 0) {
            unavailable--;
            return { code: 1, stdout: "", stderr: 'error: "unavailable"', killed: false };
          }
          const t = terminals.get(rest[rest.length - 2])!;
          t.status = "working";
          return ok({ started: true });
        }
        if (sub === "read") return { code: 0, stdout: terminals.get(target)?.screen ?? "", stderr: "", killed: false };
        return ok();
      });
      return { terminals, calls, failSendsWhileBooting: (n: number) => { unavailable = n; }, failNextGets: (n: number) => { failGets = n; } };
    }

    function spawnArgv(calls: string[][]) {
      return calls.filter((c) => c[0] === "hc" && c[1] === "run");
    }

    // Writes the persona's reply into the session file the spawned pi would write.
    function writeReply(runCall: string[], text: string) {
      const dir = runCall[runCall.indexOf("--session-dir") + 1];
      const line = { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
      writeFileSync(join(dir, "2026-01-01_x.jsonl"), `${JSON.stringify({ type: "session" })}\n${JSON.stringify(line)}\n`);
    }

    function sessionSetup(extra: Record<string, unknown> = {}) {
      const globalDir = makeGlobalDir();
      writePersonaDefinition(globalDir, "contrarian", { name: "contrarian", description: "Skeptic" });
      writePersonaDefinition(globalDir, "mentor", { name: "mentor", model: "anthropic/claude-x", tools: "read,bash" });
      const cwd = makeTempDir("personas-cwd-");
      const fake = setup({ globalDir, projectDir: missingDir(), terminalId: "t59", pollMs: 0, ...extra });
      const hc = installFakeHc(fake);
      return { fake, hc, cwd, globalDir };
    }

    async function run(fake: FakePi, args: string, cwd: string, overrides: Record<string, unknown> = {}) {
      const { ctx, ui, notify } = createContext({ cwd, ...overrides });
      await commandHandler(fake)(args, ctx);
      return { ui, notify };
    }

    // The toggle list: each pick toggles a check mark, "Spawn selected" spawns.
    function pickInOrder(ui: { select: any }, ...picks: string[]) {
      for (const pick of picks) {
        ui.select.mockImplementationOnce(async (_title: string, opts: string[]) => opts.find((o) => o.includes(pick)));
      }
    }

    async function spawn(fake: FakePi, cwd: string, picks: string[], overrides: Record<string, unknown> = {}) {
      const { ctx, ui, notify } = createContext({ cwd, ...overrides });
      pickInOrder(ui, ...picks, "Spawn selected");
      await commandHandler(fake)("spawn", ctx);
      return { ui, notify };
    }

    it("spawns each selected persona as a forked pi in a paneless hc terminal", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["mentor"], { sessionManager: { getEntries: () => [], getSessionFile: () => "/tmp/main.jsonl" } });

      const [call] = spawnArgv(hc.calls);
      const sep = call.indexOf("--");
      const id = call[call.indexOf("--name") + 1];
      expect(id).toMatch(/^mentor-[0-9a-f]{4}$/);
      expect(call.slice(0, sep)).toEqual(["hc", "run", "--bg", "--json", "--no-notify", "--name", id, "--cwd", cwd, "--parent", "t59"]);
      expect(call.slice(sep + 1)).toEqual([
        "env", "PI_PERMISSION_PROFILE=yolo", "PI_PERSONA_SESSION=mentor",
        "pi", "--fork", "/tmp/main.jsonl", "--session-dir", join(cwd, ".pi", "persona-sessions", id), "-a",
        "--model", "anthropic/claude-x", "--tools", "read,bash",
      ]);
      expect(readFileSync(join(cwd, ".pi", "persona-sessions", ".gitignore"), "utf8")).toBe("*\n");
    });

    it("toggles picks: several personas spawn, a pick made twice is unselected", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian", "mentor", "mentor"]);
      const names = spawnArgv(hc.calls).map((c) => c[c.indexOf("--name") + 1]);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^contrarian-/);
    });

    it("shows a check mark on toggled personas", async () => {
      const { fake, cwd } = sessionSetup();
      const { ui } = await spawn(fake, cwd, ["contrarian"]);
      const secondList: string[] = ui.select.mock.calls[1][1];
      expect(secondList.find((o) => o.includes("contrarian"))).toMatch(/^✓/);
      expect(secondList.find((o) => o.includes("mentor"))).not.toMatch(/^✓/);
      expect(secondList[secondList.length - 1]).toBe("Spawn selected");
    });

    it("spawns nothing when the toggle list is cancelled", async () => {
      const { fake, hc, cwd } = sessionSetup();
      const { ctx, ui } = createContext({ cwd });
      pickInOrder(ui, "contrarian");
      ui.select.mockResolvedValueOnce(undefined);
      await commandHandler(fake)("spawn", ctx);
      expect(spawnArgv(hc.calls)).toHaveLength(0);
    });

    it("leaves project-directory personas out of the spawn list in an untrusted project", async () => {
      const projectDir = makeTempDir("personas-project-");
      writePersonaDefinition(projectDir, "local", { name: "local", extraArgs: "-e ./evil.ts" });
      const { fake, cwd } = sessionSetup({ projectDir });
      const { ctx, ui } = createContext({ cwd, isProjectTrusted: () => false });
      ui.select.mockResolvedValueOnce(undefined);
      await commandHandler(fake)("spawn", ctx);
      const list: string[] = ui.select.mock.calls[0][1];
      expect(list.some((o) => o.includes("local"))).toBe(false);
      expect(list.some((o) => o.includes("contrarian"))).toBe(true);
    });

    it("passes -na to the child in an untrusted project", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"], { isProjectTrusted: () => false });
      expect(spawnArgv(hc.calls)[0]).toContain("-na");
    });

    it("skips a persona that is already live, with a notice", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      const { notify } = await spawn(fake, cwd, ["contrarian"]);
      expect(spawnArgv(hc.calls)).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("contrarian is already live"), "info");
    });

    it("send-to types the message into the persona's terminal without an --if guard and returns at once", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      await run(fake, "send-to contrarian is   this plan sound?", cwd);
      const send = hc.calls.find((c) => c[1] === "send")!;
      expect(send).toEqual(["hc", "send", "--", "t1", "is   this plan sound?"]);
      expect(fake.messages.filter((m) => m.customType === "persona-reply")).toHaveLength(0);
    });

    it("send-to asks for the message when it is missing", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      const { ctx, ui } = createContext({ cwd });
      ui.input.mockResolvedValueOnce("why?");
      await commandHandler(fake)("send-to contrarian", ctx);
      expect(ui.input).toHaveBeenCalled();
      expect(hc.calls.find((c) => c[1] === "send")).toEqual(["hc", "send", "--", "t1", "why?"]);
    });

    it("send-to retries while the child is still booting", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      hc.failSendsWhileBooting(2);
      await run(fake, "send-to contrarian hi", cwd);
      expect(hc.calls.filter((c) => c[1] === "send")).toHaveLength(3);
    });

    it("send-to a persona that is not live is refused", async () => {
      const { fake, hc, cwd } = sessionSetup();
      const { notify } = await run(fake, "send-to contrarian hi", cwd);
      expect(hc.calls.some((c) => c[1] === "send")).toBe(false);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("No live Persona session"), "warning");
    });

    it("delivers the reply as a persona-reply that does not trigger a turn, leaving the terminal alive", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      await run(fake, "send-to contrarian thoughts?", cwd);
      writeReply(spawnArgv(hc.calls)[0], "It will not scale.");
      Object.assign(hc.terminals.get("t1")!, { turn: 1, status: "done" });

      await vi.waitFor(() => expect(fake.messages.some((m) => m.customType === "persona-reply")).toBe(true));
      const i = fake.messages.findIndex((m) => m.customType === "persona-reply");
      expect(fake.messages[i]).toMatchObject({ content: "contrarian: It will not scale.", display: true });
      expect(fake.messageOptions[i]).toEqual({ triggerTurn: false });
      expect(hc.calls.some((c) => c[1] === "kill" || c[1] === "rm")).toBe(false);
    });

    it("surfaces the terminal when the persona is blocked on a dialog", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      await run(fake, "send-to contrarian go", cwd);
      hc.terminals.get("t1")!.status = "blocked";
      await vi.waitFor(() =>
        expect(hc.calls).toContainEqual(["herdr-app", "do", "terminal.peek", "--terminal", "t1"]),
      );
      Object.assign(hc.terminals.get("t1")!, { turn: 1, status: "done" });
      await vi.waitFor(() => expect(fake.messages.some((m) => m.customType === "persona-reply")).toBe(true));
    });

    it("reports a persona that exited with its screen tail and lets it be spawned again", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      await run(fake, "send-to contrarian go", cwd);
      Object.assign(hc.terminals.get("t1")!, { state: "finished", screen: "boot\nError: unknown model" });

      await vi.waitFor(() => expect(fake.messages.some((m) => m.customType === "persona-reply")).toBe(true));
      const reply = fake.messages.find((m) => m.customType === "persona-reply")!;
      expect(reply.content).toContain("contrarian exited");
      expect(reply.content).toContain("Error: unknown model");

      await spawn(fake, cwd, ["contrarian"]);
      expect(spawnArgv(hc.calls)).toHaveLength(2);
    });

    it("reports a persona that dies before anything was sent to it", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      Object.assign(hc.terminals.get("t1")!, { state: "finished", screen: "Error: unknown model" });
      await vi.waitFor(() =>
        expect(fake.messages.find((m) => m.customType === "persona-reply")?.content).toContain("contrarian exited"),
      );
    });

    it("keeps a session alive through a transient hc get failure", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      const t = hc.terminals.get("t1")!;
      hc.failNextGets(2);
      await run(fake, "send-to contrarian still there?", cwd);
      writeReply(spawnArgv(hc.calls)[0], "Yes.");
      Object.assign(t, { turn: 1, status: "done" });
      await vi.waitFor(() =>
        expect(fake.messages.find((m) => m.customType === "persona-reply")?.content).toBe("contrarian: Yes."),
      );
    });

    it("delivers one reply per finished turn, including a turn that ends while the next is running", async () => {
      const { fake, hc, cwd } = sessionSetup();
      await spawn(fake, cwd, ["contrarian"]);
      await run(fake, "send-to contrarian first", cwd);
      writeReply(spawnArgv(hc.calls)[0], "One.");
      Object.assign(hc.terminals.get("t1")!, { turn: 1, status: "working" });
      await vi.waitFor(() => expect(fake.messages.filter((m) => m.customType === "persona-reply")).toHaveLength(1));
      writeReply(spawnArgv(hc.calls)[0], "Two.");
      Object.assign(hc.terminals.get("t1")!, { turn: 2, status: "done" });
      await vi.waitFor(() =>
        expect(fake.messages.filter((m) => m.customType === "persona-reply").map((m) => m.content)).toEqual([
          "contrarian: One.",
          "contrarian: Two.",
        ]),
      );
    });

    it("matches send-to only as a whole word, so a persona named send-tox still switches", async () => {
      const { fake, cwd, globalDir } = sessionSetup();
      writePersonaDefinition(globalDir, "send-tox", { name: "send-tox" }, "Tox.");
      await run(fake, "send-tox", cwd);
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nTox.` });
    });

    it("refuses spawn and send-to outside herdr, while live switching still works", async () => {
      const { fake, hc, cwd } = sessionSetup({ terminalId: "" });
      const a = await run(fake, "spawn", cwd);
      const b = await run(fake, "send-to contrarian hi", cwd);
      expect(a.notify).toHaveBeenCalledWith(expect.stringContaining("need herdr"), "warning");
      expect(b.notify).toHaveBeenCalledWith(expect.stringContaining("need herdr"), "warning");
      expect(hc.calls).toHaveLength(0);
      await run(fake, "contrarian", cwd);
      expect(beforeAgentStart(fake)).toEqual({ systemPrompt: `${BUILT_IN_PROMPT}\n\nYou are the contrarian persona.` });
    });
  });
});
