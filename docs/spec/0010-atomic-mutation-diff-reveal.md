# Atomic mutation diff reveal

## Problem Statement

When Pi streams arguments for the mutation extension's `edit` and `write` tools, the inline diff preview is regenerated and displayed repeatedly from partial inputs. Large diffs therefore accumulate line-by-line in the tool row, repeatedly changing its height and making the active agent and surrounding transcript flicker vertically.

Users need to retain the existing compact mutation preview and approval workflow without watching the diff stream into the UI.

## Solution

While an `edit` or `write` call's arguments are incomplete, show a one-line **Pending Summary** containing the tool name, any currently available partial path, and `preparing diff…`. Keep that row one line high and perform no preview work during this phase.

At Pi's `argsComplete` boundary, replace the Pending Summary with the existing **Approval Card** in one **Atomic Reveal**. Preserve the Approval Card's current compact diff, metadata, truncation, warning, and error behavior. Keep the approval selector independent from inline rendering.

## User Stories

1. As a Pi user, I want large edit diffs to appear at once, so that the active agent does not flicker vertically while arguments stream.
2. As a Pi user, I want large write diffs to appear at once, so that the transcript remains visually stable while content is generated.
3. As a Pi user, I want a Pending Summary while an edit is being prepared, so that I know which tool is active before its arguments are complete.
4. As a Pi user, I want a Pending Summary while a write is being prepared, so that I receive immediate feedback without seeing an incomplete preview.
5. As a Pi user, I want the available partial target path shown in the Pending Summary, so that I can identify the intended mutation as early as possible.
6. As a Pi user, I want the Pending Summary to remain one line high while its partial path changes, so that argument streaming does not move the surrounding transcript vertically.
7. As a Pi user, I want the completed Approval Card to preserve its current compact diff, so that the anti-flicker change does not reduce useful review information.
8. As a Pi user, I want existing hunk truncation and line-count metadata preserved, so that large diffs remain concise and understandable.
9. As a Pi user, I want binary and unreadable-file warnings withheld until arguments are complete, so that every mutation follows the same stable rendering lifecycle.
10. As a Pi user, I want invalid-edit messages withheld until arguments are complete, so that errors are based on the final input rather than an incomplete argument snapshot.
11. As a Pi user, I want diff-generation errors revealed only after arguments are complete, so that partial inputs do not produce transient error cards.
12. As a Pi user, I want the approval selector to retain its existing choices and behavior, so that approving, denying, inspecting in Neovim, and expanding the diff work as before.
13. As a Pi user, I want the inline Approval Card and approval selector to remain independent, so that the selector does not become coupled to terminal repaint timing.
14. As a Pi user whose mutation is policy-bypassed, I want the same Pending Summary and Atomic Reveal behavior, so that edit/write rendering is consistent even when no approval prompt opens.
15. As a child-agent user, I want edit/write calls to use the same rendering lifecycle, so that visual behavior does not depend on whether a call originated in the main agent.
16. As a Pi user, I want the change confined to the mutation extension, so that adopting it does not require a Pi core or rendering API change.
17. As a Pi user, I want preview work deferred until complete arguments exist, so that streaming does not repeatedly read files, validate edits, or generate diffs.
18. As a maintainer, I want a single explicit `argsComplete` transition between render states, so that the behavior follows Pi's existing tool-rendering lifecycle.
19. As a maintainer, I want the existing Approval Card implementation reused, so that this focused UX fix does not create a second completed-preview implementation.
20. As a maintainer, I want behavioral tests at the registered tool renderer seam, so that tests cover what Pi invokes without depending on the entire interactive TUI.

## Implementation Decisions

