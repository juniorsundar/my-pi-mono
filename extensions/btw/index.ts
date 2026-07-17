import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadBtwTimeout } from "./timeout-config.js";
import { createRegistry, type BtwChildProcess } from "./registry.js";
import { SpinningListComponent } from "./spinning-list.js";
import { BtwReviewComponent } from "./review.js";
import { spawnBtwProcess } from "./spawner.js";
import { truncate } from "./text-utils.js";

// Module-level BTW registry shared across the extension lifetime.
// Persists across /new, /fork, /reload within the same process.
const btwRegistry = createRegistry();

// ── Helpers ──────────────────────────────────────────────────────────

/** Notification strategy: TUI uses ctx.ui.notify, non-TUI uses console.log */
type NotifyFn = (message: string, level: string) => void;

/**
 * Execute a BTW query, manage registry lifecycle, and notify via the provided strategy.
 * Shared between TUI and non-TUI paths to avoid duplication.
 */
async function executeBtwQuery(
  query: string,
  ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager">,
  notify: NotifyFn,
  options: { errorPrefix?: string; failPrefix?: string } = {},
): Promise<void> {
  const { errorPrefix = "", failPrefix = "" } = options;
  const { timeout } = loadBtwTimeout();
  const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
  const btwId = generateBtwId();

  try {
    const abortController = new AbortController();
    const result = await spawnBtwProcess({
      sessionFile,
      query,
      cwd: ctx.cwd,
      timeoutMs: timeout,
      signal: abortController.signal,
      onSpawn: (child) => {
        btwRegistry.addRunning(btwId, query, child as BtwChildProcess, abortController);
      },
    });

    if (result.ok === true) {
      btwRegistry.complete(btwId, {
        type: "success",
        text: result.text,
        toolTrace: result.toolTrace,
        usage: result.usage,
        model: result.model,
        stopReason: result.stopReason,
      });
      notify(result.text, "info");
    } else {
      btwRegistry.fail(btwId, result.errorMessage, {
        exitCode: result.exitCode,
        stderr: result.stderr,
        toolTrace: result.toolTrace,
        partialText: result.partialText,
      });
      // Include stderr in notification for actionable diagnostics
      const detail = result.stderr ? `\n${result.stderr.trim()}` : "";
      notify(`${errorPrefix}${result.errorMessage}${detail}`, "error");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    btwRegistry.fail(btwId, message);
    notify(`${failPrefix}${message}`, "error");
  }
}

function generateBtwId(): string {
  return `btw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Extension Entry Point ────────────────────────────────────────────

export default function btwExtension(pi: ExtensionAPI) {
  // BTW Child Guard: skip registration when running as a BTW child process
  if (process.env.PI_BTW_CHILD) return;

  // Set up the Spinning List widget above the editor once on startup.
  // The widget reads fresh state from the registry on each render.
  // Skip in non-TUI mode where setWidget is unavailable.
  pi.on("session_start", async (_event, ctx) => {
    btwRegistry.clear(); // fresh slate for new session

    if (ctx.hasUI) {
      ctx.ui.setWidget(
        "btw-spinning-list",
        (tui) => new SpinningListComponent(btwRegistry, tui),
        { placement: "aboveEditor" },
      );
    }
  });

  // Clean up running BTW processes on session shutdown.
  // Completed results are preserved so the BTW Review remains available
  // within the session. A fresh clear() happens on the next session_start.
  pi.on("session_shutdown", async () => {
    btwRegistry.killAll();
  });

  pi.registerCommand("btw", {
    description: "Ask a side-question or review BTW results",
    handler: async (args: string, ctx) => {
      // Non-TUI path: log unavailable message for review, execute query for questions
      if (!ctx.hasUI) {
        if (!args.trim()) {
          // No-args: BTW Review requires interactive mode
          console.log("BTW Review requires interactive mode");
          return;
        }
        // With args: execute query and log result (no overlay, no session mutation)
        const query = args.trim().replace(/^['"]|['"]$/g, "").trim();
        if (!query) {
          console.log("BTW: empty question.");
          return;
        }
        const notify: NotifyFn = (msg) => console.log(msg);
        await executeBtwQuery(query, ctx, notify);
        return;
      }

      if (!args.trim()) {
        // No-args: open BTW Review with completed results
        await ctx.ui.custom((tui, theme, keybindings, done) =>
          new BtwReviewComponent(btwRegistry.getCompleted(), tui, theme, () => done(undefined), keybindings),
        );
        return;
      }

      // Strip surrounding quotes from query
      const query = args.trim().replace(/^['"]|['"]$/g, "").trim();
      if (!query) {
        await ctx.ui.notify("BTW: empty question.", "warning");
        return;
      }

      const notify: NotifyFn = (msg, level) => {
        // Error messages already have prefix from executeBtwQuery, success needs BTW: prefix
        const prefixed = level === "info" ? `BTW: ${truncate(msg, 200)}` : truncate(msg, 200);
        ctx.ui.notify(prefixed, level as "info" | "error" | "warning");
      };
      // Fire-and-forget: don't await so the command handler returns immediately.
      // The BTW process runs in the background; the spinning list widget shows progress.
      executeBtwQuery(query, ctx, notify, { errorPrefix: "BTW error: ", failPrefix: "BTW failed: " });
    },
  });
}
