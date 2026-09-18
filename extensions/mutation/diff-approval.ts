/**
 * Edit/Write Guard — extension module.
 *
 * Intercepts edit/write tool calls in tool_call and pauses until the user
 * picks an option from a focus-grabbing ui.select modal (mirroring bash
 * approval):
 *   Approve / Deny / Inspect-Edit in Neovim
 * Pi's native tool previews render inline; the decision happens only in the
 * modal. Targets that cannot be rendered as a text diff (binary, unreadable,
 * unsafe edit validation) skip Neovim and fall back to a plain text confirm.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { evaluateConfirmation, getCurrentProfile } from "./permission-policy.js";
import { commandExists } from "./neovim-approval-utils.js";
import {
  runNeovimDiffApproval,
  readFileSnapshot,
  validateAndApplyEditPreview,
  type FileSnapshot,
  type UiContext,
} from "./neovim-diff-approval.js";

type ToolCallBlockResult = { block: true; reason: string } | undefined;

export default function (pi: ExtensionAPI) {
  // True while a tool_call approval modal loop is running. A second mutation
  // arriving during approval is denied immediately (mirrors bash approval).
  let approvalInProgress = false;

  // Opens Neovim diff for the pending change. Returns the user's decision
  // and the (possibly edited) approved content. Does not resolve the tool
  // call — the caller's modal loop decides what to do next.
  async function openNeovimForDiff(
    ctx: UiContext,
    toolName: "edit" | "write",
    targetPath: string,
    before: string,
    after: string,
  ): Promise<{ decision: "approve" | "deny"; approvedContent?: string }> {
    const metadata: Array<[string, string]> = [
      ["Tool", toolName],
      ["File", targetPath],
    ];

    return runNeovimDiffApproval(ctx, {
      toolName,
      targetPath,
      beforeContent: before,
      afterContent: after,
      metadata,
    });
  }

  // Plain text confirm for targets that cannot be previewed as a diff
  // (binary, unreadable, unsafe edit validation, missing Neovim).
  async function plainConfirm(
    toolName: "edit" | "write",
    targetPath: string,
    reason: string,
    ctx: UiContext,
  ): Promise<boolean> {
    return ctx.ui.confirm(
      `Allow ${toolName} ${targetPath}?`,
      `${reason}\nDiff preview is unavailable for this change.`,
    );
  }

  async function approveToolCall(
    toolName: "edit" | "write",
    input: Record<string, unknown>,
    ctx: UiContext,
  ): Promise<boolean> {
    if (approvalInProgress) return false;

    approvalInProgress = true;
    try {
      const targetPath = getPath(input);
      const absolutePath = resolve(ctx.cwd, targetPath);
      const before = readFileSnapshot(absolutePath);
      const validation =
        toolName === "write"
          ? { ok: true, afterContent: getWriteContent(input) }
          : validateAndApplyEditPreview(before.content, input);
      const afterContent = validation.afterContent;

      // Non-diffable targets skip Neovim entirely. `return await` keeps the
      // approval held (finally must not run while the confirm is pending).
      if (before.binary || before.unreadable || isLikelyBinaryText(afterContent)) {
        return await plainConfirm(
          toolName,
          targetPath,
          "This file/change cannot be rendered as a text diff preview.",
          ctx,
        );
      }
      if (!validation.ok) {
        return await plainConfirm(
          toolName,
          targetPath,
          "The requested edit could not be previewed safely.",
          ctx,
        );
      }

      // Track the editable after-content across Neovim editing rounds so an
      // approve after editing applies the edited content.
      let currentAfter = afterContent;

      // Modal loop — mirrors bash approval. The ui.select modal grabs focus,
      // disabling the entry line, so an accidental A/D keystroke cannot
      // auto-accept or deny.
      while (true) {
        const choice = await ctx.ui.select(`Allow ${toolName} ${targetPath}?`, [
          "Approve",
          "Deny",
          "Inspect-Edit in Neovim",
        ]);

        if (choice === "Approve") {
          applyApprovedContent(toolName, input, before, currentAfter);
          return true;
        }

        if (choice === "Deny" || choice === undefined) {
          return false;
        }

        if (choice === "Inspect-Edit in Neovim") {
          if (!commandExists("nvim")) {
            ctx.ui.notify("Neovim was not found; falling back to a plain confirm.", "warning");
            return await plainConfirm(
              toolName,
              targetPath,
              "Neovim is not available for inspection.",
              ctx,
            );
          }

          const result = await openNeovimForDiff(
            ctx,
            toolName,
            targetPath,
            before.content,
            currentAfter,
          );
          if (result.decision === "approve") {
            currentAfter = result.approvedContent ?? currentAfter;
            // Loop back to the modal so the user confirms from the focus-
            // grabbing prompt rather than auto-approving from Neovim.
            ctx.ui.notify("Edited in Neovim — confirm to approve.", "info");
            continue;
          }
          // Neovim deny is an explicit decision — deny outright.
          return false;
        }

        // Unknown choice — treat as deny.
        return false;
      }
    } finally {
      approvalInProgress = false;
    }
  }

  pi.on("tool_call", async (event, ctx): Promise<ToolCallBlockResult> => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    if (!isRecord(event.input)) return { block: true, reason: `${event.toolName} input must be an object` };
    if (isTmpFileMutation(event.toolName, event.input, ctx.cwd)) return undefined;
    if (isSubagentChild()) return undefined;

    const confirmation = evaluateConfirmation(
      getCurrentProfile(),
      event.toolName,
      event.input,
    );
    if (confirmation.action === "block") return { block: true, reason: confirmation.reason };
    if (confirmation.action === "bypass") return undefined;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${event.toolName} blocked: no UI available for confirmation`,
      };
    }

    const approved = await approveToolCall(event.toolName, event.input, ctx);
    if (!approved) return { block: true, reason: "Blocked by user" };
    return undefined;
  });
}

function getPath(input: Record<string, unknown>): string {
  return typeof input.path === "string" && input.path.trim()
    ? input.path
    : "unknown-file.txt";
}

function getWriteContent(input: Record<string, unknown>): string {
  return typeof input.content === "string" ? input.content : "";
}

function applyApprovedContent(
  toolName: "edit" | "write",
  input: Record<string, unknown>,
  before: FileSnapshot,
  approvedContent: string,
): void {
  if (toolName === "write") {
    input.content = approvedContent;
    return;
  }

  if (approvedContent !== before.content && before.content.length > 0) {
    input.edits = [
      { oldText: before.content, newText: approvedContent },
    ];
  }
}

function isTmpFileMutation(toolName: string, input: unknown, cwd: string): boolean {
  if (toolName !== "edit" && toolName !== "write") return false;
  if (!isRecord(input)) return false;
  const absolutePath = resolve(cwd, getPath(input));
  return absolutePath === "/tmp" || absolutePath.startsWith("/tmp/");
}

function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

function isLikelyBinaryText(text: string): boolean {
  return text.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}