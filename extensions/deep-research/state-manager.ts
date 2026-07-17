import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join, resolve } from "path";

export interface ErrorRecord {
  agentType: string;
  agentId?: string;
  message: string;
  timestamp: number;
  isRetry?: boolean;
}

export interface StepRecord {
  agentType: string;
  agentId: string;
  timestamp: number;
  summary: string;
  outputFile: string;
}

const DEFAULT_STATE_TEMPLATE = `# Deep Research: {topic}

## Status
active

## Original Question
{question}

## Research Plan
*No plan yet — awaiting r-plan.*

## Summary
*Research in progress.*

## Findings
*Accumulated findings will appear here.*

## Steps Completed
*No steps completed yet.*

## Current Gaps
*Gaps identified will appear here.*

## Errors
*No errors recorded.*

## Next Step
*Awaiting orchestrator decision.*
`;

/**
 * Manages the deep-research directory and state.md file.
 *
 * Directory structure:
 *   .pi/deep-research/<slug>/
 *     state.md        — accumulated research state
 *     steps/          — per-subagent outputs
 *       <agent-id>.md — raw subagent output
 */
export class ResearchStateManager {
  private readonly baseDir: string;
  private readonly stepsDir: string;
  public readonly stateFile: string;
  public readonly slug: string;

  constructor(workDir: string, slug: string) {
    this.slug = slug;
    this.baseDir = resolve(join(workDir, ".pi", "deep-research", slug));
    this.stepsDir = join(this.baseDir, "steps");
    this.stateFile = join(this.baseDir, "state.md");
  }

  /** Create the research directory structure and write initial state.md. */
  initialize(topic: string, question: string): void {
    mkdirSync(this.stepsDir, { recursive: true });

    const initial = DEFAULT_STATE_TEMPLATE
      .replace("{topic}", topic)
      .replace("{question}", question);
    writeFileSync(this.stateFile, initial, "utf-8");
  }

  /** Check if the research directory exists (i.e., research was initialized). */
  exists(): boolean {
    return existsSync(this.stateFile);
  }

  /** Read the current state.md content. */
  read(): string {
    return readFileSync(this.stateFile, "utf-8");
  }

  /** Write new content to state.md. */
  write(content: string): void {
    writeFileSync(this.stateFile, content, "utf-8");
  }

  /** Archive a subagent's output to the steps directory and return the file path. */
  archiveStep(output: string, agentType: string, agentId: string): StepRecord {
    const stepFile = join(this.stepsDir, `${agentId}.md`);
    const header = `# Step: ${agentType} (${agentId})\n\n`;
    writeFileSync(stepFile, header + output, "utf-8");

    return {
      agentType,
      agentId,
      timestamp: Date.now(),
      summary: extractSummary(output),
      outputFile: stepFile,
    };
  }

  /** Append a step record to state.md's steps section. */
  appendStepToState(stateContent: string, step: StepRecord): string {
    const stepLine = `${step.timestamp} — **${step.agentType}** (\`${step.agentId}\`) — ${step.summary}`;
    return stateContent.replace(
      /## Steps Completed\n[\s\S]*?(?=\n## |$)/,
      (match) => {
        const header = "## Steps Completed";
        const content = match.slice(header.length).trim();
        const lines = content ? content.split("\n").filter(Boolean) : [];
        lines.push(stepLine);
        return `${header}\n${lines.join("\n")}`;
      },
    );
  }

  /** Append an error record to state.md's Errors section. */
  appendErrorToState(stateContent: string, error: ErrorRecord): string {
    const errorLine = `${error.timestamp} — **${error.agentType}**${error.agentId ? ` (\`${error.agentId}\`)` : ""} — ${error.message}${error.isRetry ? " (retry)" : ""}`;

    // If ## Errors section exists, append to it
    if (/## Errors/.test(stateContent)) {
      return stateContent.replace(
        /## Errors\n[\s\S]*?(?=\n## |$)/,
        (match) => {
          const header = "## Errors";
          const content = match.slice(header.length).trim();
          // Replace placeholder or append
          if (content === "*No errors recorded.*") {
            return `${header}\n${errorLine}`;
          }
          const lines = content.split("\n").filter(Boolean);
          lines.push(errorLine);
          return `${header}\n${lines.join("\n")}`;
        },
      );
    }

    // Otherwise, add a new ## Errors section before ## Next Step or at the end
    const section = `## Errors\n${errorLine}`;
    if (/## Next Step/.test(stateContent)) {
      return stateContent.replace(/## Next Step/, `${section}\n\n## Next Step`);
    }
    return stateContent + `\n\n${section}`;
  }

  /** Mark research as partial in state.md (after persistent failures). */
  markPartial(stateContent: string): string {
    return stateContent.replace(/^## Status\nactive/m, "## Status\npartial");
  }

  /** Mark research as complete in state.md. */
  markComplete(stateContent: string): string {
    return stateContent.replace(/^## Status\nactive/m, "## Status\ncomplete");
  }

  /** Mark research as interrupted (user pressed Escape, signal aborted). */
  markInterrupted(stateContent: string, info: { iteration: number; lastStep?: string }): string {
    const stepped = stateContent.replace(/^## Status\nactive/m, "## Status\ninterrupted");
    const lastStepNote = info.lastStep ? `, last completed step: ${info.lastStep}` : "";
    const interruptRecord: ErrorRecord = {
      agentType: "interrupted",
      message: `Research interrupted at iteration ${info.iteration}${lastStepNote}`,
      timestamp: Date.now(),
    };
    return this.appendErrorToState(stepped, interruptRecord);
  }

  /** Extract the slug from a research topic string (simple sanitization). */
  static slugify(topic: string): string {
    return topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }
}

/** Extract first line of output as a summary (for step records). */
function extractSummary(output: string): string {
  const firstLine = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---"));
  return firstLine
    ? firstLine.slice(0, 120) + (firstLine.length > 120 ? "..." : "")
    : "(no summary)";
}
