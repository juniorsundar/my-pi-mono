# Ship the contrarian bundled persona and authoring docs

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

Ship the one approved **Bundled persona** — `contrarian`, append mode, senior-engineer skeptic — inside the extension package, available out of the box and replaceable by a same-named project or global persona. Its body locks the calibration decided in the design session: default posture of skepticism, strongest objection first, concrete failure scenarios over vague doubt, explicit concession when proven wrong, no fabricated objections, no invented politeness. Alongside it, the package README documents the persona definition format: the frontmatter fields, both prompt modes and their defaults (append here, unlike agent definitions), the three directories and precedence, hot reload, and how a bundled persona is overridden.

### Acceptance criteria

- [ ] `contrarian` is available out of the box (append mode) and listed in the picker with its description
- [ ] Its body encodes the locked calibration: skepticism as default posture, strongest objection first, concrete failure scenarios, explicit concession when proven wrong, no fabricated objections, no softening politeness
- [ ] A same-named project or global `contrarian` shadows the bundled one
- [ ] The bundled persona is overridable without touching the package
- [ ] README documents: definition format, frontmatter fields, both prompt modes with defaults, directory precedence, hot reload, bundled-persona overriding
- [ ] README uses the root context document's Personas vocabulary (Persona, Persona definition, directories, Prompt mode, Bundled persona) and avoids "mode"/"profile"/"agent" drift
- [ ] Verified through the extension entry point seam that the bundled persona composes and switches like any other

### Blocked by

0062 — Personas three-directory resolution, precedence, hot reload