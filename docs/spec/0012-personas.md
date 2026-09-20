# Personas — live-switchable prompt profiles for the main agent

Labels: ready-for-agent

### Problem Statement

The pi coding agent has one fixed identity per session: whatever system prompt it started with. Users with recurring working modes — "review this skeptically", "mentor me through this codebase", "act as a grumpy staff engineer" — have no way to install that posture on the main agent, let alone change it mid-conversation. The subagents extension has a `.md`-file format for defining agents, but those are disposable child roles; the agent you actually talk to cannot be re-profiled. Tools like opencode solve this with primary agents, but pi has nothing equivalent: changing the main agent's prompt means restarting with different flags, losing the session.

### Solution

A new personas extension. A **Persona** is a named, switchable prompt profile for the main agent, defined by a `.md` **Persona definition** (YAML frontmatter + prompt body, mirroring the subagents agent-definition format). Users switch the **Active persona** live via the `persona` command; the switch applies to subsequent turns only, leaving conversation history untouched, persists across resume, and is announced to the model via a context-visible **Switch notice** so it can account for commitments made under a previous persona. Personas are prompt-only: they never touch model, thinking level, or tools.

### User Stories

1. As a pi user, I want to switch the main agent's persona mid-session, so that I can change how it behaves without restarting or losing conversation history.
2. As a pi user, I want to run `/persona` with no arguments and see every available persona in a picker, so that I can discover and choose personas without memorizing names.
3. As a pi user, I want to switch directly with `/persona <name>`, so that persona switching is one command with no round-trip through a picker.
4. As a pi user, I want to return to pi's built-in prompt via `/persona off` (also `default`/`none`, or the picker's "Default" entry), so that leaving a persona is as easy as entering one.
5. As a pi user, I want the active persona shown in the status line, so that I always know which persona is governing the agent.
6. As a pi user, I want a persona switch to apply only to subsequent turns, so that prior conversation history is never rewritten.
7. As a pi user, I want the model to receive a switch notice in context when I switch personas, so that it can acknowledge the shift rather than silently contradicting commitments it made under the previous persona.
8. As a pi user, I want the same switch-notice treatment when returning to default, so that the model knows the persona era ended.
9. As a pi user, I want my active persona to persist across resume, so that a resumed session keeps behaving under the persona I chose.
10. As a pi user, I want switching to be rejected with a clear message while the agent is mid-run, so that a prompt change never races an in-flight turn.
11. As a pi user, I want an unknown persona name to produce a helpful error listing available personas, so that typos are self-correcting.
12. As a pi user, I want a `contrarian` persona available out of the box, so that I get immediate value — a senior engineer whose default posture is skepticism — without authoring anything.
13. As a pi user, I want the contrarian persona to challenge assumptions and lead with the strongest objection while conceding plainly when proven wrong, so that pushback is rigorous rather than noise.
14. As a persona author, I want to define a persona in a `.md` file with YAML frontmatter and a prompt body, so that authoring requires no code and the format matches what I already know from subagent agent definitions.
15. As a persona author, I want my project's personas in `.pi/personas/` to override same-named global personas, so that a repo can ship its own take on a persona like `contrarian`.
16. As a persona author, I want personas in `~/.pi/agent/personas/` shared across projects, so that I author a persona once and use it everywhere.
17. As a persona author, I want my same-named persona to override the bundled one, so that the shipped `contrarian` is a default I can replace, not a hard-coded behavior.
18. As a persona author, I want append mode as the default composition, so that my persona keeps the agent's built-in coding guidance instead of lobotomizing it.
19. As a persona author, I want an opt-in replace mode for personas that must fully take over the system prompt, so that total-identity personas are possible when I mean them.
20. As a pi user, I want a one-time confirmation when switching to a replace-mode persona, so that a frontmatter typo cannot silently strip the agent's core tool guidance.
21. As a persona author, I want to edit a persona definition and have the change apply the next time I switch to it, so that the authoring loop is edit → re-run `/persona <name>` with no session restart.
22. As a persona author, I want unknown frontmatter fields to be rejected with a parse error shown in the picker, so that typos surface instead of being silently ignored.
23. As a pi user, I want a malformed persona definition to appear as a disabled picker entry with its error, so that one bad file never bricks the session or hides my authoring mistakes.
24. As a pi user, I want persona descriptions shown in the picker, so that I can tell what a persona does before committing to it.
25. As a pi user, I want personas to control the system prompt only — never model, thinking level, or tools, so that model changes stay my explicit act and nothing interferes with the mutation extension's permission profiles.
26. As a pi user, I want BTW side-questions to honor the active persona, so that a forked child answers in the same persona the parent session is in.
27. As a pi user, I want the active persona to survive compaction, so that a compacted session keeps its persona.
28. As a pi user, I want switching personas repeatedly in one session to be reliable, so that trying a persona on and taking it off is a normal, reversible act.
29. As a pi maintainer, I want personas to reuse the subagents agent-definition parsing conventions (frontmatter split, strict field validation), so that the two formats feel like one family despite being distinct concepts.
30. As a pi maintainer, I want the personas extension tested entirely through the extension entry point seam, so that testing adds no new seams to the codebase.

### Implementation Decisions

