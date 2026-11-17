// Folds the tool calls of each run (prompt -> idle) behind one summary line.
//
//   - Click the summary line (fullscreen mode) to open/close that run.
//   - alt+o opens/closes the most recent run.
//   - /fold [on|off] turns folding off/on for the session.
//
// Thinking blocks of a folded run's tool-calling turns are hidden with it, by patching pi's
// AssistantMessageComponent (no public hook). Assistant text and tool-result images are not
// folded. Runs recorded without this extension stay unfolded.

import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, MouseRegion, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const START = "fold"; // rendered as the summary line
const END = "fold-end"; // stats only, never rendered
const PATCH = Symbol.for("fold.assistantPatch"); // survives /reload, so the originals are saved once

interface Run {
  id: string;
  tools: number;
  failed: number;
  turns: number;
  ms?: number;
  aborted?: boolean;
  open: boolean;
  live?: { start: number; tool?: string };
}

export function summary(r: Run): string {
  const parts = [`${r.tools} tool call${r.tools === 1 ? "" : "s"}`];
  if (r.live) {
    if (r.live.tool) parts.push(r.live.tool);
    parts.unshift("working");
  } else {
    if (r.turns) parts.push(`${r.turns} turn${r.turns === 1 ? "" : "s"}`);
    if (r.ms !== undefined) parts.push(r.ms < 60_000 ? `${Math.round(r.ms / 1000)}s` : `${Math.floor(r.ms / 60_000)}m${Math.round((r.ms % 60_000) / 1000)}s`);
    if (r.aborted) parts.push("aborted");
  }
  if (r.failed) parts.push(`${r.failed} failed`);
  return `${r.open ? "▾" : "▸"} ${parts.join(" · ")}`;
}