- The mutation extension's registered `edit` and `write` call renderers will implement two states based on Pi's existing `argsComplete` render context value.
- When `argsComplete` is false, the renderer will return a one-line Pending Summary in the form `✎ <tool> <partial path> · preparing diff…`.
- The path may update as partial arguments stream. The Pending Summary's height must remain one line; the requirement is dimensional stability rather than character-for-character immutability.
- Rendering the Pending Summary will not read the target file, validate an edit, inspect binary state, or generate a diff.
- When `argsComplete` becomes true, the renderer will perform one Atomic Reveal of the existing Approval Card.
- The completed Approval Card will retain its current compact diff, hunk truncation, line counts, title/path metadata, approval hints, warnings, and errors.
- Atomic Reveal applies to every registered `edit` and `write` call, including policy-bypassed and child-agent calls. “Approval Card” names the inline component style; it does not imply that an approval selector necessarily opened.
- Binary or unreadable targets, invalid edits, and preview-generation failures will remain in Pending Summary until arguments complete and will then reveal their existing completed warning or error state.
- The approval selector remains a separate interaction owned by the tool-call interception flow. It will not wait for an inline render acknowledgement.
- Preview generation will not be centralized into a shared artifact between the renderer and approval selector as part of this change.
- The implementation remains within the mutation extension and will not modify Pi core or the tool-rendering API.
- The Pending Summary will use a static indicator. A true animated Pi-style spinner is not required because the renderer lacks the TUI handle needed by Pi's animated loader.
- The expected lifecycle is Pending Summary during argument streaming, followed by exactly one intentional vertical expansion when the complete Approval Card is revealed.

## Testing Decisions

- Use one primary behavioral seam: invoke the `renderCall` functions on the registered `edit` and `write` tool definitions with controlled render contexts. This is the highest existing seam below Pi's full interactive TUI and matches how Pi consumes extension renderers.
- Extend the existing mutation extension test suite, which already captures registered tools and directly exercises their `renderCall` functions.
- Test externally visible rendered behavior rather than private helper structure. Assertions should inspect rendered text and dimensions for the Pending Summary and Approval Card.
- Verify both `edit` and `write` render a one-line Pending Summary when `argsComplete` is false.
- Verify the Pending Summary includes the tool name, the currently available partial path, and `preparing diff…`.
- Verify a missing or not-yet-streamed path still produces a valid one-line Pending Summary.
- Verify partial path growth may change the line's text but does not change its height.
- Verify incomplete arguments do not produce diff lines, warning content, validation errors, or diff-generation errors.
- Verify the no-preview-work contract through observable side effects at this seam: an incomplete call targeting an absent or otherwise problematic path must still render only the Pending Summary and must not invoke preview dependencies. Where dependency observation requires instrumentation, prefer injecting or spying at the renderer boundary rather than exposing new production APIs.
- Verify changing the same call to `argsComplete: true` reveals the existing Approval Card with its compact diff and metadata.
- Verify completed binary/unreadable, invalid-edit, and preview-generation-failure inputs reveal their existing warning or error cards only after the boundary.
- Preserve the existing test that an edit preview remains stable after execution mutates the target file.
- Preserve existing approval-flow tests to demonstrate that approval, denial, Neovim inspection, expanded diff viewing, policy bypasses, and child-agent behavior are not changed by rendering state.
- A full terminal animation or screenshot test is not required. The key regression contract is one-line pending height plus no preview output/work before `argsComplete`, followed by the existing completed card.

## Out of Scope

- Changing the contents, styling, metadata, truncation rules, or layout of the completed Approval Card.
- Showing a full unabridged diff inline.
- Replacing the compact diff with a counts-only summary.
- Changing approval, denial, Neovim inspection/editing, or expanded diff-view interactions.
- Synchronizing the approval selector with terminal repaint completion.
- Sharing one centrally generated preview artifact between inline rendering and the approval flow.
- Modifying Pi core, `ToolRenderContext`, or the extension rendering API.
- Adding a true animated spinner to the Pending Summary.
- Preventing horizontal text updates as the partial path streams.
- Eliminating the single intentional height change when the Approval Card is revealed.

## Further Notes

- The domain terms **Pending Summary**, **Approval Card**, and **Atomic Reveal** are defined in the project context glossary.
- The accepted architectural decision is recorded in ADR 0008, “Atomically reveal mutation Approval Cards after arguments complete.”
- The root cause is repeated invocation of the custom call renderer with partial arguments. Deferring all preview work to `argsComplete` addresses both the visible flicker and unnecessary repeated synchronous preview generation.
