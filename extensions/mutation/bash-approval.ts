import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  commandExists,
  runNeovimWithArgsProcess,
  shellQuote,
} from "./neovim-approval-utils.js";
import { evaluateConfirmation, getCurrentProfile } from "./permission-policy.js";
import { emitVerdict } from "./verdict.js";

type PermissionRequest = {
  title: string;
  body: string;
};

type UiContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    confirm: (title: string, body: string) => Promise<boolean>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    custom: <T>(
      factory: (tui: any, theme: any, kb: any, done: (value: T) => void) => any,
    ) => Promise<T>;
  };
};

type BashNeovimApprovalResult = {
  decision: "approve" | "deny" | "undecided";
  approvedCommand?: string;
};

const BASH_COMMAND_MARKER =
  "# --- Command below this line will run when approved ---";

let approvalQueue: Promise<unknown> = Promise.resolve();

export default function registerBashApproval(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    if (isSubagentChild()) return undefined;

    const confirmation = evaluateConfirmation(
      getCurrentProfile(),
      event.toolName,
      event.input,
    );
    if (confirmation.action === "block") {
      return { block: true, reason: confirmation.reason };
    }
    if (confirmation.action === "bypass") {
      return undefined;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${event.toolName} blocked: no UI available for confirmation`,
      };
    }

    return enqueueApproval(async () => {
      const approved = await approveBashCommand(pi, event.input, ctx);
      if (!approved) return { block: true, reason: "Blocked by user" };
      return undefined;
    });
  });
}

function enqueueApproval<T>(task: () => Promise<T>): Promise<T> {
  const run = approvalQueue.then(task, task);
  approvalQueue = run.catch(() => undefined);
  return run;
}

async function approveBashCommand(
  pi: ExtensionAPI,
  input: unknown,
  ctx: UiContext,
): Promise<boolean> {
  const target = bashTarget(input);
  while (true) {
    const request = formatBashPermissionRequest("bash", input);
    const choice = await ctx.ui.select(request.title, [
      "Approve",
      "Deny",
      "Inspect/Edit in Neovim",
    ]);

    if (choice === "Approve") {
      emitVerdict(pi, "approve", "bash", target);
      return true;
    }

    if (choice === "Inspect/Edit in Neovim") {
      if (!commandExists("nvim")) {
        ctx.ui.notify("Neovim was not found; denying bash command.", "warning");
        emitVerdict(pi, "deny", "bash", target);
        return false;
      }

      const result = await runNeovimBashApproval(ctx, input);
      if (result.decision === "approve") {
        if (typeof result.approvedCommand === "string" && isRecord(input)) {
          const originalCommand = String(input.command ?? "");
          input.command =
            result.approvedCommand === originalCommand
              ? result.approvedCommand
              : withEditedBashCommandAudit(
                  originalCommand,
                  result.approvedCommand,
                );
        }
        emitVerdict(pi, "approve", "bash", bashTarget(input));
        return true;
      }
      if (result.decision === "deny") {
        emitVerdict(pi, "deny", "bash", target);
        return false;
      }

      ctx.ui.notify(
        "No Neovim decision; returning to bash approval prompt.",
        "warning",
      );
      continue;
    }

    emitVerdict(pi, "deny", "bash", target);
    return false;
  }
}

async function runNeovimBashApproval(
  ctx: UiContext,
  input: unknown,
): Promise<BashNeovimApprovalResult> {
  const command = isRecord(input) ? String(input.command ?? "") : "";
  const metadata: Array<[string, string]> = isRecord(input)
    ? buildBashMetadata(input, command)
    : [["Tool", "bash"]];
  const tempDir = mkdtempSync(join(tmpdir(), "pi-bash-approval-"));
  const scriptPath = join(tempDir, "command.sh");
  const decisionPath = join(tempDir, "decision.txt");
  const approvalPath = join(tempDir, "approval.lua");

  try {
    writeFileSync(
      scriptPath,
      buildBashInspectionScript(command, metadata),
      "utf8",
    );
    writeFileSync(decisionPath, "undecided\n", "utf8");
    writeFileSync(
      approvalPath,
      buildBashApprovalLua(decisionPath, scriptPath),
      "utf8",
    );

    await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");

      const result = runNeovimCommandApprovalProcess(
        tempDir,
        scriptPath,
        approvalPath,
      );

      tui.start();
      tui.requestRender(true);
      done(result.status);

      if (result.status !== 0) {
        ctx.ui.notify("Neovim exited without approval.", "warning");
      }

      return { render: () => [], invalidate: () => {} };
    });

    const decision = readTrimmedFile(decisionPath);
    if (decision === "approve") {
      return {
        decision,
        approvedCommand: extractCommandFromBashApprovalScript(
          readFileSync(scriptPath, "utf8"),
        ),
      };
    }
    if (decision === "deny") return { decision };
    return { decision: "undecided" };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildBashInspectionScript(
  command: string,
  metadata: Array<[string, string]>,
): string {
  return [
    "#!/usr/bin/env bash",
    "",
    "# Pi bash approval",
    "# Edit the command below, then approve to run the edited version.",
    ...metadata.map(([label, value]) => `# ${label}: ${value}`),
    "",
    BASH_COMMAND_MARKER,
    command || "",
    "",
  ].join("\n");
}

