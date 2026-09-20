# Personas invalid definitions surfaced, never thrown

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

Malformed **Persona definitions** must never brick a session, and must never hide authoring mistakes. Parse errors — unknown frontmatter fields, missing `name`, broken YAML — are captured per definition instead of thrown. Invalid personas appear in the picker as disabled entries showing their parse error, so the author sees exactly which file is broken and why. A session containing any number of broken definition files starts and runs normally with the valid personas available.

### Acceptance criteria

- [x] An unknown frontmatter field, a missing `name`, and invalid YAML each produce a distinct, file-attributed parse error
- [x] Invalid personas appear in the picker as disabled entries carrying the error text; they cannot be selected
- [x] A direct `/persona <name>` for an invalid persona notifies with the parse error rather than switching
- [x] Valid personas in the same directory (or other directories) remain fully selectable
- [x] Session startup, listing, and switching all succeed with broken files present
- [x] Error capture and disabled-entry rendering verified through the extension entry point seam

### Blocked by

0060 — Personas full command surface: picker, default, aliases, idle guard