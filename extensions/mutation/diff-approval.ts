/**
 * Diff Overlay — extension factory.
 *
 * Registers custom write/edit tools that delegate execution to Pi's built-ins
 * but replace native renderCall previews with compact diff approval cards.
 *
 * Tool calls are intercepted in tool_call and paused until the user picks an
 * option from a focus-grabbing ui.select modal (mirroring bash approval):
 *   Approve / Deny / Inspect/Edit in Neovim / Expand diff view
 * The entry line is disabled while the modal is open, so there is no risk of
 * an accidental A/D keystroke auto-accepting or denying. The inline renderCall
 * card is a read-only preview that accumulates the diff; the decision happens
 * only in the modal.
 *
 * Approve/deny verdicts are surfaced through the shared mutation-verdict
 * module (./verdict.ts) so bash and edit/write show one consistent,
 * target-annotated line in the transcript.
 */

import {
  createEditTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { evaluateConfirmation, getCurrentProfile } from "./permission-policy.js";
import { DiffOverlayComponent, type OverlayResult } from "./overlay-component.js";
import { generateCompactDiff } from "./diff-generation.js";
import { commandExists } from "./neovim-approval-utils.js";
import {
  runNeovimDiffApproval,
  readFileSnapshot,
  validateAndApplyEditPreview,
  type FileSnapshot,
  type UiContext,
} from "./neovim-diff-approval.js";
import { emitVerdict as emitMutationVerdict } from "./verdict.js";

// ── Approval state ──────────────────────────────────────────────────

interface PendingDiff {
  before: string;
  after: string;
  fileName: string;
  title: string;
  toolName?: "edit" | "write";
  toolInput?: Record<string, unknown>;
}

type ToolCallBlockResult = { block: true; reason: string } | undefined;

// ── Extension factory ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // True while a tool_call approval modal loop is running. A second mutation
  // arriving during approval is denied immediately (mirrors bash approval).
  let approvalInProgress = false;

  // Override write/edit rendering while delegating execution to Pi's built-ins.
  // A defined renderCall prevents ToolExecutionComponent from falling back to
  // the native preview; execute delegates so mutation behavior is preserved.
  const originalWrite = createWriteTool(process.cwd());
  pi.registerTool({
    name: "write",
    label: originalWrite.label,
    description: originalWrite.description,
    parameters: originalWrite.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tool = createWriteTool(ctx?.cwd ?? process.cwd());
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderMutationApprovalCard("write", args, theme, context);
    },
    renderResult(result, _options, theme, context) {
      return renderMutationResult(result, theme, context);
    },
  });

  const originalEdit = createEditTool(process.cwd());
  pi.registerTool({
    name: "edit",
    label: originalEdit.label,
    description: originalEdit.description,
    parameters: originalEdit.parameters,
    prepareArguments: originalEdit.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tool = createEditTool(ctx?.cwd ?? process.cwd());
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderMutationApprovalCard("edit", args, theme, context);
    },
    renderResult(result, _options, theme, context) {
      return renderMutationResult(result, theme, context);
    },
  });

  // Shared mutation-verdict emitter (see ./verdict.ts). Surfaced as a
  // persistent, target-annotated line in the transcript.
  function emit(verdict: "approve" | "deny", toolName: "edit" | "write", target: string): void {
    emitMutationVerdict(pi, verdict, toolName, target);
  }

  // ── Neovim editing ────────────────────────────────────────────────

  // Opens Neovim diff for the pending change. Returns the user's decision
  // and the (possibly edited) approved content. Does not resolve the tool
  // call — the caller's modal loop decides what to do next.
  async function openNeovimForDiff(
    ctx: UiContext,
    diff: PendingDiff,
  ): Promise<{ decision: "approve" | "deny"; approvedContent?: string }> {
    if (!commandExists("nvim")) {
      ctx.ui.notify("Neovim was not found; denying the change.", "warning");
      return { decision: "deny" };
    }

    const metadata: Array<[string, string]> = [
      ["Tool", diff.toolName ?? "edit"],
      ["File", diff.fileName],
    ];

    return runNeovimDiffApproval(ctx, {
      toolName: diff.toolName ?? "edit",
      targetPath: diff.fileName,
      beforeContent: diff.before,
      afterContent: diff.after,
      metadata,
    });
  }

  // ── Overlay opener ────────────────────────────────────────────────

  // Opens the full-screen scrolling diff overlay. Returns the user's choice:
  // approve / deny / edit_in_neovim / dismiss (shrink without deciding).
  async function openOverlay(
    ctx: ExtensionCommandContext,
    diff: PendingDiff,
  ): Promise<OverlayResult> {
    return ctx.ui.custom<OverlayResult>(
      (tui, theme, _kb, done) =>
        new DiffOverlayComponent(
          tui,
          theme,
          diff.title,
          diff.before,
          diff.after,
          diff.fileName,
          done,
        ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: "80%",
          margin: { bottom: 6 },
        },
      },
    );
  }

  async function approveToolCallWithDiffPreview(
    toolName: "edit" | "write",
    input: Record<string, unknown>,
    ctx: UiContext,
  ): Promise<boolean> {
    if (approvalInProgress) {
      emit("deny", toolName, getPath(input));
      return false;
    }

    const targetPath = getPath(input);
    const absolutePath = resolve(ctx.cwd, targetPath);
    const before = readFileSnapshot(absolutePath);
    const validation =
      toolName === "write"
        ? { ok: true, afterContent: getWriteContent(input) }
        : validateAndApplyEditPreview(before.content, input);
    const afterContent = validation.afterContent;
    const metadata = buildFileChangeMetadata(toolName, targetPath, before, afterContent, input);

    if (before.binary || before.unreadable || isLikelyBinaryText(afterContent)) {
      const ok = await ctx.ui.confirm(
        `Allow ${toolName} ${targetPath}?`,
        joinSections([
          "This file/change cannot be safely rendered as a text diff preview.",
          fieldBlock(metadata),
        ]),
      );
      emit(ok ? "approve" : "deny", toolName, targetPath);
      return ok;
    }

    if (!validation.ok) {
      const ok = await ctx.ui.confirm(
        `Unsafe edit preview: ${targetPath}`,
        joinSections([
          "The requested edit could not be previewed safely. Denial is recommended.",
          section("Validation", (validation.errors ?? []).join("\n")),
          fieldBlock(metadata),
          "Approve anyway without a diff preview?",
        ]),
      );
      emit(ok ? "approve" : "deny", toolName, targetPath);
      return ok;
    }

    const largeWarning = getLargeContentWarning(before.content, afterContent);
    if (largeWarning) {
      const ok = await ctx.ui.confirm(
        `Large diff: ${targetPath}`,
        joinSections([largeWarning, fieldBlock(metadata), "Continue to diff approval?"]),
      );
      if (!ok) {
        emit("deny", toolName, targetPath);
        return false;
      }
    }

    const title = `Pi Approval | ${toolName} | ${targetPath}`;
    const diff: PendingDiff = {
      before: before.content,
      after: afterContent,
      fileName: targetPath,
      title,
      toolName,
      toolInput: input,
    };

    // Track the editable after-content across Neovim editing rounds so an
    // approve after editing applies the edited content.
    let currentAfter = afterContent;

    approvalInProgress = true;
    try {
      // Modal loop — mirrors bash approval. The ui.select modal grabs focus,
      // disabling the entry line, so an accidental A/D keystroke cannot
      // auto-accept or deny. The inline renderCall card is only a preview.
      while (true) {
        const choice = await ctx.ui.select(`Allow ${toolName} ${targetPath}?`, [
          "Approve",
          "Deny",
          "Inspect/Edit in Neovim",
          "Expand diff view",
        ]);

        if (choice === "Approve") {
          const currentSnapshot = readFileSnapshot(absolutePath);
          if (currentSnapshot.fingerprint !== before.fingerprint) {
            ctx.ui.notify("File changed before approval — denying.", "warning");
            emit("deny", toolName, targetPath);
            return false;
          }
          applyApprovedContent(toolName, input, before, currentAfter);
          emit("approve", toolName, targetPath);
          return true;
        }

        if (choice === "Deny" || choice === undefined) {
          emit("deny", toolName, targetPath);
          return false;
        }

        if (choice === "Inspect/Edit in Neovim") {
          const result = await openNeovimForDiff(ctx, { ...diff, after: currentAfter });
          if (result.decision === "approve") {
            currentAfter = result.approvedContent ?? currentAfter;
            // Loop back to the modal so the user confirms from the focus-
            // grabbing prompt rather than auto-approving from Neovim.
            ctx.ui.notify("Edited in Neovim — confirm to approve.", "info");
            continue;
          }
          // Neovim deny is an explicit decision — deny outright.
          emit("deny", toolName, targetPath);
          return false;
        }

        if (choice === "Expand diff view") {
          const overlayResult = await openOverlay(
            ctx as unknown as ExtensionCommandContext,
            { ...diff, after: currentAfter },
          );
          if (overlayResult === "approve") {
            const currentSnapshot = readFileSnapshot(absolutePath);
            if (currentSnapshot.fingerprint !== before.fingerprint) {
              ctx.ui.notify("File changed before approval — denying.", "warning");
              emit("deny", toolName, targetPath);
              return false;
            }
            applyApprovedContent(toolName, input, before, currentAfter);
            emit("approve", toolName, targetPath);
            return true;
          }
          if (overlayResult === "deny") {
            emit("deny", toolName, targetPath);
            return false;
          }
          if (overlayResult === "edit_in_neovim") {
            const result = await openNeovimForDiff(ctx, { ...diff, after: currentAfter });
            if (result.decision === "approve") {
              currentAfter = result.approvedContent ?? currentAfter;
              ctx.ui.notify("Edited in Neovim — confirm to approve.", "info");
              continue;
            }
            // Neovim deny — deny outright.
            emit("deny", toolName, targetPath);
            return false;
          }
          // "dismiss" — shrink back to the inline card; loop to the modal.
          continue;
        }

        // Unknown choice — treat as deny.
        emit("deny", toolName, targetPath);
        return false;
      }
    } finally {
      approvalInProgress = false;
    }
  }

  pi.on("tool_call", async (event, ctx): Promise<ToolCallBlockResult> => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    if (!isRecord(event.input)) return { block: true, reason: `${event.toolName} input must be an object` };
    if (isTmpFileMutation(event.toolName, event.input, ctx.cwd)) {
      emit("approve", event.toolName, getPath(event.input));
      return undefined;
    }
    if (isSubagentChild()) return undefined;

    const confirmation = evaluateConfirmation(
      getCurrentProfile(),
      event.toolName,
      event.input,
    );
    if (confirmation.action === "block") return { block: true, reason: confirmation.reason };
    if (confirmation.action === "bypass") {
      emit("approve", event.toolName, getPath(event.input));
      return undefined;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${event.toolName} blocked: no UI available for diff-preview confirmation`,
      };
    }

    const approved = await approveToolCallWithDiffPreview(event.toolName, event.input, ctx);
    if (!approved) return { block: true, reason: "Blocked by user" };
    return undefined;
  });
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderMutationApprovalCard(
  toolName: "edit" | "write",
  args: unknown,
  theme: any,
  context: { cwd: string; state?: Record<string, unknown>; executionStarted?: boolean },
): Box {
  const input = isRecord(args) ? args : {};
  const cwd = context.cwd;
  const targetPath = getPath(input);
  const title = `Pi Approval | ${toolName} | ${targetPath}`;
  const cacheKey = `${toolName}:${cwd}:${stableStringify(input)}`;
  const state = context.state ?? {};
  const cached = state.mutationApprovalRender as
    | { key: string; lines: string[] }
    | undefined;

  if (cached?.key === cacheKey) {
    return renderApprovalBox(cached.lines, theme);
  }

  const lines: string[] = [];

  try {
    const before = readFileSnapshot(resolve(cwd, targetPath));
    const validation =
      toolName === "write"
        ? { ok: true, afterContent: getWriteContent(input) }
        : validateAndApplyEditPreview(before.content, input);

    if (before.binary || before.unreadable || isLikelyBinaryText(validation.afterContent)) {
      lines.push(theme.fg("accent", "✎ ") + theme.fg("toolTitle", `${toolName}  ${targetPath}`));
      lines.push("");
      lines.push(theme.fg("warning", "Text diff preview unavailable for this file/change."));
      lines.push(theme.fg("dim", "Use the confirmation prompt to approve or deny."));
      state.mutationApprovalRender = { key: cacheKey, lines };
      return renderApprovalBox(lines, theme);
    }

    if (!validation.ok) {
      lines.push(theme.fg("accent", "✎ ") + theme.fg("toolTitle", `${toolName}  ${targetPath}`));
      lines.push("");
      lines.push(theme.fg("error", "Unable to safely preview this edit."));
      for (const error of validation.errors ?? []) {
        lines.push(theme.fg("dim", `  ${error}`));
      }
      lines.push("");
      lines.push(renderApprovalHints(theme));
      state.mutationApprovalRender = { key: cacheKey, lines };
      return renderApprovalBox(lines, theme);
    }

    const summary = generateCompactDiff(before.content, validation.afterContent, targetPath, title);
    const hunkWord = summary.hunks.length === 1 ? "hunk" : "hunks";
    lines.push(
      theme.fg("accent", "✎ ") +
        theme.fg("toolTitle", `${toolName}  ${summary.fileName}`) +
        theme.fg(
          "dim",
          `  +${summary.additions} -${summary.deletions}  ${summary.hunks.length} ${hunkWord}`,
        ),
    );

    for (const hunk of summary.hunks) {
      lines.push("");
      lines.push(theme.fg("dim", `   @@ ${hunk.description || "(hunk)"}`));
      for (const hunkLine of hunk.lines) {
        const indent = "   ";
        if (hunkLine.startsWith("+")) {
          lines.push(theme.fg("success", indent + hunkLine));
        } else if (hunkLine.startsWith("-")) {
          lines.push(theme.fg("error", indent + hunkLine));
        } else if (hunkLine.startsWith(" ")) {
          lines.push(theme.fg("muted", indent + hunkLine));
        } else {
          lines.push(indent + hunkLine);
        }
      }
      if (hunk.truncated > 0) {
        const moreWord = hunk.truncated === 1 ? "line" : "lines";
        lines.push(theme.fg("dim", `   ... +${hunk.truncated} more ${moreWord} in this hunk`));
      }
    }
  } catch (error) {
    lines.push(theme.fg("accent", "✎ ") + theme.fg("toolTitle", `${toolName}  ${targetPath}`));
    lines.push("");
    lines.push(theme.fg("error", "Failed to render mutation preview."));
    lines.push(theme.fg("dim", error instanceof Error ? error.message : String(error)));
  }

  lines.push("");
  lines.push(renderApprovalHints(theme));
  state.mutationApprovalRender = { key: cacheKey, lines };
  return renderApprovalBox(lines, theme);
}

function renderMutationResult(
  result: { content: Array<{ type: string; text?: string }> },
  theme: any,
  context: { isError?: boolean },
): Container | Text {
  if (!context.isError) {
    return new Container();
  }

  const output = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
  return new Text(theme.fg("error", output || "Tool failed"), 0, 0);
}

function renderApprovalHints(theme: any): string {
  return theme.fg("dim", "Diff preview — a prompt will appear for Approve / Deny / Inspect/Edit in Neovim / Expand diff view");
}

function renderApprovalBox(lines: string[], theme: any): Box {
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
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

function getPath(input: Record<string, unknown>): string {
  return typeof input.path === "string" && input.path.trim()
    ? input.path
    : "unknown-file.txt";
}

function getWriteContent(input: Record<string, unknown>): string {
  return typeof input.content === "string" ? input.content : "";
}

function buildFileChangeMetadata(
  toolName: "edit" | "write",
  targetPath: string,
  before: FileSnapshot,
  afterContent: string,
  input: Record<string, unknown>,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Tool", toolName],
    ["File", targetPath],
    ["Before", summarizeTextSize(before.content)],
    ["After", summarizeTextSize(afterContent)],
  ];

  if (toolName === "write") {
    rows.push(["Workflow", before.exists ? "overwrite existing file" : "new file"]);
  } else {
    rows.push(["Edit blocks", String(Array.isArray(input.edits) ? input.edits.length : 0)]);
  }

  if (before.binary) rows.push(["Existing file", "binary-like"]);
  if (before.unreadable) rows.push(["Existing file", "unreadable"]);
  return rows;
}

function summarizeTextSize(text: string): string {
  return `${countLines(text)} line(s), ${formatBytes(byteLength(text))}`;
}

function getLargeContentWarning(beforeContent: string, afterContent: string): string | null {
  const bytes = Math.max(byteLength(beforeContent), byteLength(afterContent));
  const lines = Math.max(countLines(beforeContent), countLines(afterContent));
  const warnings: string[] = [];
  if (bytes > 1_000_000) warnings.push(formatBytes(bytes));
  if (lines > 20_000) warnings.push(`${lines.toLocaleString()} lines`);
  return warnings.length ? `Large diff: ${warnings.join(" / ")}.` : null;
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

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function countLines(text: string): number {
  return text.length ? splitLines(text).length : 0;
}

function isLikelyBinaryText(text: string): boolean {
  return text.includes("\0");
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte(s)`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function fieldBlock(fields: Array<[string, string]>): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields.map(([label, value]) => `${label.padEnd(width)} : ${value}`).join("\n");
}

function section(title: string, body: string): string {
  return `── ${title} ──\n${body}`;
}

function joinSections(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}