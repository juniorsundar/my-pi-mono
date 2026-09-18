# Reduce the Mutation extension to the bare approval guard

### Parent

None — standalone reduction, approved in conversation (exploration + decisions locked this session).

### Problem Statement

The Mutation Package owns mutation-related approval behavior for bash, edit, and write. Over time it accreted three layers of preview machinery on top of its core job — the allow/deny/edit-in-Neovim guard:

1. Custom tool overrides for edit/write whose only purpose is to replace Pi's native previews with a bespoke inline Approval Card (compact diff, binary warnings, validation errors, verdict-background repainting, atomic-reveal lifecycle — spec 0010 / ticket 0057 / ADR 0008).
2. A full-screen scrolling diff overlay behind an "Expand diff view" modal option, fed by `delta` (with a `diff -u` fallback) and a second `diff -u` parse for the inline card.
3. Verdict lines (✓ approved / ✗ denied annotations) emitted to the transcript for every decision.

The user does not want any of this. They want the guard — allow, deny, or inspect/edit in Neovim — and nothing else. The preview machinery is the bulk of the package (~1,400 of ~3,500 LOC), it shells out to external diff binaries (`delta`) whose absence or behavior changes what the user sees, and it demands disproportionate test and maintenance effort for something the user explicitly does not use. Meanwhile Pi's native preview cards were perfectly adequate, and are currently suppressed by the custom tool overrides.

### Solution

Strip the Mutation Package down to its guard:

- Every `bash` call stops at a focus-grabbing selector: **Approve / Deny / Inspect-Edit in Neovim** (with command editing and the edited-command audit wrapper — this flow already is the target shape and is kept as-is).
- Every `edit` / `write` call goes through the same policy and presents **Approve / Deny / Inspect-Edit in Neovim**. Inspect-Edit opens the existing Neovim before/after diff (`nvim -d`), and an approval after editing applies the edited content.
- The custom edit/write tool overrides are removed; Pi's native preview cards render again inline.
- Targets that cannot be rendered as a diff (binary, unreadable, edits that fail safe preview validation) fall back to a plain text confirmation instead of any diff.
- Verdict lines are dropped entirely; the standard tool result is the record of what happened.

Permission profiles (safe / ask / yolo), protected paths, dangerous-command policy, /tmp bypass, subagent bypass, and no-UI blocking are unchanged.

### User Stories

