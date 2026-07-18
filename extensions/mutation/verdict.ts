/**
 * Mutation Verdict — shared approve/deny surfacing for all mutation approvals.
 *
 * Both the Bash approval flow and the edit/write diff approval flow emit their
 * verdict through this module so both the model and the user see one
 * consistent, persistent, target-annotated decision in the transcript. The
 * model-facing message is explicit:
 *
 *   User approved the edit tool call: src/app.ts
 *   User denied the bash tool call: sudo rm -rf /tmp/x
 *
 * A custom entry renders the compact visual form (`✓ approved — target`)
 * immediately, while a hidden custom message carries the decision into model
 * context. Keeping these paths separate avoids pi's streaming-message queue
 * delaying later verdicts in a batch until subsequent UI activity.
 *
 * Extensions are loaded in isolated module contexts, so the renderers are
 * registered once by the canonical Mutation Package entrypoint (index.ts);
 * the emitter is stateless and safe to call from any extension context that
 * has a reference to the ExtensionAPI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const MUTATION_VERDICT_CUSTOM_TYPE = "mutation-verdict";
export const MUTATION_VERDICT_DISPLAY_CUSTOM_TYPE = "mutation-verdict-display";

export type Verdict = "approve" | "deny";

export interface VerdictDetails {
  verdict: "approved" | "denied";
  toolName: string;
  target: string;
}

/**
 * Emit an approve/deny verdict to model context and the visible transcript.
 *
 * `target` is the command (for bash) or the file path (for edit/write). The
 * caller is responsible for providing a short, human-readable target.
 */
export function emitVerdict(
  pi: ExtensionAPI,
  verdict: Verdict,
  toolName: string,
  target: string,
): void {
  const decision = verdict === "approve" ? "approved" : "denied";
  const details = {
    verdict: decision,
    toolName,
    target,
  } satisfies VerdictDetails;

  // Preserve model context first. The message is deliberately hidden from the
  // TUI: pi queues streaming custom messages as steering messages, which can
  // make a batch of verdicts appear one at a time only after later UI activity.
  pi.sendMessage({
    customType: MUTATION_VERDICT_CUSTOM_TYPE,
    content: `User ${decision} the ${toolName} tool call: ${target}`,
    display: false,
    details,
  });

  // appendEntry emits an entry_appended event immediately, even while the
  // agent is streaming, so every verdict in a batch is rendered at decision
  // time instead of waiting for the steering-message queue to drain.
  pi.appendEntry(MUTATION_VERDICT_DISPLAY_CUSTOM_TYPE, details);
}

/**
 * Register the shared verdict renderers. Call once from the canonical
 * Mutation Package entrypoint.
 */
export function registerMutationVerdictRenderer(pi: ExtensionAPI): void {
  const render = (details: VerdictDetails | undefined, theme: any) => {
    const approved = details?.verdict === "approved";
    const marker = approved ? "✓" : "✗";
    const verdict = approved ? "approved" : "denied";
    const target = details?.target ? ` — ${details.target}` : "";
    const color = approved ? "success" : "error";

    const box = new Box(0, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      new Text(
        theme.fg(color, `${marker} ${verdict}`) + theme.fg("dim", target),
      ),
    );
    return box;
  };

  // Retain the message renderer for existing sessions created before verdict
  // display moved to immediate custom entries.
  pi.registerMessageRenderer(
    MUTATION_VERDICT_CUSTOM_TYPE,
    (message, _options, theme) =>
      render(message.details as VerdictDetails | undefined, theme),
  );
  pi.registerEntryRenderer(
    MUTATION_VERDICT_DISPLAY_CUSTOM_TYPE,
    (entry, _options, theme) =>
      render(entry.data as VerdictDetails | undefined, theme),
  );
}
