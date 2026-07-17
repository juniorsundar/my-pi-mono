import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type NeovimProcessResult = { status: number | null };

export function runNeovimWithArgsProcess(options: {
  tempDir: string;
  nvimArgs: string[];
  targetPath: string;
  windowTitlePrefix: string;
}): NeovimProcessResult {
  if (isInsideTmux() && commandExists("tmux")) {
    const tmuxResult = runNeovimApprovalInTmuxWindow(options);
    if (tmuxResult.started) return { status: tmuxResult.status };
  }

  return spawnSync("nvim", options.nvimArgs, {
    stdio: "inherit",
    env: process.env,
  });
}

export function commandExists(command: string): boolean {
  return getCommandPath(command) !== null;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function safePreviewBasename(targetPath: string): string {
  const name = basename(targetPath.trim()) || "file.txt";
  return name.replaceAll("\0", "_").replace(/[\\/]/g, "_") || "file.txt";
}

function runNeovimApprovalInTmuxWindow(options: {
  tempDir: string;
  nvimArgs: string[];
  targetPath: string;
  windowTitlePrefix: string;
}): { started: boolean; status: number | null } {
  const sessionTarget = getCurrentTmuxSessionTarget();
  if (!sessionTarget) return { started: false, status: null };

  const waitName = `pi-nvim-approval-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runnerPath = join(options.tempDir, "run-neovim-approval.sh");
  const donePath = join(options.tempDir, "tmux-done.txt");
  const nvimCommand = getCommandPath("nvim") ?? "nvim";
  const nvimCommandLine = [nvimCommand, ...options.nvimArgs]
    .map(shellQuote)
    .join(" ");

  writeFileSync(
    runnerPath,
    [
      "#!/bin/sh",
      "set +e",
      `done_file=${shellQuote(donePath)}`,
      "finish() {",
      "  printf 'done\\n' > \"$done_file\" 2>/dev/null || true",
      `  tmux wait-for -S ${shellQuote(waitName)} >/dev/null 2>&1 || true`,
      "}",
      "trap finish EXIT",
      nvimCommandLine,
      "status=$?",
      'exit "$status"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(runnerPath, 0o700);

  const windowName = `${options.windowTitlePrefix} ${safePreviewBasename(options.targetPath)}`.slice(
    0,
    80,
  );
  const start = spawnSync(
    "tmux",
    [
      "new-window",
      "-t",
      sessionTarget,
      "-n",
      windowName,
      shellQuote(runnerPath),
    ],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (start.status !== 0) return { started: false, status: start.status };

  let status: number | null = null;
  while (!existsSync(donePath)) {
    const wait = spawnSync("tmux", ["wait-for", waitName], {
      stdio: "ignore",
      env: process.env,
      timeout: 1000,
    });
    status = wait.status;
    if (existsSync(donePath)) break;
    if (
      wait.error &&
      (wait.error as NodeJS.ErrnoException).code !== "ETIMEDOUT"
    ) {
      break;
    }
  }

  return { started: true, status };
}

function isInsideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

function getCurrentTmuxSessionTarget(): string | undefined {
  const result = spawnSync("tmux", ["display-message", "-p", "#{session_id}"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function getCommandPath(command: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split("\n")[0] || command;
}
