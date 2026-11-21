// Follow Mode: after a successful edit or write, the Companion Editor (the nvim `nv` opened beside
// this pi, reachable through NV_SOCKET) jumps to the first changed line and column (CONTEXT.md, Follow).
// The position comes from comparing the file before and after the call, which gives a column and
// works the same for edit and write: pi's own `firstChangedLine` has no column and write has none.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const JUMP_TIMEOUT_MS = 1000;

// Evaluated by nvim. luaeval takes an expression, not statements, so the body sits in a function.
// `a` is {path, line, col}: col is a 0-based byte offset, as nvim_win_set_cursor wants.
// The jump must never disturb the user: it does nothing while they are typing, and it never
// touches a buffer holding unsaved changes. It prefers a window of the current tab that already
// shows the file (without making it the current window), else loads the file where the user is.
const JUMP_LUA = [
  "(function(a)",
  // insert, replace, command-line, terminal, and normal mode entered from insert with CTRL-O
  'local mode = vim.api.nvim_get_mode().mode if mode:match("^[iRct]") or mode:match("^ni") then return 0 end',
  "local buf",
  'for _, b in ipairs(vim.api.nvim_list_bufs()) do if vim.api.nvim_buf_is_loaded(b) and vim.fn.fnamemodify(vim.api.nvim_buf_get_name(b), ":p") == a.path then buf = b end end',
  "if buf and vim.bo[buf].modified then",
  'vim.notify("pi changed " .. a.path .. ", but this buffer has unsaved changes: not reloaded", vim.log.levels.WARN)',
  "return 0 end",
  "local win",
  "if buf then for _, w in ipairs(vim.fn.win_findbuf(buf)) do if vim.api.nvim_win_get_tabpage(w) == vim.api.nvim_get_current_tabpage() then win = w; break end end end",
  "if not win then vim.cmd.edit(vim.fn.fnameescape(a.path)); win = vim.api.nvim_get_current_win() end",
  "vim.api.nvim_win_call(win, function()",
  "vim.cmd.checktime()",
  "vim.api.nvim_win_set_cursor(0, { math.min(a.line, vim.api.nvim_buf_line_count(0)), a.col })",
  'vim.cmd("normal! zz")',
  "end)",
  "return 1",
  "end)(_A)",
].join(" ");

interface Jump {
  path: string;
  line: number;
  col: number;
}

export default function followExtension(pi: ExtensionAPI) {
  const socket = process.env.NV_SOCKET;
  // Subagents and Persona sessions can inherit NV_SOCKET from the main session; only it follows.
  const isMainSession = process.env.PI_SUBAGENT_CHILD !== "1" && process.env.PI_HERDR_SUBAGENT !== "1" && !process.env.PI_PERSONA_SESSION;
  if (!socket || !isMainSession) return;

  // shortcut: the file is read when the call starts, so a change made in the Companion Editor
  // while an approval is pending is attributed to the call; upgrade if that ever misleads.
  const before = new Map<string, { path: string; text: string }>();
  // Jumps go out one at a time, in the order the changes happened.
  let queue: Promise<unknown> = Promise.resolve();

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path !== "string") return;
    const absolute = resolve(ctx.cwd, path);
    before.set(event.toolCallId, { path: absolute, text: read(absolute) });
  });

  // pi ends every call with tool_execution_end, but a blocked call never gets a tool_result.
  pi.on("tool_execution_end", (event) => {
    before.delete(event.toolCallId);
  });

  pi.on("tool_result", (event) => {
    const snapshot = before.get(event.toolCallId);
    if (!snapshot || event.isError) return;
    const jump = firstChange(snapshot.path, snapshot.text, read(snapshot.path));
    if (jump) queue = queue.then(() => send(jump)).catch(() => undefined); // an unreachable nvim is silent
  });

  async function send(jump: Jump): Promise<void> {
    const expr = `luaeval('${vimString(JUMP_LUA)}', json_decode('${vimString(JSON.stringify(jump))}'))`;
    await pi.exec("nvim", ["--server", socket!, "--remote-expr", expr], { timeout: JUMP_TIMEOUT_MS });
  }
}

/** The file's text, or "" when it does not exist yet (or cannot be read as text). */
function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Where `after` first differs from `before`: 1-based line, 0-based byte column. Undefined when equal. */
function firstChange(path: string, before: string, after: string): Jump | undefined {
  if (before === after) return undefined;
  const limit = Math.min(before.length, after.length);
  let at = 0;
  while (at < limit && before.charCodeAt(at) === after.charCodeAt(at)) at++;
  // Never split a surrogate pair: two emoji can share their first half.
  if (at > 0 && isHighSurrogate(after.charCodeAt(at - 1)) && isLowSurrogate(after.charCodeAt(at))) at--;

  const lineStart = at === 0 ? 0 : after.lastIndexOf("\n", at - 1) + 1;
  let line = 1;
  for (let i = after.indexOf("\n"); i !== -1 && i < at; i = after.indexOf("\n", i + 1)) line++;
  return { path, line, col: Buffer.byteLength(after.slice(lineStart, at)) };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The body of a Vimscript single-quoted string: only the quote itself needs escaping. */
const vimString = (text: string) => text.replaceAll("'", "''");
