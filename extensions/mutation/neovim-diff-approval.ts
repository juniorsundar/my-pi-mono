/**
 * Neovim Diff Approval — shared module
 *
 * Extracted from the legacy confirm-mutating-tools flow. Provides the Neovim diff approval
 * flow for file changes: opens `nvim -d before after` with `:Approve`/`:Deny`
 * commands, smart layout (side-by-side / horizontal), and tmux integration.
 *
 * Used by the mutation diff-preview flow (and its /diff-preview prototype
 * commands) as the edit-in-Neovim escape hatch.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  runNeovimWithArgsProcess,
  safePreviewBasename,
} from "./neovim-approval-utils.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface FileSnapshot {
  content: string;
  exists: boolean;
  binary: boolean;
  unreadable: boolean;
  fingerprint: string;
  sizeBytes: number;
  mtimeMs: number | null;
}

export interface EditValidation {
  ok: boolean;
  afterContent: string;
  errors?: string[];
}

export interface NeovimApprovalResult {
  decision: "approve" | "deny";
  approvedContent?: string;
}

export interface UiContext {
  cwd: string;
  ui: {
    confirm: (title: string, body: string) => Promise<boolean>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    custom: <T>(
      factory: (tui: any, theme: any, kb: any, done: (value: T) => void) => any,
    ) => Promise<T>;
  };
}

// ── Core functions ────────────────────────────────────────────────────

/**
 * Open Neovim in diff mode with before/after files. Returns the user's
 * decision and the (possibly edited) approved content.
 *
 * The caller is responsible for:
 * - Creating temp files / cleanup (this function handles that)
 * - Calling this inside a `ctx.ui.custom()` block (it suspends the TUI)
 * - Interpreting the result and mutating tool input if needed
 */
export async function runNeovimDiffApproval(
  ctx: UiContext,
  request: {
    toolName: "edit" | "write";
    targetPath: string;
    beforeContent: string;
    afterContent: string;
    metadata: Array<[string, string]>;
  },
): Promise<NeovimApprovalResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-nvim-approval-"));
  const fileName = safePreviewBasename(request.targetPath);
  const beforePath = join(tempDir, `before.${fileName}`);
  const afterPath = join(tempDir, `after.${fileName}`);
  const decisionPath = join(tempDir, "decision.txt");
  const approvalPath = join(tempDir, "approval.lua");

  writeFileSync(beforePath, request.beforeContent, "utf8");
  writeFileSync(afterPath, request.afterContent, "utf8");
  writeFileSync(decisionPath, "deny\n", "utf8");
  writeFileSync(
    approvalPath,
    buildApprovalLua(decisionPath, beforePath, afterPath, request),
    "utf8",
  );

  try {
    await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");

      const result = runNeovimApprovalProcess(
        tempDir,
        beforePath,
        afterPath,
        approvalPath,
        request.targetPath,
      );

      tui.start();
      tui.requestRender(true);
      done(result.status);

      return { render: () => [], invalidate: () => {} };
    });

    const decision =
      readFileSync(decisionPath, "utf8").trim() === "approve"
        ? "approve"
        : "deny";
    const approvedContent =
      decision === "approve" ? readFileSync(afterPath, "utf8") : undefined;
    return { decision, approvedContent };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── File snapshot ─────────────────────────────────────────────────────

export function readFileSnapshot(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return {
      content: "",
      exists: false,
      binary: false,
      unreadable: false,
      fingerprint: "missing",
      sizeBytes: 0,
      mtimeMs: null,
    };
  }

  try {
    const stat = statSync(path);
    const buffer = readFileSync(path);
    const binary = isLikelyBinaryBuffer(buffer);
    const content = binary
      ? "<binary file omitted>\n"
      : buffer.toString("utf8");
    return {
      content,
      exists: true,
      binary,
      unreadable: false,
      fingerprint: `${stat.size}:${stat.mtimeMs}:${hashBuffer(buffer)}`,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return {
      content: "<unable to read existing file as utf8>\n",
      exists: true,
      binary: false,
      unreadable: true,
      fingerprint: "unreadable",
      sizeBytes: 0,
      mtimeMs: null,
    };
  }
}

// ── Edit preview ──────────────────────────────────────────────────────

/**
 * Apply the edits[] array from an edit tool call to produce the after-content.
 * Returns ok: true if all edits matched exactly once, ok: false with errors
 * if any edit block failed validation.
 */
export function validateAndApplyEditPreview(
  beforeContent: string,
  input: Record<string, unknown>,
): EditValidation {
  const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
  let preview = beforeContent;
  const errors: string[] = [];

  edits.forEach((edit, index) => {
    const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
    const newText = typeof edit.newText === "string" ? edit.newText : "";
    if (!oldText) {
      errors.push(`Edit ${index + 1}: oldText is empty or missing.`);
      return;
    }

    const matches = countOccurrences(preview, oldText);
    if (matches !== 1) {
      errors.push(
        `Edit ${index + 1}: oldText matched ${matches} time(s), expected exactly 1.`,
      );
      return;
    }

    preview = preview.replace(oldText, newText);
  });

  return errors.length
    ? { ok: false, afterContent: preview, errors }
    : { ok: true, afterContent: preview };
}

// ── Nvim process management ───────────────────────────────────────────

function runNeovimApprovalProcess(
  tempDir: string,
  beforePath: string,
  afterPath: string,
  approvalPath: string,
  targetPath: string,
): { status: number | null } {
  return runNeovimWithArgsProcess({
    tempDir,
    nvimArgs: ["-d", beforePath, afterPath, "-c", `luafile ${approvalPath}`],
    targetPath,
    windowTitlePrefix: "pi diff",
  });
}

// ── Lua script builder ────────────────────────────────────────────────

