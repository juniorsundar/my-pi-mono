# Atomically reveal mutation Approval Cards after arguments complete

## Status

Accepted

## Context

The mutation extension overrides Pi's `edit` and `write` renderers with a compact inline diff card. Pi calls `renderCall` repeatedly while tool arguments stream. The current renderer reads the target, validates the proposed mutation, and generates a compact diff from each partial argument snapshot. On large changes, the card repeatedly grows and changes height as diff lines accumulate, causing the surrounding transcript and active agent UI to flicker vertically.

The approval selector is a separate interaction opened by the `tool_call` handler. The inline renderer is a read-only preview; it does not own the approve/deny decision.

Pi exposes `ToolRenderContext.argsComplete`, which marks the boundary between partial and complete tool arguments. The extension renderer does not receive the TUI handle required by Pi's animated `Loader`, so matching Pi's true thinking spinner would require a core/API change.

## Decision

Every `edit` and `write` call uses two inline render states:

1. While `argsComplete` is false, render a one-line **Pending Summary** in the form `✎ <tool> <partial path> · preparing diff…`. The partial path may grow as arguments stream, but the row remains one line high. Rendering this state must not read the target file, validate the edit, or generate a diff.
2. When `argsComplete` becomes true, perform one **Atomic Reveal** of the existing **Approval Card**. The completed card's compact diff, metadata, truncation behavior, warnings, and errors remain unchanged.

The Atomic Reveal applies to every `edit` and `write` render, including policy-bypassed calls and child-agent calls. Binary or unreadable targets, invalid edits, and diff-generation failures remain in the Pending Summary state until arguments complete, then reveal their existing warning or error card atomically.

The approval selector and renderer remain independent. The selector does not wait for a render acknowledgement, and preview generation is not centralized into a shared artifact.

This change stays within `extensions/mutation`; Pi core and its rendering API are not changed. The Pending Summary uses a static indicator rather than a true animated spinner.

## Consequences

- Large diffs no longer stream line-by-line into the transcript, eliminating repeated vertical expansion during argument generation.
- The partial path can still update horizontally while arguments stream.
- Preview work happens only after complete arguments are available, avoiding repeated file reads, edit validation, and synchronous diff generation.
- The final Approval Card and approval workflow preserve their current behavior.
- There may still be one intentional height change when the Pending Summary is replaced by the completed Approval Card.
- A true animated pending spinner remains unavailable unless Pi later exposes suitable animation support to tool renderers.

## Validation

Tests should enforce that when `argsComplete` is false:

- the renderer returns the one-line Pending Summary;
- the currently available partial path is shown;
- no target-file read, edit validation, or diff generation occurs; and
- diff, warning, validation-error, and generation-error content is not rendered.

Tests should also enforce that crossing to `argsComplete: true` renders the existing Approval Card atomically for normal text diffs and existing exceptional outcomes, without changing the independent approval flow.
