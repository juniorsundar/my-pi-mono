# Migrate extension sources into `my-pi-mono`

`wayfinder:task` · **RESOLVED**

**Claimed by:** pi-agent — resolved.

Child of: [Map — Merge local extensions + pi-subagents into my-pi-mono](0001-map.md)

## Question

Physically move the four in-scope extensions (`btw`, `deep-research`, `mutation`, `web-search`) and the whole `pi-subagents` source (`src/`, `test/`, `docs/adr/`, `CONTEXT.md`) into the layout the repo-skeleton ticket locks, as a parallel copy (no cutover yet — the dotfiles `extensions/` stays working).

Tasks:

1. Copy each extension's files into the monorepo at the decided path. Preserve co-located assets (web-search `scripts/*.py`, `.venv`, `pyproject.toml`, `uv.lock`; btw prompts if any; mutation `README.md`).
2. Bring `pi-subagents/src/*`, `test/*`, `docs/adr/*`, `CONTEXT.md` into the monorepo at the decided path. Decide what happens to the root `index.ts` re-export barrel (`export { default, resolveModel, formatCallHeader } from "./src/index"`).
3. Add/adjust import paths so internal references resolve inside the new layout (relative imports between an extension's own files; the cross-extension import lands in the unify-exporter ticket, not here).
4. Get `tsc --noEmit` to pass on the monorepo.
5. Get each extension's existing tests to pass from the new location (run the root vitest against the new tree). Note any tests that need path adjustments and list them — do not rewrite test logic here (phase 2 owns test merging).

Blocked by: [Repo skeleton + single-package shape](0002-repo-skeleton.md), [web-search Python asset resolution](0003-websearch-asset-resolution.md). The unify-exporter change ([0004](0004-unify-spawn-exporter.md)) is applied on top of this move, so this ticket lands the sources with the event-bus handshake *intact* first, then 0004 removes it.

## Resolution

Created the local-only repository at `~/.pi/agent/git/github.com/juniorsundar/my-pi-mono` (no GitHub remote, per the local-repository choice) and initialized its one-package root:

- Root `package.json` declares `pi.extensions: ["./extensions"]`, pi `^0.80.0` peer/dev dependencies, `yaml`, and root `test` / `typecheck` scripts; `tsconfig.json` is NodeNext and typechecks production sources; `vitest.config.ts` discovers `extensions/**/*.test.ts`.
- Copied `btw`, `deep-research`, `mutation`, and `web-search` into `extensions/`, including `mutation/README.md`, web-search scripts, fixtures, `pyproject.toml`, `uv.lock`, and its co-located `.venv/` (made trackable by removing the copied venv's nested `*` ignore rule).
- Copied the subagents barrel to `extensions/subagents/index.ts`, plus `src/`, `test/`, `docs/adr/`, and `CONTEXT.md`. The barrel still re-exports the existing subagents extension; deep-research's event-bus handshake remains intact for [Unify the `spawnSubagent` exporter: drop the event bus](0004-unify-spawn-exporter.md)'s change.
- Normalized internal relative TypeScript imports to NodeNext `.js` specifiers. The few pi 0.80 API/type adjustments are limited to keeping the copied sources type-safe (read-only session APIs, supported notification levels, and stricter callback/result types); they do not change the event-bus boundary.

### Validation

From `~/.pi/agent/git/github.com/juniorsundar/my-pi-mono`:

- `npm run typecheck` — passed.
- `npm test` — passed: **29 test files, 706 tests**. Repeated three times after the first successful run; all passed.
- `extensions/web-search/.venv/bin/python -m pytest extensions/web-search/scripts/tests -q` — passed: **225 tests**.

The root Vitest suite keeps every test in its copied extension location. Required path-only adjustments were NodeNext `.js` specifiers, the subagents source-reading regression test's expected `.js` import strings, and test mocks/assertions for pi 0.80's extension API; no test-suite consolidation was done. Phase-2 test-shape decisions remain deferred.