function buildApprovalLua(
  decisionPath: string,
  beforePath: string,
  afterPath: string,
  request: {
    toolName: "edit" | "write";
    targetPath: string;
    metadata: Array<[string, string]>;
  },
): string {
  const escapedDecisionPath = JSON.stringify(decisionPath);
  const escapedBeforePath = JSON.stringify(beforePath);
  const escapedAfterPath = JSON.stringify(afterPath);
  const editableAfter = true;
  const statusText = `Pi Approval | ${request.toolName} | ${request.targetPath}`;
  const escapedStatus = JSON.stringify(statusText);
  const escapedToolName = JSON.stringify(request.toolName);
  const escapedTargetPath = JSON.stringify(request.targetPath);
  const escapedEcho = JSON.stringify(
    `${statusText} | ${request.metadata.map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
  );
  return `
vim.opt.number = true
vim.opt.relativenumber = false
vim.opt.cursorline = true
vim.opt.wrap = false
vim.opt.termguicolors = true
vim.opt.scrolloff = 1
vim.g.micro_statusline = false
-- Avoid narrow-terminal hit-enter prompts from long status/messages while the
-- diff UI is still settling.
pcall(function() vim.opt.shortmess:append('T') end)
vim.opt.more = false
pcall(function() vim.opt.diffopt:append('algorithm:histogram') end)
pcall(function() vim.opt.diffopt:append('indent-heuristic') end)

-- Loaded after the user's normal Neovim config so their theme is preserved.
local decision_file = ${escapedDecisionPath}
local before_file = ${escapedBeforePath}
local after_file = ${escapedAfterPath}
local editable_after = ${editableAfter ? "true" : "false"}
local status_text = ${escapedStatus}
local tool_name = ${escapedToolName}
local target_path = ${escapedTargetPath}
local echo_text = ${escapedEcho}
local display_text = status_text:gsub('%%', '%%%%')
vim.api.nvim_set_hl(0, 'PiApprovalBefore', { bg = '#ffd6d6', fg = '#202020', bold = true })
vim.api.nvim_set_hl(0, 'PiApprovalAfter', { bg = '#d6ffd6', fg = '#202020', bold = true })
local function set_window_label(win, access, highlight)
  local label_text = (' Pi Approval | %s [%s] | %s '):format(tool_name, access, target_path):gsub('%%', '%%%%')
  local text = ('%%#%s#%s%%*'):format(highlight, label_text)
  pcall(function() vim.api.nvim_win_set_option(win, 'statusline', text) end)
end
local function label_diff_windows()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))
    if name == before_file then
      set_window_label(win, 'RO', 'PiApprovalBefore')
    elseif name == after_file then
      set_window_label(win, editable_after and 'W' or 'RO', 'PiApprovalAfter')
    end
  end
end
local function focus_before_buffer()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local bufnr = vim.api.nvim_win_get_buf(win)
    if vim.api.nvim_buf_get_name(bufnr) == before_file then
      vim.api.nvim_set_current_win(win)
      return win, bufnr
    end
  end
  return nil, nil
end
local function focus_after_buffer()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local bufnr = vim.api.nvim_win_get_buf(win)
    if vim.api.nvim_buf_get_name(bufnr) == after_file then
      vim.api.nvim_set_current_win(win)
      return win, bufnr
    end
  end
  return nil, nil
end
local function decide(value)
  if value == 'approve' and editable_after then
    pcall(function()
      for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_get_name(bufnr) == after_file then
          vim.api.nvim_buf_call(bufnr, function()
            vim.cmd('silent write')
          end)
          break
        end
      end
    end)
  end
  vim.fn.writefile({ value }, decision_file)
  vim.cmd('qa!')
end

vim.api.nvim_create_user_command('Approve', function() decide('approve') end, {})
vim.api.nvim_create_user_command('Deny', function() decide('deny') end, {})
vim.api.nvim_set_keymap('n', '<leader><leader>A', ':Approve<CR>', { noremap = true, silent = true })
vim.api.nvim_set_keymap('n', '<leader><leader>D', ':Deny<CR>', { noremap = true, silent = true })

local function apply_smart_layout()
  -- Prefer side-by-side diffs when there is enough width, but rotate to a
  -- horizontal/top-bottom diff in narrow terminals or tmux panes.
  local columns = vim.o.columns
  local lines = vim.o.lines
  local use_vertical = columns >= 120 or (columns >= 100 and lines < 32)
  -- Ensure conventional diff order: before/original on the left or top,
  -- after/modified on the right or bottom. Neovim's current window after
  -- nvim -d before after can be the after buffer, so moving the current
  -- window directly may invert the layout.
  focus_before_buffer()
  if use_vertical then
    pcall(function() vim.cmd('wincmd H') end)
  else
    pcall(function() vim.cmd('wincmd K') end)
  end
  vim.cmd('wincmd =')
  return use_vertical and 'vertical' or 'horizontal'
end

vim.defer_fn(function()
  vim.opt.laststatus = 2
  vim.opt.statusline = display_text
  local layout = apply_smart_layout()
  label_diff_windows()
  vim.cmd('windo setlocal readonly nomodifiable nowrap')
  local after_win = focus_after_buffer()
  if editable_after and after_win then
    vim.api.nvim_win_call(after_win, function()
      vim.cmd('setlocal noreadonly modifiable')
    end)
  end
  vim.cmd('windo diffthis')
  vim.cmd('wincmd =')
  label_diff_windows()
  focus_after_buffer()
  pcall(function() vim.cmd('normal! ]c') end)
  vim.api.nvim_echo({{ 'Pi Approval: :Approve or :Deny | layout: ' .. layout, 'None' }}, false, {})
end, 100)
`;
}

// ── Text utilities ────────────────────────────────────────────────────

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count++;
    index += needle.length;
  }
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
