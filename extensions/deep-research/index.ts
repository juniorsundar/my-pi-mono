import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadDeepresearchConfig, type DeepResearchConfig } from "./config.js";
import { ResearchStateManager } from "./state-manager.js";
import { spawnSubagent } from "../subagents/index.js";
import type { SpawnSubagentResult } from "../subagents/index.js";

const DEEP_RESEARCH_AGENTS_DIR = join(homedir(), ".pi", "agent", "agents", "deep-research");
const MAX_ITERATIONS = 10;
// SUBAGENTS_DIR is resolved per-call from ctx.cwd in archiveLatestSubagentOutput

export default function deepResearchExtension(pi: ExtensionAPI) {
  
  // ── Tools ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "spawn_research_subagent",
    label: "Spawn Research Subagent",
    description:
      "Spawn a deep-research subagent (r-plan, r-search, r-learn, r-gap, r-verify, r-synth). " +
      "Use only during the deep-research workflow — not for normal subagent tasks.",
    parameters: Type.Object({
      agent_type: Type.String({
        description:
          "Type of research subagent: r-plan (research planning), r-search (web search), r-learn (fetch/learn from URLs), " +
          "r-gap (gap analysis), r-verify (verify claims), r-synth (final synthesis)",
      }),
      prompt: Type.String({ description: "Task prompt for the research subagent" }),
    }),
    promptGuidelines: [
      "Use spawn_research_subagent ONLY during deep-research workflow to spawn r-plan, r-search, r-learn, r-gap, r-verify, or r-synth subagents.",
      "r-plan is spawned automatically on iteration 1; do not spawn it again.",
      "Do not use spawn_research_subagent for general subagent tasks — use the regular subagent tool instead.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { agent_type, prompt } = params as { agent_type: string; prompt: string };
      const config = loadDeepresearchConfig().config;

      let result: SpawnSubagentResult;
      let wasRetried = false;
      try {
        result = await spawnSubagent({
          agentType: agent_type,
          task: prompt,
          agentsDir: DEEP_RESEARCH_AGENTS_DIR,
          workDir: ctx.cwd,
          signal,
          onProgress: onUpdate
            ? (feed) => {
                try {
                  onUpdate({
                    content: [{ type: "text" as const, text: `[${agent_type}] ${feed.collapsed.text}` }],
                    details: feed,
                  });
                } catch (e) {
                  console.warn("spawn_research_subagent onProgress: error sending update", e instanceof Error ? e.message : String(e));
                }
              }
            : undefined,
          overrides: {
            ...(config.subagentModel ? { model: config.subagentModel } : {}),
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("spawn_research_subagent: error spawning subagent, retrying once...", msg);

        // Retry once
        try {
          result = await spawnSubagent({
            agentType: agent_type,
            task: prompt,
            agentsDir: DEEP_RESEARCH_AGENTS_DIR,
            workDir: ctx.cwd,
            signal,
            onProgress: onUpdate
              ? (feed) => {
                  try {
                    onUpdate({
                      content: [{ type: "text" as const, text: `[${agent_type}] ${feed.collapsed.text}` }],
                      details: feed,
                    });
                  } catch (e) {
                    console.warn("spawn_research_subagent onProgress: error sending update", e instanceof Error ? e.message : String(e));
                  }
                }
              : undefined,
            overrides: {
              ...(config.subagentModel ? { model: config.subagentModel } : {}),
            },
          });
          wasRetried = true;
        } catch (e2) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          console.warn("spawn_research_subagent: retry also failed", msg2);
          const failedAgentId = `${agent_type}-failed-${Date.now().toString(36).slice(-6)}`;
          return {
            content: [{ type: "text", text: `[error] ${agent_type} subagent failed after retry: ${msg2}` }],
            details: {
              agentType: agent_type,
              agentId: failedAgentId,
              error: msg2,
              retried: true,
            },
          };
        }
      }

      return {
        content: [{ type: "text", text: result.output }],
        details: {
          agentId: result.agentId,
          agentType: result.agentType,
          duration: result.duration,
          model: result.model,
          usage: result.usage,
          ...(wasRetried ? { retried: true } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "deep_research_complete",
    label: "Deep Research Complete",
    description:
      "Call this when the deep research is complete and the final synthesis has been written to state.md. " +
      "This signals the orchestrator to stop iterating and return the result.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "Deep research marked as complete. The orchestrator will return the final result." }],
        details: { researchComplete: true },
      };
    },
  });

  // ── Command ────────────────────────────────────────────────────────

  pi.registerCommand("deep-research", {
    description: "Run deep research on a topic: /deep-research <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /deep-research <query>", "warning");
        return;
      }

      // 1. Load config
      const { config, errors } = loadDeepresearchConfig();
      if (errors.length > 0 && !config.subagentModel && !config.orchestratorModel) {
        ctx.ui.notify(
          `deepresearch config error: ${errors[0]}. Add a "deepresearch" key to settings.json.`,
          "error",
        );
        return;
      }

      ctx.ui.notify(`Deep research: "${query}"`, "info");

      // 2. Create research directory and initial state
      const slug = ResearchStateManager.slugify(query);
      const stateManager = new ResearchStateManager(ctx.cwd, slug);
      stateManager.initialize(query, query);

      // 3. Create loop anchor — a fixed point in the session we can navigate back to
      pi.appendEntry("deep-research-anchor", { slug });
      const anchorId = ctx.sessionManager.getLeafId();
      if (!anchorId) {
        throw new Error("Deep research anchor was not added to the session");
      }

      // 4. Set orchestrator model if configured
      if (config.orchestratorModel) {
        const slashIdx = config.orchestratorModel.indexOf("/");
        if (slashIdx > 0) {
          const provider = config.orchestratorModel.slice(0, slashIdx);
          const modelId = config.orchestratorModel.slice(slashIdx + 1);
          const model = ctx.modelRegistry?.find(provider, modelId);
          if (model) {
            await pi.setModel(model);
          }
        }
      }

      // 5. Iteration loop
      // Helper to build the per-iteration prompt
      function buildPrompt(iteration: number): string {
        const isFirst = iteration === 1;
        if (isFirst) {
          return (
            `You are in **deep-research** mode. Your goal is to research the following question by spawning research subagents in sequence.\n\n` +
            `**Research state file:** \`.pi/deep-research/${slug}/state.md\`\n\n` +
            `**How deep research works:**\n` +
            `1. Read the research state file using the \`read\` tool.\n` +
            `2. Decide which research subagent to spawn next using the \`spawn_research_subagent\` tool.\n` +
            `   Available agents: r-plan (research planning), r-search (search web), r-learn (fetch/learn URLs), r-gap (gap analysis), r-verify (verify claims), r-synth (final synthesis).\n` +
            `3. After the subagent returns, read the updated research state file.\n` +
            `4. Update the research state file with:\n` +
            `   - New findings from the subagent\n` +
            `   - Updated gaps and next step suggestions\n` +
            `   - The completed step in the Steps Completed section\n` +
            `5. If research is complete, update state.md to set "Status" to "complete" and call the \`deep_research_complete\` tool.\n\n` +
            `**Important:** Each iteration starts with a fresh context. Always read the state file — do not rely on conversation history.\n\n` +
            `**First step:** Read the state file and spawn **r-plan** to create a research plan. After r-plan writes the Research Plan section to state.md, read it and follow it as a guide for the next steps.`
          );
        }
        return (
          `Continue deep research. Read \`.pi/deep-research/${slug}/state.md\` and advance the research.\n\n` +
          `Refer to the **Research Plan** section in state.md — it decomposed the question into areas and suggested search angles. Use it as a guide.\n\n` +
          `Spawn the next appropriate research subagent with \`spawn_research_subagent\`.\n` +
          `After the subagent returns, update state.md with the findings.\n` +
          `When fully complete, set Status to "complete" in state.md and call \`deep_research_complete\`.`
        );
      }

      // 5. Abort signal tracking
      let aborted = ctx.signal?.aborted === true;
      let currentIteration = 0;
      let lastCompletedStepType: string | undefined;

      if (ctx.signal && !aborted) {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
      }

      let hasSuccessfulArchive = false;
      try {
      for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
        currentIteration = iteration;

        // Check abort at start of iteration
        if (aborted) {
          currentIteration = iteration - 1;
          break;
        }

        // 5a. Notify progress and send iteration prompt
        ctx.ui.notify(`Deep research: iteration ${iteration}/${MAX_ITERATIONS}`, "info");
        const prompt = buildPrompt(iteration);
        await pi.sendUserMessage(prompt, { deliverAs: "followUp" });

        // 5b. Wait for the agent to process
        await ctx.waitForIdle();

        // Check abort after async wait (e.g., Escape pressed during research turn)
        if (aborted) {
          break;
        }

        // 5c. Read current state
        const currentState = stateManager.read();

        // 5c-bis. Detect subagent errors and log them to state.md
        const subagentError = detectSubagentError(ctx);
        if (subagentError) {
          let stateContent = currentState;
          stateContent = stateManager.appendErrorToState(stateContent, {
            agentType: subagentError.agentType,
            agentId: subagentError.agentId,
            message: subagentError.error,
            timestamp: Date.now(),
            isRetry: subagentError.isRetry,
          });
          stateManager.write(stateContent);
        }

        // 5d. Check if research is complete (either via status or deep_research_complete tool)
        const isComplete = currentState.includes("## Status\ncomplete") ||
                           currentState.includes("Status: complete") ||
                           wasCompleteToolCalled(ctx);

        if (isComplete) {
          // Archive the final step
          archiveLatestSubagentOutput(ctx, stateManager);

          // Present the result
          const finalState = stateManager.read();
          pi.sendMessage(
            {
              customType: "deep-research-result",
              content: `### Deep Research Complete: ${query}\n\n${finalState}`,
              display: true,
              details: { slug, iterations: iteration },
            },
            { triggerTurn: false },
          );
          ctx.ui.notify(`Deep research complete (${iteration} iteration${iteration > 1 ? "s" : ""}).`, "info");
          return;
        }

        // 5e. Archive the latest subagent output to steps/
        const archiveResult = archiveLatestSubagentOutput(ctx, stateManager);

        // 5e-bis. Log warning if output was empty
        if (archiveResult.isEmpty) {
          let stateContent = stateManager.read();
          stateContent = stateManager.appendErrorToState(stateContent, {
            agentType: archiveResult.agentType || "unknown",
            message: "Subagent returned empty output",
            timestamp: Date.now(),
          });
          stateManager.write(stateContent);
        }

        // 5f. Show post-iteration summary and navigate back to anchor
        if (archiveResult.archived) {
          hasSuccessfulArchive = true;
          lastCompletedStepType = archiveResult.agentType ?? "unknown";
          // Log retry success to state.md if applicable
          if (archiveResult.wasRetry) {
            let stateContent = stateManager.read();
            stateContent = stateManager.appendErrorToState(stateContent, {
              agentType: archiveResult.agentType || "unknown",
              message: "Subagent succeeded on retry after initial failure",
              timestamp: Date.now(),
              isRetry: true,
            });
            stateManager.write(stateContent);
          }
          ctx.ui.notify(`Iteration ${iteration} complete: ${archiveResult.agentType ?? "unknown"} archived`, "info");
        }
        await ctx.navigateTree(anchorId, { summarize: false });
      }
      } catch (e) {
        // Catch AbortError from framework APIs (sendUserMessage, waitForIdle)
        // when the user presses Escape during an async operation
        if (e instanceof Error && (e.name === "AbortError" || ctx.signal?.aborted)) {
          aborted = true;
        } else {
          throw e;
        }
      }

      // Abort handling (unified — covers both pre-loop and mid-loop abort)
      if (aborted) {
        let stateContent = stateManager.read();
        stateContent = stateManager.markInterrupted(stateContent, {
          iteration: currentIteration,
          lastStep: lastCompletedStepType,
        });
        stateManager.write(stateContent);
        ctx.ui.notify(
          `Deep research interrupted at iteration ${currentIteration}. Partial results saved to .pi/deep-research/${slug}/`,
          "warning",
        );
        return;
      }

      // Max iterations reached
      if (!hasSuccessfulArchive) {
        // All iterations had persistent failures — mark as partial
        let stateContent = stateManager.read();
        stateContent = stateManager.markPartial(stateContent);
        stateManager.write(stateContent);
        ctx.ui.notify(
          `Deep research reached ${MAX_ITERATIONS} iterations with persistent failures. ` +
          `Results are partial in .pi/deep-research/${slug}/state.md`,
          "error",
        );
      } else {
        ctx.ui.notify(
          `Deep research reached ${MAX_ITERATIONS} iterations without completing. ` +
          `Partial results in .pi/deep-research/${slug}/state.md`,
          "warning",
        );
      }
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Check if the latest spawn_research_subagent tool result contains an error.
 * Returns { agentType, error } if an error is found, or null if no error.
 */
function detectSubagentError(ctx: { sessionManager: { getBranch: () => any[] } }): { agentType: string; agentId?: string; error: string; isRetry?: boolean } | null {
  try {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message?.toolName === "spawn_research_subagent"
      ) {
        const details = entry.message.details;
        if (details && details.error) {
          return { agentType: details.agentType || "unknown", agentId: details.agentId, error: details.error, isRetry: details.retried === true };
        }
        return null;
      }
    }
  } catch (e) {
    console.warn("detectSubagentError: error scanning session", e instanceof Error ? e.message : String(e));
  }
  return null;
}

