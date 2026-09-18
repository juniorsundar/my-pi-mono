# Mutation Package

Canonical owner of mutation-related policy and approval behavior for the pi
coding agent: permission profiles, bash approval, and the edit/write guard.

## Overview

Every `bash`, `edit`, and `write` tool call passes through the permission
policy (profiles: `safe` / `ask` / `yolo`). Calls that require confirmation
stop at a focus-grabbing `ui.select` modal offering:

    Approve / Deny / Inspect-Edit in Neovim

Inline transcript rendering is Pi's native tool preview — this package
registers no preview UI of its own (no diff cards, no overlays, no external
diff binaries).

## Files

| File | Purpose |
| ---- | ------- |
| `index.ts` | Entry point; registers the mutation package. |
| `permission-policy.ts` | Profile state and policy evaluation (protected paths, dangerous/catastrophic commands). |
| `permission-profile.ts` | `/permissions` command, status-bar indicator, session restore. |
| `diff-approval.ts` | Edit/write guard: `tool_call` interception and the Approve/Deny/Inspect-Edit modal loop. |
| `bash-approval.ts` | Bash approval: modal plus command editing in Neovim with an audit wrapper. |
| `neovim-diff-approval.ts` | Neovim before/after diff approval flow for edit/write (shared module). |
| `neovim-approval-utils.ts` | Shared Neovim launch utilities (process spawn, tmux integration). |

## Approval Flows

### Bash

`bash` calls stop at a `ui.select` modal: Approve / Deny / Inspect/Edit in
Neovim. Inspect/Edit opens the command in a script buffer (`:Approve` /
`:Deny`, or `<leader><leader>A` / `<leader><leader>D`); an edited command is
approved with an audit prefix printed to stderr before execution. A missing
`nvim` notifies and denies. Approvals for concurrent bash calls are
serialized.

### edit/write

`edit`/`write` calls are intercepted in `tool_call`. Policy first (block /
bypass / confirm), then a `ui.select` modal: Approve / Deny / Inspect-Edit in
Neovim. Inspect-Edit opens `nvim -d` with before/after buffers; the after
buffer is editable, an approval loops back to the modal for a final explicit
confirm, and the edited content is applied on approve (write: content
replaced; edit: a single whole-file old/new edit pair). A Neovim deny is
final. Binary, unreadable, or unsafe-to-validate targets skip Neovim and fall
back to a plain text confirm; a missing `nvim` notifies and falls back the
same way. A second mutation arriving while an approval is pending is denied.

## Permission Profiles

`safe` / `ask` / `yolo` via the `/permissions` command, with a status-bar
indicator and session restore. Protected paths (`.env`, `.ssh`, `.gnupg`,
`node_modules`, `.git`, secrets) are blocked in every profile. `yolo` bypasses
ordinary confirmations but still blocks catastrophic shell commands. Profile
state is bridged through the environment because extensions load in isolated
module contexts.

## Testing

    npx vitest run extensions/mutation/

Tests drive the extension-level seam: a fake extension API (captured
handlers/commands), a scripted UI context, and temp-dir working directories.
The Neovim launch utilities are mocked; Neovim decisions are simulated by
writing the decision file the real flow reads.

## Configuration

No configuration knobs beyond the environment bridges: the permission profile
state key and the subagent-child marker consumed by the policy.