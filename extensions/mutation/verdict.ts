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
 * The verdict is sent as a hidden custom message so the model knows the
 * decision without adding visual noise — the tool execution highlight
 * already communicates the outcome to the user.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MUTATION_VERDICT_CUSTOM_TYPE = "mutation-verdict";

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

  // Send the verdict to model context only; the tool execution highlight
  // already communicates the outcome visually.
  pi.sendMessage({
    customType: MUTATION_VERDICT_CUSTOM_TYPE,
    content: `User ${decision} the ${toolName} tool call: ${target}`,
    display: false,
    details,
  });
}