function extractCommandFromBashApprovalScript(script: string): string {
  const markerIndex = script.indexOf(BASH_COMMAND_MARKER);
  if (markerIndex === -1) return script.trim();

  const body = script.slice(markerIndex + BASH_COMMAND_MARKER.length);
  return body.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

function buildBashApprovalLua(
  decisionPath: string,
  scriptPath: string,
): string {
  return `
local decision_file = ${JSON.stringify(decisionPath)}
local script_file = ${JSON.stringify(scriptPath)}

vim.opt.number = true
vim.opt.relativenumber = false
vim.opt.statusline = ' Pi Approval | edit bash command | :Approve or :Deny '

local function finish(value)
  if value == 'approve' then
    pcall(function()
      vim.cmd('silent write')
    end)
  end
  vim.fn.writefile({ value }, decision_file)
  vim.cmd('qa!')
end

vim.api.nvim_create_user_command('Approve', function()
  finish('approve')
end, {})

vim.api.nvim_create_user_command('Deny', function()
  finish('deny')
end, {})

vim.keymap.set('n', '<Esc>', function() finish('deny') end, { noremap = true, silent = true })
vim.keymap.set('n', '<leader><leader>A', '<Cmd>Approve<CR>', { noremap = true, silent = true })
vim.keymap.set('n', '<leader><leader>D', '<Cmd>Deny<CR>', { noremap = true, silent = true })

vim.cmd('edit ' .. vim.fn.fnameescape(script_file))
vim.api.nvim_echo({{ 'Pi Approval: edit bash command if needed, then :Approve or :Deny (or <leader><leader>A / <leader><leader>D)', 'None' }}, false, {})
`;
}

function runNeovimCommandApprovalProcess(
  tempDir: string,
  scriptPath: string,
  approvalPath: string,
): { status: number | null } {
  return runNeovimWithArgsProcess({
    tempDir,
    nvimArgs: [scriptPath, "-c", `luafile ${approvalPath}`],
    targetPath: "bash command",
    windowTitlePrefix: "pi bash",
  });
}

function formatBashPermissionRequest(
  toolName: string,
  input: unknown,
): PermissionRequest {
  if (toolName !== "bash" || !isRecord(input)) {
    return {
      title: `Allow ${toolName}?`,
      body: section("Raw input", truncate(JSON.stringify(input, null, 2))),
    };
  }

  const command = String(input.command ?? "").trim();
  const metadata = buildBashMetadata(input, command);

  return {
    title: `${detectBashRisks(command).length ? "⚠️" : "🛠️"} Allow shell command?`,
    body: joinSections([
      fieldBlock(metadata),
      section("Command preview", previewBashCommand(command)),
    ]),
  };
}

function withEditedBashCommandAudit(
  originalCommand: string,
  modifiedCommand: string,
): string {
  return [
    "{",
    "  printf '%s\\n' '--- Pi approval audit: bash command edited before execution ---'",
    "  printf '%s\\n' 'Original command:'",
    `  printf '%s\\n' ${shellQuote(originalCommand)}`,
    "  printf '%s\\n' 'Modified command:'",
    `  printf '%s\\n' ${shellQuote(modifiedCommand)}`,
    "  printf '%s\\n' '--- Pi approval audit: running modified command ---'",
    "} >&2",
    modifiedCommand,
  ].join("\n");
}

function buildBashMetadata(
  input: Record<string, unknown>,
  command: string,
): Array<[string, string]> {
  const risks = detectBashRisks(command);
  const timeout =
    typeof input.timeout === "number" ? `${input.timeout}s` : "default";
  const cwd =
    typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : ".";
  const lines = countLines(command);
  const bytes = byteLength(command);
  const chars = command.length;

  return [
    ["Tool", "bash"],
    [
      "Risk",
      risks.length ? risks.join(", ") : "Low / no obvious risky pattern",
    ],
    ["Timeout", timeout],
    ["Cwd", cwd],
    ["Length", `${chars.toLocaleString()} char(s), ${formatBytes(bytes)}`],
    ["Lines", lines.toLocaleString()],
    ["SHA-256", hashText(command)],
  ];
}

function previewBashCommand(command: string): string {
  const source = command || "<empty command>";
  const wrapped = wrapLines(source, 120);
  const lines = wrapped.split("\n");
  const clippedLines = lines.slice(0, 30);
  let preview = clippedLines.join("\n");

  if (preview.length > 1200) {
    preview = preview.slice(0, 1200);
  }

  const truncated =
    lines.length > clippedLines.length || preview.length < wrapped.length;
  return truncated
    ? `${preview}\n\n… truncated; choose Inspect in Neovim for full command …`
    : preview;
}

function wrapLines(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => wrapLine(line, width))
    .join("\n");
}