- **New extension package** `extensions/personas/`, following the repo's flat one-package layout, with an internal persona-definition parser module and a store module for directory resolution — both exercised through the extension entry point, not exported as public API.
- **Persona definition format**: `.md` file, YAML frontmatter with `name` (required), `description`, and `systemPromptMode: append | replace`. The body is the persona's prompt. Strict field validation like the subagents agent-definition parser; parse errors are captured and surfaced (never thrown) so invalid definitions appear as disabled picker entries.
- **Composition (Prompt mode)**: append mode composes pi's built-in prompt plus the persona body — and is the default; replace mode uses the persona body as the custom prompt (pi still attaches project context and skills in both modes). The default is the *inverse* of subagent agent definitions (where replace is default) because the main agent losing its built-in tool guidance is the dangerous case; the shared field name is kept deliberately.
- **Discovery and precedence**: project persona directory (`.pi/personas/` under the project root) > global persona directory (`~/.pi/agent/personas/`) > bundled personas shipped inside the extension package. First name match wins per that order.
- **Switching mechanism** (recorded in ADR 0009): the extension subscribes to the per-turn agent-start hook and returns the composed system prompt while a persona is active; it returns nothing when no persona is active. The active persona's composed prompt is cached in the extension so no disk read happens per turn.
- **Command surface**: `/persona` — no arguments opens a selector (always including a "Default — pi's built-in prompt" entry); `/persona <name>` switches directly; `off`, `default`, `none` are aliases for returning to no persona. Switching waits for the agent to be idle and rejects with a notification otherwise. The first switch to a replace-mode persona per session asks for confirmation.
- **Persistence**: the active persona is recorded in the session file as a non-context-visible custom entry; the session-start handler restores it, which also makes resume and BTW forks honor it. No migration: sessions recorded before this extension have no persona entry, meaning default.
- **Switch notice**: injected as a context-visible message on every switch, shaped `Persona switched: <name> — <description>` (or `Persona switched: default — pi's built-in prompt`). This is distinct from the non-context persistence entry.
- **Hot reload**: persona definitions are re-read from disk on each `/persona` invocation (listing and switching), never per turn. Edits apply on the next switch.
- **Bundled persona**: one shipped persona, `contrarian` (append mode), whose body fixes the persona's calibration: default posture of skepticism, strongest objection first, concrete failure scenarios over vague doubt, explicit concession when proven wrong, no fabricated objections, no invented politeness.
- **Status**: a status line shows the active persona; cleared when none is active.
- **Injectable directories**: the extension factory accepts an options object with the project, global, and bundled persona directories (following the subagents `agentsDir` injection pattern), which is both the configuration seam and the test seam.
- **Scope guard**: the extension never calls model-, thinking-, or tool-mutation APIs. No CLI flag, no session-default persona.

### Testing Decisions

**What makes a good test**: only external behavior through the one seam — the extension entry point. Instantiate the factory with a fake extension API that records registered commands, event subscriptions, appended session entries, sent messages, and status updates; script the UI context (selectors return canned choices, confirms return canned answers); and inject temp directories as the project, global, and bundled persona directories. Assert on what crosses the seam: the composed system prompt returned by the per-turn hook (append composition, replace composition, `undefined` with no persona), the session entries and switch notices emitted by command invocations, the picker's entries (valid personas, the Default entry, disabled invalid definitions with their errors), the resume path (session-start restore), the idle guard, the replace-mode confirmation, precedence across directories, and hot reload across re-invocations. No test observes internal module state.

**Modules to test**: the extension as a whole — parser and store are internal and covered through the entry point.

**Prior art**: `extensions/mutation/index.test.ts`, `extensions/btw/index.test.ts`, and `extensions/subagents/test/index.test.ts` — all drive an extension-level fake-pi harness with scripted UI and temp directories. The personas tests follow that pattern exactly; no new seam is introduced.

### Out of Scope

- Model, thinking-level, or tool control in personas (explicit non-goal; competes with permission profiles and user-owned model switching).
- A `--persona` CLI flag and a default persona in settings (fast follows once the command is proven, deliberately deferred).
- Persona stacking — multiple simultaneously active personas. Zero or one, never several.
- The agent choosing or auto-switching personas itself; personas are user-driven only.
- Applying personas to subagents — agent types own their prompts; a persona must never be spawnable, an agent type never applicable as a persona (flagged ambiguity in the root context document).
- Shipping personas beyond `contrarian`.
- Importing or translating opencode's agent format.

### Further Notes

- The core mechanism is recorded in ADR 0009 (docs/adr/0009-persona-live-switching-via-per-turn-prompt-override.md): per-turn override rather than base-prompt mutation, including the rejected alternatives and the resume/compaction consequences.
- All domain terms are defined in the root context document's Personas section: Persona, Persona definition, Project/Global persona directory, Active persona, Persona switch, Switch notice, Bundled persona, Prompt mode. Use that vocabulary in tickets, tests, and code — do not drift to "mode", "profile", or "agent".
- The persona and agent-type formats deliberately share a field name (`systemPromptMode`) with different defaults; this asymmetry is intentional and documented, not an oversight to "fix".
- The bundled persona's calibration (rigorous skeptic, not unconditional attack dog) was a deliberate user decision; keep that voice when editing `contrarian`.