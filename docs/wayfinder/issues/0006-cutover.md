# Cutover: switch `settings.json` to `my-pi-mono`, remove moved extensions

`wayfinder:task` · **RESOLVED**

Child of: [Map — Merge local extensions + pi-subagents into my-pi-mono](0001-map.md)

**Claimed by:** this session (pi-agent) — resolved.

## Question

The no-breakage cutover: once `my-pi-mono` builds, typechecks, and its tests pass (parallel copy proven), flip the dotfiles to load it as the single package and remove the moved extensions from `~/.pi/agent/extensions/`.

Tasks:

1. Add `"git:github.com/juniorsundar/my-pi-mono"` to `settings.json` `packages` (alongside the existing `git:github.com/juniorsundar/pi-subagents` entry, during the parallel window).
2. Verify pi loads all extensions from the new package — confirm via a startup header / `/reload` that btw, deep-research, mutation, web-search, and the subagent tool all register.
3. Remove `"git:github.com/juniorsundar/pi-subagents"` from `packages` (now superseded by my-pi-mono).
4. Remove `btw`, `deep-research`, `mutation`, `web-search` from `~/.pi/agent/extensions/`. **Leave `omniroute-pi-provider`** (out of scope).
5. Final verification: pi starts clean, all extensions present, `subagent` tool works, web-search works, deep-research can spawn (post-0004).
6. Update `FUTURE_WORK.md` — the spawn-handshake entry is now moot (direct import); remove or mark resolved.

Blocked by: [Migrate extension sources](0005-migrate-sources.md), [Unify the spawnSubagent exporter](0004-unify-spawn-exporter.md). This is the last step of phase 1.

## Resolution

Phase 1 cutover complete. `my-pi-mono` is now the single package pi loads; the four in-scope extensions are removed from `~/.pi/agent/extensions/` (only `omniroute-pi-provider` remains); `pi-subagents` is superseded. Verified by a clean `pi --print` startup (no "conflicts with" load errors) and `pi list` showing only `my-pi-mono` under the user packages. Phase 1 destination reached.

### What was done

1. **`settings.json` packages** — added `git:github.com/juniorsundar/my-pi-mono`, removed `git:github.com/juniorsundar/pi-subagents`. The other four unrelated packages (`rpiv-mono`, two `@juicesharp` npm, `@sherif-fanous/pi-atom-one`) untouched.
2. **Extensions removed** — `btw`, `deep-research`, `mutation`, `web-search` moved out of `~/.pi/agent/extensions/` to `/tmp/cutover-backup-extensions/` (rollback backup). `omniroute-pi-provider` left in place (out of scope). `pi list` now resolves `my-pi-mono` to `~/.pi/agent/git/github.com/juniorsundar/my-pi-mono`.
3. **`FUTURE_WORK.md`** — the old "complete the spawn handshake" entry was obsolete (framed around finishing the handshake #0004 decided to *drop*). Rewritten to "drop the spawn event-bus handshake (direct import)" with status: decision locked (#0004), implementation tracked by a **new** map ticket (see below).

### Decisions made in this ticket

**Web-search `.venv` strategy — reverses #0003.** #0003 decided the `.venv` commits and travels with the `git:` package. The repo actually gitignores `.venv`, so a fresh `git:` install would have no venv. The user ruled committing a `.venv` bad practice (non-relocatable, machine-specific, huge). **New decision: `.venv` stays gitignored; only `pyproject.toml` + `uv.lock` travel. `uv run --project EXTENSION_DIR` auto-provisions the venv on first execution** — verified empirically: removed `.venv`, ran `uv run --project . python scripts/search.py ...`, uv created the venv in 680ms (16 packages) and ran the script. No code change to web-search needed (`uv run` already syncs by default). This is cleaner than #0003 and makes the package machine-portable.

**#0004 implementation is separate work — new ticket.** #0004 is RESOLVED as a *decision* (drop the event bus, direct-import from the subagents barrel) but its implementation was never done: #0005 was a verbatim copy that kept `deep-research/index.ts` lines 56-64 (the `subagents:spawn:provide` listener + `:request` emit + structural mirror type + mutable `spawnSubagent` slot). The user decided the refactor is unblocked, separate implementation work and graduates onto the map as a new ticket — it is **not** folded into this cutover. So deep-research today still uses the (working) event-bus handshake; the handshake removal is tracked by [Drop the spawn event-bus handshake: direct-import spawnSubagent in deep-research](0007-drop-spawn-handshake.md). This ticket's step 5 ("deep-research can spawn (post-0004)") is satisfied by the handshake still working, not by the direct import.

### Empirical findings

- **Duplicate registration is a hard error, not last-wins.** With both `extensions/<name>/index.ts` (auto-discovered) and `my-pi-mono/extensions/<name>/index.ts` (package) present, pi errors at load: `Tool "<name>" conflicts with <other path>"`. So the ticket's envisioned "parallel window" (both sources live simultaneously while verifying) is **not** possible — the cutover had to be atomic (flip + remove together). (Evidence: the scout's stderr from probing the loader; reproduced by the load errors before the removal.)
- **Precondition held.** Monorepo typechecks (`tsc --noEmit` exit 0) and all 29 test files / 706 tests pass in the committed state.
- **Clean startup.** `pi --print "say only the word OK"` exits 0 with output `OK` and no load errors; `pi list` shows `my-pi-mono` resolving correctly.

### Rollback

Backups at `/tmp/settings.json.before-cutover`, `/tmp/cutover-backup-extensions/` (the four moved extension dirs), `/tmp/FUTURE_WORK.md.before-cutover`. To roll back: restore settings.json, move the four dirs back into `~/.pi/agent/extensions/`, restore FUTURE_WORK.md, remove `my-pi-mono` from packages.

### What this unblocks / graduates

- The map's **Not yet specified** "`btw` shared-registry module state" fog: now that `btw` loads from a package rather than auto-discovery, this is verifiable — graduates into the new ticket's sibling concern or a small verification (left in fog until the #0007 refactor touches deep-research; `btw` is unaffected by the cutover itself and its module-level singleton behaves identically under package loading, since jiti evaluates the module once per process either way — no separate ticket needed, can be dropped from fog).
- Phase 2 testing shape remains deferred fog (unchanged by this ticket).