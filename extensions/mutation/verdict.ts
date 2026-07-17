/**
 * Mutation Verdict — shared approve/deny surfacing for all mutation approvals.
 *
 * Both the Bash approval flow and the edit/write diff approval flow emit their
 * verdict through this module so the user sees one consistent, persistent,
 * target-annotated line in the transcript:
 *
 *   ✓ approved — src/app.ts
 *   ✗ denied  — sudo rm -rf /tmp/x
 *
 * The verdict is sent as a custom message (`mutation-verdict`) and rendered by
 * the shared renderer registered here. Extensions are loaded in isolated
 * module contexts, so the renderer is registered once by the canonical
 * Mutation Package entrypoint (index.ts); the emitter is stateless and safe to
 * call from any extension context that has a reference to the ExtensionAPI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const MUTATION_VERDICT_CUSTOM_TYPE = "mutation-verdict";

export type Verdict = "approve" | "deny";

export interface VerdictDetails {
  verdict: "approved" | "denied";
  toolName: string;
  target: string;
}

/**
 * Emit an approve/deny verdict as a persistent custom message.
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
  pi.sendMessage({
    customType: MUTATION_VERDICT_CUSTOM_TYPE,
    content: verdict === "approve" ? "✓ approved" : "✗ denied",
    display: true,
    details: {
      verdict: verdict === "approve" ? "approved" : "denied",
      toolName,
      target,
    } satisfies VerdictDetails,
  });
}

/**
 * Register the shared verdict renderer. Call once from the canonical
 * Mutation Package entrypoint.
 */
export function registerMutationVerdictRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    MUTATION_VERDICT_CUSTOM_TYPE,
    (message, _options, theme) => {
      const details = message.details as VerdictDetails;
      const isApprove = details.verdict === "approved";
      const icon = isApprove ? "✓" : "✗";
      const word = isApprove ? "approved" : "denied";
      let text = theme.fg(isApprove ? "success" : "error", `${icon} ${word}`);
      if (details.target) {
        text += theme.fg("dim", ` — ${details.target}`);
      }
      const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    },
  );
}