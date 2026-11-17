// Folds each stretch of tool calls behind one summary line. A stretch ends when the
// assistant writes text (narration or the final answer) or the user speaks, so the
// next tool calls get their own line below that text.
//
//   - Click the summary line (fullscreen mode) to open/close that stretch.
//   - alt+o opens/closes the most recent stretch.
//   - /fold [on|off] turns folding off/on for the session.
//
// The summary line is drawn by the stretch's first tool row, so nothing is written to the
// session; stretches are rebuilt from the transcript on resume.
// Thinking blocks of a folded stretch's tool-calling turns are hidden with it, by patching pi's
// AssistantMessageComponent (no public hook). Assistant text and tool-result images are not folded.

import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("fold.assistantPatch"); // survives /reload, so the originals are saved once

interface Run {
  id: string; // toolCallId of the first call, whose row draws the summary line
  tools: number;
  failed: number;
  turns: number;
  start: number;
  ms?: number;
  aborted?: boolean;
  open: boolean;
  live?: { tool?: string };
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

const hasText = (m: any) => !!m.content?.some?.((c: any) => c.type === "text" && c.text.trim());

/** Rebuild runs and the toolCallId -> run map from session entries (file order), keeping which runs are open. */
export function scan(entries: any[], runs: Map<string, Run>, toolRun: Map<string, string>) {
  const open = new Set([...runs.values()].filter((r) => r.open).map((r) => r.id));
  runs.clear();
  toolRun.clear();
  let cur: Run | undefined;
  for (const e of entries) {
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role === "user") cur = undefined;
    else if (m?.role === "assistant") {
      if (hasText(m)) cur = undefined;
      const calls = (m.content ?? []).filter((c: any) => c.type === "toolCall");
      if (!calls.length) continue;
      if (!cur) runs.set(calls[0].id, (cur = { id: calls[0].id, tools: 0, failed: 0, turns: 0, start: m.timestamp, open: open.has(calls[0].id) }));
      for (const c of calls) toolRun.set(c.id, cur.id);
      cur.tools += calls.length;
      cur.turns++;
      if (m.stopReason === "aborted") cur.aborted = true;
    } else if (m?.role === "toolResult") {
      const r = runs.get(toolRun.get(m.toolCallId)!);
      if (!r) continue;
      if (m.isError) r.failed++;
      r.ms = m.timestamp - r.start;
    }
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  const runs = new Map<string, Run>();
  const toolRun = new Map<string, string>();
  const hasResult = new Set<string>();
  let active = false; // between prompt and idle
  let cur: Run | undefined; // the stretch new tool calls join
  let fresh = false; // cur was started by the message now streaming, so its own text does not end it
  let rerender: (() => void) | undefined;

  const end = () => {
    if (!cur) return;
    cur.ms = Date.now() - cur.start;
    delete cur.live;
    cur = undefined;
  };
  const claim = (toolCallId: string) => {
    if (!active || toolRun.has(toolCallId)) return;
    if (!cur) {
      runs.set(toolCallId, (cur = { id: toolCallId, tools: 0, failed: 0, turns: 0, start: Date.now(), open: false, live: {} }));
      fresh = true;
    }
    toolRun.set(toolCallId, cur.id);
  };
  // A row can render before any tool event, so rendering claims too.
  const runOf = (toolCallId: string) => {
    if (!enabled) return undefined;
    claim(toolCallId);
    return runs.get(toolRun.get(toolCallId)!);
  };
  const folded = (toolCallId: string) => runOf(toolCallId)?.open === false;

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
  // The call half of a run's first tool also draws the run's summary line, above the frame.
  class Row implements Component {
    constructor(
      public child: Component,
      private id: string,
      private part: "call" | "result",
      private bg: ((s: string) => string) | undefined, // undefined: the tool frames itself
      private pad: number,
      private theme: any,
    ) {}
    invalidate() {
      this.child.invalidate?.();
    }
    private head() {
      const run = this.part === "call" ? runOf(this.id) : undefined;
      return run?.id === this.id ? run : undefined;
    }
    // shortcut: other clicks are not forwarded to the child, so pi's whole-row click-to-expand is the only mouse action on a tool; forward if a tool renderer needs its own click targets.
    handleMouse(event: any) {
      const run = this.head();
      if (!run || event.y !== 0 || event.type !== "click" || event.button !== "left") return undefined;
      run.open = !run.open;
      return { handled: true };
    }
    render(width: number): string[] {
      const run = this.head();
      const top = run ? [truncateToWidth(" " + this.theme.fg(run.failed ? "warning" : "muted", summary(run)), width)] : [];
      if (folded(this.id)) return top;
      if (run) top.push("");
      if (!this.bg) return [...top, ...this.child.render(width)];
      const lines = this.child.render(Math.max(1, width - 2 * this.pad)).slice();
      if (this.part === "call") lines.unshift("");
      if (this.part === "result" || !hasResult.has(this.id)) lines.push("");
      const left = " ".repeat(this.pad);
      return [...top, ...lines.map((l) => this.bg!(left + l + " ".repeat(Math.max(0, width - this.pad - visibleWidth(l)))))];
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
      return new Row(build({ ...ctx, lastComponent: last }, theme), ctx.toolCallId, part, bg, ctx.outputPad, theme);
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

  // Steering and follow-ups arrive inside the same prompt-to-idle span; the user message ends the stretch.
  pi.on("before_agent_start", () => {
    active = true;
  });
  pi.on("message_start", (event) => {
    if ((event.message as any).role === "user") end();
    fresh = false;
  });
  pi.on("message_update", (event) => {
    const m = event.message as any;
    if (m.role !== "assistant") return;
    // Narration ends the stretch, so this message's tool calls start a new one below the text.
    if (!fresh && hasText(m)) end();
    for (const c of m.content ?? []) if (c.type === "toolCall") claim(c.id);
  });
  pi.on("message_end", (event) => {
    const m = event.message as any;
    if (m.role !== "assistant") return;
    if (!fresh && hasText(m)) end();
    if (cur && m.content?.some((c: any) => c.type === "toolCall")) cur.turns++;
  });
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId) return;
    claim(event.toolCallId);
    const run = runs.get(toolRun.get(event.toolCallId)!);
    if (run?.live) run.live.tool = event.toolName;
  });
  pi.on("tool_execution_end", (event) => {
    if (event.parentToolCallId) return;
    const run = runs.get(toolRun.get(event.toolCallId)!);
    if (!run) return;
    run.tools++;
    if (event.isError) run.failed++;
  });
  pi.on("agent_settled", (event) => {
    if (cur && event.aborted) cur.aborted = true;
    end();
    active = false;
  });

  const rescan = (_event: unknown, ctx: any) => scan(ctx.sessionManager.getBranch(), runs, toolRun);
  pi.on("session_start", rescan);
  pi.on("session_tree", rescan);

  pi.registerShortcut("alt+o", {
    description: "Fold/unfold the most recent stretch of tool calls",
    handler: (ctx) => {
      const run = [...runs.values()].pop();
      if (!run) return ctx.ui.notify("No folded tool calls yet");
      run.open = !run.open;
      rerender?.();
    },
  });

  pi.registerCommand("fold", {
    description: "Fold tool calls behind a summary line: /fold [on|off]",
    handler: async (args, ctx) => {
      const arg = args.trim();
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      rerender?.();
      ctx.ui.notify(`Tool folding ${enabled ? "on" : "off"}`);
    },
  });
}
