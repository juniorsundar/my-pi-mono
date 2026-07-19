# Unify the `spawnSubagent` exporter: drop the event bus

`wayfinder:grilling` · **RESOLVED**

**Claimed by:** pi-agent — resolved.

Child of: [Map — Merge local extensions + pi-subagents into my-pi-mono](0001-map.md)

## Resolution

The canonical extension-facing import surface is the **subagents entry barrel**: `extensions/subagents/index.ts` re-exports `spawnSubagent` plus the `SpawnSubagentOptions` and `SpawnSubagentResult` types from `./src/spawner`. `extensions/deep-research/index.ts` imports all three from that barrel, never from `extensions/subagents/src/spawner` directly.

The barrel is the stable contract between extensions; `subagents/src/` remains private and can be reorganized without changing its consumer. After the source move, remove the provider/request event-bus handshake and deep-research's structural mirror type and mutable provider slot. Tests mock the subagents barrel rather than simulating the event bus. ES-module dependency resolution establishes the imported binding before either extension initializer runs, so extension load order is no longer relevant to spawning.

## Question

Replace the `subagents:spawn:provide` / `subagents:spawn:request` event-bus handshake with a **direct import** of `spawnSubagent` from the subagents source within `my-pi-mono`, now that both live in one package.

Today (`FUTURE_WORK.md` documents the half-implemented state):

- `deep-research/index.ts` declares a structural `SpawnSubagentFunction` mirror type to avoid a cross-package type dependency, listens for `subagents:spawn:provide`, and emits `subagents:spawn:request` at init.
- `pi-subagents/src/index.ts` emits `subagents:spawn:provide` at init but never listens for `:request` — load-order safety is not actually covered.

In the monorepo the cross-package boundary vanishes, so:

1. **Decide the import surface.** `deep-research/index.ts` should import `spawnSubagent` (and the real `SpawnSubagentOptions` / `SpawnSubagentResult` types) directly. Is the cleanest export a barrel from the subagents entry (`index.ts` re-exports `spawnSubagent`), or a direct path to `extensions/subagents/src/spawner.ts`? Lock the canonical export path. (Depends on the layout ticket's decision.)
2. **Remove the handshake.** Delete the `subagents:spawn:provide` listener + `subagents:spawn:request` emit in `deep-research/index.ts`; delete the `provide` emit + any `:request` handling in the subagents entry. Remove the structural `SpawnSubagentFunction` mirror type — use the real types.
3. **Update tests.** `deep-research/index.test.ts` mocks the event bus (`mockEventBus.emit("subagents:spawn:provide", ...)`, asserts `:request` is emitted). Rewrite to mock the direct import instead (vi.mock the subagents module / inject `spawnSubagent`). Confirm the `pi-subagents` suite still passes after the emit removal.
4. **Verify load-order.** With a direct import, load order between the two extensions no longer matters for the spawn seam — confirm by reasoning/test.

Blocked by: [Repo skeleton + single-package shape](0002-repo-skeleton.md).