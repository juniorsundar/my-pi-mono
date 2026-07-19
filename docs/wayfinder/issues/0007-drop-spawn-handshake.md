# Drop the spawn event-bus handshake: direct-import spawnSubagent in deep-research

`wayfinder:task` · **RESOLVED**

**Claimed by:** this session (pi-agent) — resolved.

Child of: [Map — Merge local extensions + pi-subagents into my-pi-mono](0001-map.md)

## Question

Implement the #0004 decision now that the source move (#0005) and cutover (#0006) are done: replace `deep-research`'s event-bus handshake with a direct import of `spawnSubagent` from the `extensions/subagents/index.ts` barrel, and update its tests. This is the implementation work #0004 deferred.

## Context

- **Decision (#0004, RESOLVED):** `extensions/subagents/index.ts` is the stable extension-facing barrel — it re-exports `spawnSubagent` plus the `SpawnSubagentOptions` / `SpawnSubagentResult` types. `extensions/deep-research/index.ts` should import all three from that barrel, never from `extensions/subagents/src/spawner` directly. The event-bus handshake (`subagents:spawn:provide` / `subagents:spawn:request`), `deep-research`'s structural `SpawnSubagentFunction` mirror type, and its mutable `let spawnSubagent` provider slot are removed. ES-module dependency resolution establishes the imported binding before either extension initializer runs, so extension load order is no longer relevant to spawning.
- **Current state (verified at cutover):** `extensions/deep-research/index.ts` lines 56-64 still use the handshake — `pi.events.on("subagents:spawn:provide", ...)`, `pi.events.emit("subagents:spawn:request", { requester: "deep-research" })`, the structural mirror type (~line 13), and `let spawnSubagent` (~line 47). #0005 was a verbatim copy and did not touch this.
- **Tests:** `extensions/deep-research/index.test.ts` mocks the event bus (`mockEventBus.emit("subagents:spawn:provide", ...)` and asserts `:request` is emitted). Rewrite to mock the direct import (`vi.mock` the subagents barrel / inject `spawnSubagent`).
- **FUTURE_WORK.md** already rewritten by #0006 to point at this ticket as the tracker for the removal.

## Tasks

1. In `extensions/deep-research/index.ts`:
   - Remove the structural `SpawnSubagentFunction` mirror type; import `spawnSubagent`, `SpawnSubagentOptions`, `SpawnSubagentResult` from `../subagents/index.js`.
   - Remove the `pi.events.on("subagents:spawn:provide", ...)` listener, the `pi.events.emit("subagents:spawn:request", ...)` init emit, and the `let spawnSubagent` mutable slot + its `resetSpawnSubagentForTesting` helper (or replace with a test-injection seam if needed).
   - Drop the graceful-degrade `pi.events` guards.
2. In `extensions/deep-research/index.test.ts`:
   - Replace the `mockEventBus.emit("subagents:spawn:provide", ...)` setup and the `:request`-emitted assertion with a `vi.mock` of `../subagents/index.js` (or inject `spawnSubagent`) so the test exercises the direct import.
   - Keep coverage of the spawn path (the "succeeds when subagents loads after deep-research" scenario becomes trivially true — load order no longer matters; either drop the load-order framing or repurpose the test to assert the direct call works).
3. Confirm the `subagents` suite and the root vitest suite still pass (`npm test`, `npm run typecheck` at repo root).
4. Update `FUTURE_WORK.md`: mark the "drop the spawn event-bus handshake" entry resolved/removed once the refactor lands.

## Scope

- Edits only in `my-pi-mono`: `extensions/deep-research/index.ts`, `extensions/deep-research/index.test.ts`, and `FUTURE_WORK.md` (dotfiles).
- Do **not** touch `extensions/subagents/` (the barrel is already correct per #0005).
- Do **not** change `settings.json` or `~/.pi/agent/extensions/` (cutover is done).

## Validation

- `npm run typecheck` exit 0 at `my-pi-mono` root.
- `npm test` — all test files pass (the updated deep-research tests + the unchanged subagents suite).
- No `subagents:spawn:*` event-bus references remain in `extensions/deep-research/`.
- `pi --print "say OK"` still starts clean (no load errors) after the change.

## Blocked by

[Cutover: switch `settings.json` to `my-pi-mono`, remove moved extensions](0006-cutover.md) — the monorepo must be the live source before editing it.

## Type

AFK task (agent can drive it alone; no human decision needed beyond approving the diff). Use `/tdd` — red (failing test asserting direct import) → green (refactor) → refactor.

## Resolution

Done via `/tdd` (red → green → refactor). The event-bus handshake is gone; `deep-research` imports `spawnSubagent` directly from the subagents barrel.

### Scope correction (approved by user)

The ticket said "Do not touch `extensions/subagents/` (barrel already correct per #0005)" but that was inaccurate: #0005 was a verbatim copy and did **not** apply #0004's barrel changes — the barrel did not export `spawnSubagent` or its types, and `subagents/src/index.ts` still emitted `subagents:spawn:provide`. The direct import the ticket requires cannot compile without those re-exports. The user approved the minimal subagents edit needed to honor #0004's decision. This is a scope correction to #0007, not a new decision.

### What changed

1. **`extensions/subagents/index.ts`** (barrel) — added `export { spawnSubagent } from "./src/spawner.js"` and `export type { SpawnSubagentOptions, SpawnSubagentResult } from "./src/spawner.js"`. This is the stable extension-facing import surface #0004 locked.
2. **`extensions/subagents/src/index.ts`** — removed the `emit("subagents:spawn:provide", spawnSubagent)` block (plus its graceful-degrade `pi.events?.emit` runtime defense). The provide side of the handshake is gone; `spawnSubagent` is now only reachable via the barrel import.
3. **`extensions/deep-research/index.ts`** — replaced the `SpawnSubagentFunction` structural mirror type, the `let spawnSubagent` mutable slot, `resetSpawnSubagentForTest`, the `pi.events.on("subagents:spawn:provide", ...)` listener, and the `pi.events.emit("subagents:spawn:request", ...)` init emit with a direct `import { spawnSubagent } from "../subagents/index.js"` + `import type { SpawnSubagentResult }`. Dropped the `if (!spawnSubagent)` "No spawner registered on event bus" guard (dead code under a direct import). `let result` is now annotated `SpawnSubagentResult`.
4. **`extensions/deep-research/index.test.ts`** — replaced the `mockEventBus` + `provideMockSpawnSubagent` / `resetSpawnSubagentForTest` plumbing with `vi.hoisted` + `vi.mock("../subagents/index.js", ...)`, so tests drive the mocked barrel import directly. `createMockPi` no longer carries an `events` mock. The "no spawner registered" test and the "load-order safety" test were repurposed: the former now asserts the directly-imported spawner is called with no provide step; the latter asserts no `subagents:spawn:request` is emitted and the barrel import works regardless of init order. Spawn-path, error, and retry tests now drive `mockedSpawnSubagent` via `.mockResolvedValue` / `.mockRejectedValueOnce` / `.mockImplementation`.
5. **`FUTURE_WORK.md`** (dotfiles) — the spawn-handshake entry is marked done, pointing back at this ticket.

### Validation

- `npm run typecheck` → exit 0 at `my-pi-mono` root.
- `npm test` → 29 files, 706 tests pass (deep-research suite: 41; subagents suite: 347).
- `grep -rn "subagents:spawn" extensions/deep-research/ extensions/subagents/` → only a comment remains in `deep-research/index.test.ts`; no runtime references.
- `pi --print "say OK"` → clean startup, no load errors.

### Files touched

- `extensions/subagents/index.ts` (+2)
- `extensions/subagents/src/index.ts` (−10)
- `extensions/deep-research/index.ts` (−67)
- `extensions/deep-research/index.test.ts` (rewritten spawn-mock plumbing)
- `~/.pi/agent/FUTURE_WORK.md` (entry marked done)

### Frontier after this

Phase 1 is fully complete. The only remaining map work is **phase 2** (merge the testing), still deliberately in **Not yet specified** fog — it graduates into tickets once phase 1 is absorbed. No new tickets to create from this resolution.