/** Rebuild runs and the toolCallId -> run map from session entries (file order; a run is contiguous). */
export function scan(entries: any[], runs: Map<string, Run>, toolRun: Map<string, string>) {
  let cur: Run | undefined;
  for (const e of entries) {
    if (e.type === "custom" && e.customType === START && e.data?.id) {
      cur = runs.get(e.data.id) ?? { id: e.data.id, tools: 0, failed: 0, turns: 0, open: false };
      runs.set(cur.id, cur);
    } else if (e.type === "custom" && e.customType === END) {
      const r = runs.get(e.data?.id);
      if (r) Object.assign(r, e.data);
      cur = undefined;
    } else if (cur && e.type === "message" && e.message?.role === "assistant") {
      for (const c of e.message.content ?? []) {
        if (c.type !== "toolCall" || toolRun.has(c.id)) continue;
        toolRun.set(c.id, cur.id);
        cur.tools++; // overwritten by the END entry when the run settled
      }
    }
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  const runs = new Map<string, Run>();
  const toolRun = new Map<string, string>();
  const hasResult = new Set<string>();
  let pending: Run | undefined; // current run; `marked` once its summary entry is written
  let marked = false;
  let rerender: (() => void) | undefined;

  const folded = (toolCallId: string) => {
    if (!enabled) return false;
    let id = toolRun.get(toolCallId);
    // A row can render before any tool event; claim it for the live run.
    if (!id && marked && pending) toolRun.set(toolCallId, (id = pending.id));
    const run = id ? runs.get(id) : undefined;
    return !!run && !run.open;
  };

  // shortcut: patches a pi internal (updateContent/render/lastMessage); if pi adds a message-renderer hook, use that.
  // Thinking streams before its turn's tool call exists, so it shows until the call arrives.
  const proto = AssistantMessageComponent.prototype as any;
  const orig = (proto[PATCH] ??= { updateContent: proto.updateContent, render: proto.render });
  const hides = (m: any) => !!m?.content?.some((c: any) => c.type === "toolCall" && folded(c.id));
  proto.updateContent = function (message: any, ...rest: any[]) {
    this[PATCH] = hides(message);
    const shown = this[PATCH] ? { ...message, content: message.content.filter((c: any) => c.type !== "thinking") } : message;
    orig.updateContent.call(this, shown, ...rest);
    this.lastMessage = message;
  };
  proto.render = function (width: number) {
    // Opening or closing a run changes the answer without any message event; rebuild lazily.
    if (this.lastMessage && hides(this.lastMessage) !== this[PATCH]) this.updateContent(this.lastMessage);
    return orig.render.call(this, width);
  };

  // One tool row half (call or result). Draws nothing while folded, otherwise pi's default box frame.
  class Row implements Component {
    constructor(
      public child: Component,
      private id: string,
      private part: "call" | "result",
      private bg: ((s: string) => string) | undefined, // undefined: the tool frames itself
      private pad: number,
    ) {}
    invalidate() {
      this.child.invalidate?.();
    }
    // shortcut: clicks are not forwarded to the child, so pi's whole-row click-to-expand is the only mouse action; forward if a tool renderer needs its own click targets.
    render(width: number): string[] {
      if (folded(this.id)) return [];
      if (!this.bg) return this.child.render(width);
      // Copy: components return their cached array, and padding it in place grows it on every redraw.
      const lines = this.child.render(Math.max(1, width - 2 * this.pad)).slice();
      if (this.part === "call") lines.unshift("");
      if (this.part === "result" || !hasResult.has(this.id)) lines.push("");
      const left = " ".repeat(this.pad);
      return lines.map((l) => this.bg!(left + l + " ".repeat(Math.max(0, width - this.pad - visibleWidth(l)))));
    }
  }

  pi.registerToolRenderer((toolName, next) => {
    const inner = next();
    const self = inner?.renderShell === "self";
    const wrap = (part: "call" | "result", build: (ctx: any, theme: any) => Component) => (ctx: any, theme: any) => {
      rerender = ctx.invalidate;
      const last = ctx.lastComponent instanceof Row ? ctx.lastComponent.child : undefined;
      const bg = self
        ? undefined
        : (s: string) => theme.bg(ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg", s);
      return new Row(build({ ...ctx, lastComponent: last }, theme), ctx.toolCallId, part, bg, ctx.outputPad);
    };
    return {
      renderShell: "self",
      renderCall: (args: any, theme: any, ctx: any) =>
        wrap("call", (c, t) =>
          inner?.renderCall
            ? inner.renderCall(args, t, c)
            : new Text(`${t.fg("toolTitle", t.bold(toolName))} ${t.fg("muted", JSON.stringify(args))}`, 0, 0),
        )(ctx, theme),
      renderResult: (result: any, options: any, theme: any, ctx: any) => {
        hasResult.add(ctx.toolCallId);
        return wrap("result", (c, t) => {
          if (inner?.renderResult) return inner.renderResult(result, options, t, c);
          const lines = (result.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n").split("\n");
          return new Text(t.fg("toolOutput", (options.expanded ? lines : lines.slice(0, 10)).join("\n")), 0, 0);
        })(ctx, theme);
      },
    } as any;
  });

  pi.registerEntryRenderer<{ id: string }>(START, (entry, _options, theme) => {
    const run = entry.data && runs.get(entry.data.id);
    if (!enabled || !run) return undefined;
    const line: Component = {
      invalidate() {},
      render: (width) => [truncateToWidth(" " + theme.fg(run.failed ? "warning" : "muted", summary(run)), width)],
    };
    return new MouseRegion(line, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      run.open = !run.open;
      return { handled: true };
    });
  });

  // Write the summary entry at the run's first tool call, so runs without tools get no line.
  const mark = () => {
    if (!enabled || !pending || marked) return;
    marked = true;
    runs.set(pending.id, pending);
    pi.appendEntry(START, { id: pending.id });
  };

  pi.on("before_agent_start", () => {
    // Steering and follow-ups arrive inside the same run; only start a new one when idle.
    if (!pending) {
      pending = { id: `${Date.now()}`, tools: 0, failed: 0, turns: 0, open: false, live: { start: Date.now() } };
      marked = false;
    }
  });
  pi.on("turn_start", () => {
    if (pending) pending.turns++;
  });
  pi.on("message_update", (event) => {
    const m = event.message as any;
    if (m.role === "assistant" && m.content?.some((c: any) => c.type === "toolCall")) mark();
  });
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId || !pending) return;
    mark();
    if (marked) toolRun.set(event.toolCallId, pending.id);
    pending.live!.tool = event.toolName;
  });
  pi.on("tool_execution_end", (event) => {
    if (event.parentToolCallId || !pending) return;
    pending.tools++;
    if (event.isError) pending.failed++;
  });
  pi.on("agent_settled", (event) => {
    const run = pending;
    pending = undefined;
    if (!run) return;
    run.ms = Date.now() - run.live!.start;
    run.aborted = event.aborted || undefined;
    delete run.live;
    if (marked) {
      const { id, tools, failed, turns, ms, aborted } = run;
      pi.appendEntry(END, { id, tools, failed, turns, ms, aborted });
    }
  });

  const rescan = (_event: unknown, ctx: any) => scan(ctx.sessionManager.getEntries(), runs, toolRun);
  pi.on("session_start", rescan);
  pi.on("session_tree", rescan);

  pi.registerShortcut("alt+o", {
    description: "Fold/unfold the tool calls of the most recent run",
    handler: (ctx) => {
      const run = [...runs.values()].pop();
      if (!run) return ctx.ui.notify("No folded run yet");
      run.open = !run.open;
      rerender?.();
    },
  });

  pi.registerCommand("fold", {
    description: "Fold tool calls behind a summary line: /fold [on|off]",
    handler: async (args, ctx) => {
      const arg = args.trim();
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      // Flipping the global expand state makes pi rebuild every summary entry, which adds or removes the lines.
      const expanded = ctx.ui.getToolsExpanded();
      ctx.ui.setToolsExpanded(!expanded);
      ctx.ui.setToolsExpanded(expanded);
      ctx.ui.notify(`Tool folding ${enabled ? "on" : "off"}`);
    },
  });
}