/**
 * Check if the last assistant message contains a deep_research_complete tool call.
 */
function wasCompleteToolCalled(ctx: { sessionManager: { getBranch: () => any[] } }): boolean {
  try {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        Array.isArray(entry.message.content)
      ) {
        for (const block of entry.message.content) {
          if (block.type === "toolCall" && block.name === "deep_research_complete") {
            return true;
          }
        }
        // Only check the latest assistant message
        break;
      }
    }
  } catch (e) {
    console.warn("wasCompleteToolCalled: error scanning session entries", e instanceof Error ? e.message : String(e));
  }
  return false;
}

/**
 * Find the latest spawn_research_subagent tool result in the session
 * and copy its output to the steps archive.
 */
function archiveLatestSubagentOutput(ctx: { cwd?: string; sessionManager: any }, stateManager: ResearchStateManager): { archived: boolean; agentType?: string; error?: string; isEmpty?: boolean; wasRetry?: boolean } {
  try {
    const entries = ctx.sessionManager.getBranch();
    // Scan from newest to oldest
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message?.toolName === "spawn_research_subagent"
      ) {
        const agentId = entry.message.details?.agentId;
        const agentType = entry.message.details?.agentType;
        const wasRetry = entry.message.details?.retried === true;
        if (agentId && agentType) {
          const outputPath = join(ctx.cwd || process.cwd(), ".pi", "subagents", agentId, "output.md");
          if (existsSync(outputPath)) {
            const output = readFileSync(outputPath, "utf-8");
            if (output.trim().length === 0) {
              return { archived: false, isEmpty: true, agentType };
            }
            const stepRecord = stateManager.archiveStep(output, agentType, agentId);
            // Update state.md's Steps Completed section
            const currentState = stateManager.read();
            const updated = stateManager.appendStepToState(currentState, stepRecord);
            stateManager.write(updated);
            return { archived: true, agentType, wasRetry };
          }
        }
        return { archived: false }; // Nothing archived
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("archiveLatestSubagentOutput: error during archive", msg);
    return { archived: false, error: msg };
  }
  return { archived: false };
}