function wrapLine(line: string, width: number): string {
  if (line.length <= width) return line;
  const chunks: string[] = [];
  for (let index = 0; index < line.length; index += width) {
    chunks.push(line.slice(index, index + width));
  }
  return chunks.join("\n");
}

function detectBashRisks(command: string): string[] {
  const risks: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+(-rf?|--recursive|--force)/i, "destructive delete"],
    [/\bsudo\b/i, "privileged command"],
    [/\b(chmod|chown)\b/i, "permission/ownership change"],
    [/>\s*[^&\s]|>>\s*[^\s]/, "file redirection"],
    [/\b(mv|cp)\b.+\s\//i, "filesystem change"],
    [
      /\b(npm|pnpm|yarn|pip|cargo|go)\s+(install|add|get)\b/i,
      "package install",
    ],
    [/\b(curl|wget)\b.*\|\s*(sh|bash|zsh)/i, "remote script execution"],
  ];

  for (const [pattern, label] of checks) {
    if (pattern.test(command) && !risks.includes(label)) risks.push(label);
  }

  return risks;
}

function readTrimmedFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function countLines(text: string): number {
  if (!text.length) return 0;
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
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

function truncate(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max)}\n… truncated …` : value;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A short, single-line command preview used as the verdict target so the
// transcript line stays readable (e.g. "✓ approved — npm test").
function bashTarget(input: unknown): string {
  if (!isRecord(input)) return "bash";
  const command = typeof input.command === "string" ? input.command : "";
  const firstLine = command.split("\n")[0]?.trim() ?? "";
  const preview = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  return preview || "bash";
}
