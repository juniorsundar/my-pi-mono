# web-search Python asset resolution under package loading

`wayfinder:research` · **RESOLVED**

Child of: [Map — Merge local extensions + pi-subagents into my-pi-mono](0001-map.md)

## Question

When `web-search` is loaded from an installed `git:` package (rather than auto-discovered from `~/.pi/agent/extensions/web-search/`), how do its Python assets resolve, and what needs to change?

## Resolution

**Nothing about the loading mechanism changes. pi uses `jiti` (runtime TS→CJS transform), not a bundler, so `__dirname` stays available and `EXTENSION_DIR` resolves correctly from a `git:` package the same way it does from `extensions/`. The `.venv` travels with the package. No code change required for asset resolution; the move is a straight copy.**

### Evidence

1. **`__dirname` works under pi's loader.** pi loads extensions via `jiti` — `dist/core/extensions/loader.js:2` ("Extension loader - loads TypeScript extension modules using jiti"), `:14` `import { createJiti } from "jiti/static"`, `:320` `jiti.import(extensionPath, { default: true })`. jiti transforms TS at runtime and evaluates it in a CJS-compatible scope where `__dirname`/`require` are defined. So `web-search/index.ts:103` `const EXTENSION_DIR = __dirname;` resolves to the directory of the loaded `index.ts` regardless of whether that path is under `~/.pi/agent/extensions/` or inside an installed package. `import.meta.url` is **not** required; switching to it is optional, not a fix.

2. **The `.venv` travels with a `git:` package.** `~/.pi/agent/extensions/web-search/` has no `.gitignore`, and the dotfiles `.pi/agent/.gitignore` does **not** list `.venv` or `web-search` — `git check-ignore .pi/agent/extensions/web-search/.venv` returned "NOT ignored". (`.pi/agent/.git` is a gitdir file: `gitdir: ../../../.git/modules/pi` — the `.pi` tree is a submodule.) So the `.venv/`, `pyproject.toml`, `uv.lock`, and `scripts/*.py` all commit and travel with a `git:` package install. No postinstall/`uv sync` step is needed for phase 1.

3. **`uv run --project EXTENSION_DIR` survives the move.** `--project` points uv at the directory containing `pyproject.toml` (`uv run --project <dir>` uses `<dir>` as the project root). Since `pyproject.toml` stays co-located with `index.ts` (and `EXTENSION_DIR = __dirname` points at that same dir after the move), the flag's semantics are unchanged.

### Caveat / not verified

- The `.venv` contains absolute paths in its shebangs/activation scripts (Python venvs are non-relocatable). If the package is installed to a different absolute path on another machine, the committed `.venv` may not work there. **For this monorepo (single user, same `~/.pi/agent/git/...` clone path as today) this is fine.** If cross-machine portability ever matters, that becomes a separate ticket — not phase 1.
- Whether pi's `git:` package install copies the `.venv` verbatim or skips it (some installers prune heavy dirs) — unverified, but low-risk because the current `extensions/` path is *also* machine-local and works. Verify empirically at the cutover (ticket 0006).

### What this unblocks

The migrate-sources ticket (0005) can copy `web-search/` verbatim into the monorepo layout with no `__dirname`→`import.meta.url` rewrite and no venv-rebuild step.