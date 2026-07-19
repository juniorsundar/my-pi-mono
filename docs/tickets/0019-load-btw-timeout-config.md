# Ticket 0019: Load BTW timeout config

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Allow BTW to read its timeout setting from pi settings while preserving a safe default. A user who does nothing gets the default five-minute timeout, and a user who configures a BTW timeout gets that value applied consistently when a BTW Process is later spawned.

### Acceptance criteria

- [x] BTW has a default timeout of five minutes
- [x] A configured timeout value overrides the default
- [x] Missing BTW settings fall back to the default without error
- [x] Invalid timeout values fall back safely or produce a clear configuration error consistent with existing extension conventions
- [x] The parsed timeout is available to the BTW command path
- [x] Tests cover default, configured, missing, and invalid timeout settings

### Blocked by

- Ticket 0018 — needs the BTW extension skeleton and command surface
