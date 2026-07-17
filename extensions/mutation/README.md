# Mutation Package

<!-- Brief one-line description of this extension package. -->

## Overview

<!-- What this package does, the approval flows it owns, and how it fits into
the agent. Mention Bash Approval and edit/write Diff Approval. -->

## Files

| File | Purpose |
| ---- | ------- |
| `index.ts` | Entry point; registers the mutation package. |
| `bash-approval.ts` | Bash command approval flow. |
| `diff-approval.ts` | edit/write diff approval flow. |
| `overlay-component.ts` | Full-screen scrolling diff overlay component. |
| `diff-generation.ts` | Compact and full diff generation helpers. |
| `neovim-approval-utils.ts` | Shared Neovim launch utilities. |
| `neovim-diff-approval.ts` | Neovim diff approval (before/after) flow. |
| `permission-policy.ts` | Permission policy evaluation. |
| `permission-profile.ts` | Permission profile state and commands. |

## Approval Flows

### Bash

<!-- How bash approval works: ui.select modal, options, Neovim inspect/edit. -->

### edit/write

<!-- How diff approval works: ui.select modal with Approve / Deny /
Inspect/Edit in Neovim / Expand diff view. Inline renderCall diff card is a
read-only preview; the decision happens in the focus-grabbing modal. -->

## Permission Profiles

<!-- ask / yolo / custom profiles, how they map to confirm/bypass/block. -->

## Testing

<!-- How to run the tests (e.g. `npx vitest run extensions/mutation/`). -->

## Configuration

<!-- Any configuration knobs, env vars, or profile options. -->
