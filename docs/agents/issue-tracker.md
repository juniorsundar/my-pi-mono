# Issue tracker: Local Markdown (docs/ convention)

Issues and specs for this repo live as markdown files under `docs/`, following the repo's established convention (which pre-dates this setup).

## Conventions

- **Specs** (feature-level, written by `to-spec`): one file per spec at `docs/spec/NNNN-<slug>.md`, numbered sequentially from the highest existing.
- **Implementation tickets** (written by `to-tickets`): one file per ticket at `docs/tickets/NNNN-<slug>.md`, numbered sequentially. A ticket cross-references its spec via a `### Parent` section.
- **Triage state** is recorded as a `Labels:` line near the top of a file (e.g. `Labels: ready-for-agent`), using the strings in `triage-labels.md`. Absence of the line means untriaged.

## When a skill says "publish to the issue tracker"

Write the next-numbered file in the appropriate directory (`docs/spec/` for a spec, `docs/tickets/` for tickets) and apply the triage label as a `Labels:` line.

## When a skill says "fetch the relevant ticket"

Read the referenced file path. The user passes the path or the number.

## Wayfinding operations

Used by `/wayfinder`:

- **Map**: `docs/wayfinder/issues/NNNN-map.md` (marked `wayfinder:map`).
- **Child ticket**: `docs/wayfinder/issues/NNNN-<slug>.md`, with a `Type:` line (`research`/`prototype`/`grilling`/`task`) and `Status:` line (`claimed`/`resolved`).
- **Blocked by**: a `Blocked by: NN, NN` line near the top; a ticket is unblocked when every listed ticket is `resolved`.
- **Frontier / claim / resolve**: scan `docs/wayfinder/issues/` for open, unblocked, unclaimed tickets; claim by setting `Status: claimed`; resolve by appending the answer and setting `Status: resolved`, then recording the decision in the map.