1. As a pi user, I want every bash command request to stop and present an Approve/Deny choice, so that no shell command runs without my consent.
2. As a pi user, I want every edit/write request to stop and present an Approve/Deny choice, so that no file is changed without my consent.
3. As a pi user, I want to inspect the exact bash command in Neovim before deciding, so that I can read long or multi-line commands in full instead of a truncated preview.
4. As a pi user, I want to edit the bash command in Neovim and approve the edited version, so that I can fix a dangerous or broken command while keeping its intent.
5. As a pi user, I want an audit prefix emitted when a bash command was edited before execution, so that I can later see what actually ran versus what was proposed.
6. As a pi user, I want to review the proposed file change as a before/after diff in Neovim, so that I can judge the change in my own editor, colorscheme, and keybindings.
7. As a pi user, I want to edit the after-content in Neovim and approve the edited content, so that I can correct small mistakes without another agent round-trip.
8. As a pi user, I want the flow to return to the selector after a Neovim edit, so that my final consent is a deliberate keystroke in the modal rather than a side effect of leaving the editor.
9. As a pi user, I want a Neovim deny to be an immediate, final decision, so that exiting the editor with :Deny does not bounce me back to another prompt.
10. As a pi user, I want permission profiles (safe / ask / yolo) selectable via /permissions, so that I can choose how much the guard interrupts me.
11. As a pi user, I want a persistent status-bar indicator of the current profile, so that I always know how guarded the session is.
12. As a pi user, I want protected paths (.env, .ssh, .gnupg, node_modules, .git, secrets) blocked in every profile, so that sensitive targets are never mutated.
13. As a pi user, I want yolo to bypass prompts for ordinary mutations, so that trusted, low-risk work is not interrupted.
14. As a pi user, I want yolo to still block catastrophic shell commands, so that unattended automation cannot destroy my system.
15. As a pi user, I want /tmp mutations to pass without prompting, so that scratch-file work is never interrupted.
16. As a pi user, I want subagent child sessions to mutate without interactive gates, so that automated child agents do not hang waiting for input no one will give.
17. As a pi user, I want binary, unreadable, or unsafe-to-preview edits to fall back to a plain text confirm, so that the guard still works where no diff can be rendered.
18. As a pi user, I want edit/write to be blocked when no UI is available, so that headless contexts cannot mutate silently.
19. As a pi user, I want a second mutation request while an approval is pending to be denied immediately, so that approvals stay unambiguous and one-at-a-time.
20. As a pi user, I want missing Neovim to degrade gracefully (bash: notify + deny; edit/write: notify + plain text confirm), so that the guard never dead-ends.
21. As a pi user, I want native Pi preview cards for edit/write tool calls, so that inline transcript rendering is standard, familiar, and zero-maintenance.
22. As a pi user, I want no dependence on the `delta` binary, so that approvals never depend on an external pager being installed or behaving differently.
23. As a pi user, I want no extra confirmation round-trips (large-diff warnings, file-changed fingerprint re-checks, preview-safety confirms), so that deciding a mutation takes at most one modal and one optional Neovim visit.
24. As the agent (model), I want deny decisions surfaced as tool_call blocks with reasons, so that I learn what was refused and why.
25. As the agent (model), I want an approved edit/write to execute with my exact input (or the user's Neovim-edited content), so that approved changes are applied faithfully.
26. As a maintainer, I want the preview modules (overlay, diff generation, verdict) deleted rather than deprecated, so the package carries no dead surface.
27. As a maintainer, I want bash and edit/write to share one modal-loop pattern (policy → prompt → optional Neovim → decision), so that behavior is predictable and documented once.
28. As a maintainer, I want the shared Neovim launch machinery, policy evaluation, and profile commands untouched by this change, so that the diff stays reviewable and risk stays in the deletions.
29. As a maintainer, I want tests that assert external behavior through the extension API seam only, so that internal refactors do not break the suite.
30. As a maintainer, I want the spec/ticket/ADR history around the deleted previews preserved as history, so that past decisions remain traceable even after the code is gone.
31. As a pi user, I want the README and context documentation to describe the reduced package accurately, so that future sessions and readers do not expect the deleted previews.

### Implementation Decisions

- **Scope is deletion, not redesign.** Permission policy/profile state and commands, the bash approval flow, and the shared Neovim launch utilities are unchanged except where verdict emission is removed.
- **Custom tool overrides for edit/write are removed.** The package stops re-registering write/edit tools; Pi's built-in tools render natively. The guard lives entirely in the tool_call event handler, which fires regardless of tool registration. Execution delegation disappears with the overrides.
- **The edit/write modal loop shrinks to three options:** Approve / Deny / Inspect-Edit in Neovim. The "Expand diff view" option and its overlay component are removed.
- **The Neovim round-trip contract is preserved:** the modal stays the final authority; an edit-in-Neovim approval loops back to the modal for confirmation; the (possibly edited) after-content is applied to the tool input on final approve (write: replaced content; edit: a single whole-file old/new edit pair when content changed). A Neovim deny is final.
- **Rendering fallback for non-diffable targets:** binary, unreadable, or unsafe-to-validate mutations skip Neovim and fall back to a plain text confirm (title + short reason). This replaces the previous three-way branch (binary confirm, unsafe-edit confirm, large-diff warning) — the large-diff warning and the pre-approval file-fingerprint re-check are removed outright.
- **Verdict lines are removed.** The shared verdict module and all of its call sites go away; approve/deny outcomes are conveyed by the standard tool result (success or block-with-reason). The model-facing hidden verdict message goes with it.
- **The before/after content for Neovim still comes from the file snapshot plus edit validation** — applying the edits array to produce after-content remains part of the Neovim flow, since it is what the diff is made of. Validation failure now means "no diff → plain confirm fallback", not an error card.
- **Re-entrancy stays:** while an edit/write approval loop is running, a second arriving mutation is denied immediately (same as bash's serialized queue semantics for its own flow).
- **The atomic-reveal rendering lifecycle (spec 0010 / ticket 0057 / ADR 0008) is superseded:** with the custom previews deleted there is no card to reveal atomically. Those documents remain as history.
- **Docs:** the package README's placeholder sections are filled in to describe the reduced package; the root context document's mutation-related entries (Approval Card glossary, package description) are updated. Historical spec/ticket/ADR files are left untouched.

### Testing Decisions

- **Good tests assert external behavior only:** dispatch a tool_call event, script the UI responses, and assert on block results, the exact options offered, notifications, and real file side effects — never on internals such as render caches, module state, or TUI component structure.
- **One primary seam, which already exists:** the extension-level API seam — a fake extension API capturing registered tools/commands and event handlers, a scripted UI context (select/confirm/notify), and a temp-dir cwd. Tests register the package, dispatch bash/edit/write events, and assert outcomes. Prior art: the existing extension-level wiring tests for bash approval and edit/write approval.
- **One existing satellite seam:** the Neovim launch utilities are mocked (command availability + process launch); a decision file written into a temp dir simulates the Neovim approve/deny/edit outcome. Prior art: the existing bash Neovim integration test.
- **Deleted tests:** everything tied to the removed surface — inline card rendering, atomic reveal, overlay, verdict emission, fingerprint re-check. Overlay's own test file is deleted with the module.
- **Retained coverage:** policy matrix (profiles/protected paths/dangerous commands), yolo bypass, /tmp bypass, subagent bypass, no-UI block, modal approve/deny, pending-mutation denial, Neovim round-trip approve/deny/edit for both bash and edit/write, and the no-UI guard.

### Out of Scope

- Any change to permission policy semantics (profiles, protected paths, dangerous-command classification).
- Any change to the bash approval flow beyond removing verdict emission.
- Changes to Neovim scripts/UX inside the existing Neovim approval flows (layout, keybindings, statuslines).
- Rewriting or deleting the historical spec 0010, ticket 0057, or ADR 0008 (they remain as history, superseded by this spec).
- Changes to any other extension (btw, deep-research, subagents, web-search) or to pi core.
- New preview capability of any kind — including a lighter "simple diff" card. If the user ever wants previews back, that is a new spec.

### Further Notes

- All decisions were locked in conversation this session: native previews restored, verdict lines dropped, auxiliary safety checks stripped, plain-text-confirm fallback for non-diffable targets, docs updated in-repo.
- ADR 0008 documents the atomic-reveal decision this spec supersedes; it is intentionally left in place as history.
- The permission-policy state bridge (env-based, because extensions load in isolated module contexts) is unchanged and out of scope, but is load-bearing for the guard — do not touch it while editing neighboring modules.
- Estimated net effect: ~1,400 lines removed; the package reduces to policy + profiles + bash guard + edit/write guard + shared Neovim machinery.