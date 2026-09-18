# Reduce mutation extension to the bare approval guard

### Parent

Spec 0011 — Reduce the Mutation extension to the bare approval guard

### What to build

Strip the mutation extension of all preview machinery — the custom edit/write tool overrides with inline Approval Cards, the full-screen diff overlay, the delta/diff-based generation modules, and the verdict lines — leaving only the allow/deny/edit-in-Neovim guard shared by bash and edit/write, permission profiles, and the existing Neovim approval machinery. Restore Pi's native preview rendering for edit/write. Non-diffable targets (binary, unreadable, unsafe edit validation) fall back to a plain text confirm.

### Acceptance criteria

- [x] The custom write/edit tool registrations are removed; edit/write calls render with Pi's native preview cards
- [x] `edit` and `write` calls requiring confirmation stop at a `ui.select` modal offering exactly: Approve / Deny / Inspect-Edit in Neovim
- [x] "Expand diff view" is no longer offered anywhere
- [x] Inspect-Edit opens the existing Neovim before/after diff; an approval after editing returns to the modal for confirmation, and final approve applies the edited content (write: replaced content; edit: whole-file old/new pair when changed)
- [x] A Neovim deny is final and blocks the tool call
- [x] Binary, unreadable, and unsafe-to-validate mutations skip Neovim and fall back to a plain `ui.confirm` with a short reason; no diff is rendered or generated
- [x] The pre-approval file-fingerprint re-check and the large-diff warning are removed
- [x] Verdict lines (✓ approved / ✗ denied transcript annotations and the model-facing hidden verdict message) are removed; outcomes are conveyed by standard tool results (success or block-with-reason)
- [x] The overlay component, its test file, and the diff-generation module (delta + `diff -u` paths) are deleted
- [x] The bash approval flow is unchanged except for verdict emission removal (Approve / Deny / Inspect-Edit in Neovim, edited-command audit wrapper, serialized approvals intact)
- [x] Guard wiring is preserved: policy evaluation (safe/ask/yolo, protected paths, dangerous commands), /tmp bypass, subagent-child bypass, no-UI block, and pending-approval denial of a second mutation
- [x] Shared Neovim launch utilities, permission policy, profile command, and the package entry point are unchanged
- [x] Tests: preview/overlay/verdict/fingerprint/atomic-reveal tests are deleted; retained wiring tests pass via the extension-level seam (fake pi + scripted UI + temp-dir cwd) with the Neovim launch utilities mocked; new/adjusted tests cover the three-option modal, Neovim round-trip for edit/write, and the plain-confirm fallback
- [x] `npx vitest run extensions/mutation/` passes and `npm run typecheck` is clean
- [x] Package README's placeholder sections are filled in to describe the reduced package; root context document's mutation-related entries (Approval Card glossary, package description) are updated; spec 0010 / ticket 0057 / ADR 0008 left untouched as history

### Blocked by

None — can start immediately.