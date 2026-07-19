# Repo skeleton + single-package shape for `my-pi-mono`

`wayfinder:grilling` · **RESOLVED**

Child of: [Map — Merge local extensions + pi-subagents into my-pi-mono](0001-map.md)

**Claimed by:** this session (pi-agent) — resolved.

## Question

What is the exact on-disk structure of `my-pi-mono` as **one package with many extensions** (not separately-publishable sub-packages)?

## Resolution

### Layout — flat `extensions/`, one root package

```
my-pi-mono/
  package.json          (one; name my-pi-mono, private, pi.extensions: ["./extensions"])
  tsconfig.json         (NodeNext; paths for @earendil-works/* + typebox; include extensions/**)
  vitest.config.ts      (root; one suite across extensions/**)
  LICENSE
  .gitignore
  extensions/
    btw/index.ts (+ parser, registry, review, spawner, spinning-list, text-utils, timeout-config, types)
    deep-research/index.ts (+ config, state-manager)
    mutation/index.ts (+ bash-approval, diff-approval, diff-generation, neovim-*, overlay-component, permission-policy, permission-profile, verdict)
    web-search/index.ts (+ scripts/*.py, .venv/, pyproject.toml, uv.lock)
    subagents/index.ts  (re-export barrel: export { default, resolveModel, formatCallHeader } from "./src/index")
      src/   (activity-feed-*, agent-definition-parser, command-builder, index, process-registry, progress-event, spawner, stream-processor, task-workspace, workspace-store)
      test/  (all subagent tests)
      docs/adr/  (0001..0003)
      CONTEXT.md
```

- Each extension is a subdirectory with an `index.ts` entry point. pi discovers them via `pi.extensions: ["./extensions"]` → `discoverExtensionsInDir` walks one level and resolves each subdir's `index.ts` (loader.js:475, rule 2 "Subdirectory with index"). **No per-entry enumeration needed.** No recursion beyond one level, so `extensions/subagents/src/` is *not* scanned for entry points — only `extensions/subagents/index.ts` loads.
- `omniroute-pi-provider` is **out of scope** — stays in `~/.pi/agent/extensions/`, not copied here.

### Root tooling — tsconfig + vitest only (no biome, no workspaces, no per-package package.json)

**`package.json`:**
- `name: "my-pi-mono"`, `private: true`, `type: "module"`.
- `pi: { extensions: ["./extensions"] }`.
- `peerDependencies`: `@earendil-works/pi-coding-agent ^0.80.0`, `@earendil-works/pi-tui ^0.80.0`, `@earendil-works/pi-ai ^0.80.0`, `typebox *` (pi bundles these; list as peer with `*` per docs/packages.md, but pin a floor of `^0.80.0` since both the dotfiles and global install are 0.80.10 and rpiv-mono uses `^0.80.5`).
- `dependencies`: `yaml ^2.9.0` (used by subagents' agent-definition-parser).
- `devDependencies`: `@earendil-works/pi-coding-agent ^0.80.0`, `@earendil-works/pi-tui ^0.80.0`, `@earendil-works/pi-ai ^0.80.0`, `typebox *`, `@types/node ^22`, `vitest ^3.1.1`.
- `scripts`: `test: "vitest run"`, `test:watch: "vitest"`, `typecheck: "tsc --noEmit"`.
- No `workspaces`, no `publishConfig`, no per-package `package.json`s.

**`tsconfig.json`:**
- `target: ES2022`, `module/moduleResolution: NodeNext`, `strict: false`, `skipLibCheck: true`, `noEmit: true`.
- `paths`: `@earendil-works/*` → `node_modules/@earendil-works/*`, `typebox` → `node_modules/typebox` (mirror the dotfiles tsconfig; resolve via the package's own `node_modules` after `npm install`, not a `.direnv` hack).
- `include: ["extensions/**/*.ts"]`.

**`vitest.config.ts`:** root config covering `extensions/**/*.test.ts`. Phase 1 keeps each extension's existing test files where they are; phase 2 (merge testing) may consolidate config. No coverage tooling yet.

### Version alignment — `^0.80.0`

- pi-subagents currently pins `^0.79.0`; the dotfiles `.direnv` and global install are both `0.80.10`; rpiv-mono uses `^0.80.5`. **Bump the monorepo's pi peer-deps to `^0.80.0`** (floor that covers 0.80.10). This supersedes the subagents `^0.79.0` pin — the move is a version bump, noted for the cutover ticket.

### Git remote + disk path

- Remote: `github.com/juniorsundar/my-pi-mono` (`git+https://github.com/juniorsundar/my-pi-mono.git`).
- Cloned to `~/.pi/agent/git/github.com/juniorsundar/my-pi-mono/` (matches the existing `git/github.com/juniorsundar/pi-subagents/` convention).
- Loaded via `settings.json` `packages: ["git:github.com/juniorsundar/my-pi-mono"]`.
- Repo init (create the dir, `git init`, first commit) is a mechanical step folded into the migrate-sources task (0005), not a separate decision.

### What this unblocks

- **0004 (unify spawnSubagent exporter):** the canonical import path is `extensions/subagents/src/spawner.ts` exporting `spawnSubagent` + `SpawnSubagentOptions`/`SpawnSubagentResult` types; `deep-research/index.ts` imports directly from that path (relative `../subagents/src/spawner.js` or via the re-export barrel `../subagents/index.js`).
- **0005 (migrate sources):** copy each extension verbatim into `extensions/<name>/`; bring subagents `src/`, `test/`, `docs/adr/`, `CONTEXT.md` under `extensions/subagents/`; write the root `package.json`/`tsconfig.json`/`vitest.config.ts` above.