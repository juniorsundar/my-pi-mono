# Persona session child mode via PI_PERSONA_SESSION

Labels: ready-for-agent

### Parent

Spec 0013 — Persona Sessions: consult personas as forked herdr sessions

### What to build

When `PI_PERSONA_SESSION=<name>` is set, the personas extension is running inside a **Persona session**. On `session_start` it makes that persona the Active persona through the existing append/replace composition. It ignores any `personas-state` entry restored from the fork, skips the Replace mode confirmation, and emits no switch notice. Every `/persona` invocation is refused with a notice, which covers switching, `spawn`, `send-to` and `kill`, so personas cannot nest. If the named persona cannot be resolved, it warns and falls back to no persona.

### Acceptance criteria

- [x] With the marker set and a different persona in restored `personas-state`, the per-turn hook returns the marker persona's composed prompt
- [x] Replace mode applies without a confirm dialog
- [x] `/persona` with any arguments is refused with a notice
- [x] An unresolvable marker name warns and leaves no persona active
- [x] Without the marker, behaviour is unchanged (existing tests stay green)

### Blocked by

None (can start immediately).
