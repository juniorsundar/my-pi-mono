# Personas switch live via a per-turn system prompt override

The personas extension lets users switch the main agent's persona mid-session. We implement switching with the `before_agent_start` extension hook: every turn, if a persona is active, the extension returns `{ systemPrompt }` to override the base prompt for that turn (append mode: pi's built-in prompt plus the persona body; replace mode: the persona body as a custom prompt). The active persona is persisted to the session file as a non-context-visible custom entry, restored on `session_start` so `/resume` honors it, and announced to the model via a context-visible switch notice so it can account for commitments made under a previous persona.

This is per-turn rather than set-once because pi's `AgentSession` resets its system-prompt override after every agent run (`_systemPromptOverride = undefined` in the post-run `finally`), and there is no `pi.setSystemPrompt()` API — the per-turn hook is the only live-switching seam. Reapplying each turn is also what makes switching safe mid-conversation: history is untouched, and only subsequent turns obey the new persona. The cost is that the extension must reassert the persona every turn and cache the composed prompt string; the alternative — rebuilding the session or mutating the base prompt options — either loses history or depends on a rebuild trigger pi does not expose.

## Considered options

- **Per-turn `before_agent_start` override** (chosen): works today, resets cleanly, survives compaction (the prompt is rebuilt per turn from the active persona, not baked into history).
- **Mutate `BuildSystemPromptOptions` / base prompt once at switch time**: rejected — pi only rebuilds the base prompt on tool changes, so a switch would silently not take effect, and it would apply to BTW forks and future sessions with no record in the session file.
- **`--append-system-prompt` / restart the session per switch**: rejected — restarting loses the point of live switching; the flag is process-level, not session-level.

## Consequences

- Persona files are re-read from disk only on `/persona` invocations (listing or switching), not per turn: mid-session edits apply on the next switch.
- A persona controls the system prompt only — never model, thinking level, or tools. Model changes remain the user's explicit act (`/model`, `pi.setModel`), and nothing competes with the mutation extension's permission profiles.
- Because the active persona lives in the session file as a custom entry, sessions recorded before this extension existed simply have no persona active; there is no migration.
- Replace mode reassembles the prompt pi-side pieces (append prompt, project context, skills, cwd) itself, because the hook hands over a finished prompt string with no way to swap only the built-in part. If pi changes its own custom-prompt assembly, replace mode drifts until this composition is updated to match.
- Restoring the active persona reads the session's append-only entry list, which compaction never prunes, so a persona set before a compaction still restores afterwards.