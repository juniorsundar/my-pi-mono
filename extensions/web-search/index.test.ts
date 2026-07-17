import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (hoisted before imports) ─────────────────────
//
// Mock typebox to produce plain JSON schema objects that are easy to
// assert against. We need the real schema shape (type, optionality,
// description) for the web_fetch tool parameters.
vi.mock("typebox", () => {
  const Type = {
    Object: (properties: Record<string, unknown>, options?: Record<string, unknown>) => {
      // Properties with _optional: true are excluded from required (matching TypeBox)
      const allKeys = Object.keys(properties);
      const required = (options?.required as string[]) ??
        allKeys.filter((k) => !(properties[k] as Record<string, unknown>)?._optional);
      return {
        type: "object",
        properties,
        required,
        ...(options?.description && { description: options.description }),
      };
    },
    String: (options?: Record<string, unknown>) => ({
      type: "string",
      ...(options?.description && { description: options.description }),
    }),
    Number: (options?: Record<string, unknown>) => ({
      type: "number",
      ...(options?.description && { description: options.description }),
      ...(options?.minimum !== undefined && { minimum: options.minimum }),
      ...(options?.maximum !== undefined && { maximum: options.maximum }),
    }),
    Boolean: (options?: Record<string, unknown>) => ({
      type: "boolean",
      ...(options?.description && { description: options.description }),
      ...(options?.default !== undefined && { default: options.default }),
    }),
    Optional: (schema: unknown) => ({
      ...(schema as object),
      _optional: true,
    }),
    Unsafe: (schema: unknown) => schema,
  };
  return { Type };
});

// Mock @earendil-works/pi-ai/compat for StringEnum
vi.mock("@earendil-works/pi-ai/compat", () => ({
  StringEnum: (values: readonly string[], options?: Record<string, unknown>) => ({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
  }),
}));

// ── Import module under test (after mocks are hoisted) ─────────────
// eslint-disable-next-line import/first
import webSearchExtension from "./index.js";

// ── Helper: create a mock pi that captures tool registrations ──────
interface CapturedTool {
  name: string;
  parameters: unknown;
  description: string;
  [key: string]: unknown;
}

function createMockPi() {
  const tools: CapturedTool[] = [];
  // Collect registrations so the test can assert on them
  const commands: Array<{ name: string; info: unknown }> = [];

  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const pi = {
    registerTool: vi.fn((tool: CapturedTool) => {
      tools.push(tool);
      return () => {
        const idx = tools.indexOf(tool);
        if (idx >= 0) tools.splice(idx, 1);
      };
    }),
    registerCommand: vi.fn((name: string, info: unknown) => {
      commands.push({ name, info });
    }),
    sendMessage: vi.fn(),
    exec: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) h(...args);
    }),
  };
  return { pi, tools, commands, handlers };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("web_fetch tool schema", () => {
  let tools: CapturedTool[];
  let webFetchTool: CapturedTool | undefined;

  beforeEach(() => {
    const mock = createMockPi();
    tools = mock.tools;

    // Call the extension factory
    const cleanup = webSearchExtension(mock.pi as any);
    expect(mock.pi.registerTool).toHaveBeenCalled();

    // Find the web_fetch tool registration
    webFetchTool = tools.find((t) => t.name === "web_fetch");
  });

  it("registers web_fetch tool", () => {
    expect(webFetchTool).toBeDefined();
    expect(webFetchTool!.name).toBe("web_fetch");
  });

  it("declares download as an optional boolean parameter", () => {
    expect(webFetchTool).toBeDefined();
    const params = webFetchTool!.parameters as Record<string, any>;
    expect(params).toBeDefined();
    expect(params.type).toBe("object");
    expect(params.properties).toBeDefined();

    // download must exist as a property
    const download = params.properties.download;
    expect(download).toBeDefined();
    expect(download.type).toBe("boolean");

    // download must be optional (not in required array)
    expect(params.required).not.toContain("download");
  });

  it("gives download a description matching existing documentation", () => {
    expect(webFetchTool).toBeDefined();
    const params = webFetchTool!.parameters as Record<string, any>;
    const download = params.properties.download;

    // The description should reference saving binary files (images, PDFs)
    // to a local temp path, matching the tool's text description
    expect(download.description).toBeTruthy();
    expect(download.description.toLowerCase()).toContain("binary");
    expect(download.description.toLowerCase()).toContain("temp");
  });

  it("forwards GitHub result fields through the public tool result", async () => {
    const mock = createMockPi();
    webSearchExtension(mock.pi as any);
    const tool = mock.tools.find((candidate) => candidate.name === "web_fetch") as any;
    const githubResult = {
      url: "https://github.com/acme/project/tree/main/src",
      finalUrl: "https://github.com/acme/project/tree/main/src",
      statusCode: 200,
      contentType: "text/plain; charset=utf-8",
      format: "markdown",
      content: "# Repository: acme/project\\n\\n```\\nsrc/index.ts\\n```",
      warnings: ["GitHub returned a partial tree."],
      sourceTruncated: true,
      contentArtifactPath: "/tmp/web-fetch-tree.txt",
      data: {
        owner: "acme",
        repo: "project",
        ref: "main",
        path: "src",
        entries: [{ path: "src/index.ts", type: "blob" }],
      },
      details: {
        statusCode: 200,
        authenticated: true,
        remaining: 42,
        resetAt: "2023-11-14T22:13:20+00:00",
      },
    };
    mock.pi.exec.mockResolvedValue({
      stdout: JSON.stringify(githubResult),
      stderr: "",
      code: 0,
    });

    const toolResult = await tool.execute("call-1", {
      url: githubResult.url,
    }, undefined, undefined);
    const details = toolResult.details as Record<string, any>;

    expect(details.warnings).toEqual(githubResult.warnings);
    expect(details.sourceTruncated).toBe(true);
    expect(details.contentArtifactPath).toBe(githubResult.contentArtifactPath);
    expect(details.data).toEqual(githubResult.data);
    expect(details.details).toEqual(githubResult.details);
    expect(details.raw).toEqual(githubResult);
    expect(toolResult.content[0].text).toContain("GitHub returned a partial tree.");
  });

  it("forwards parameters and selects the download timeout", async () => {
    const mock = createMockPi();
    webSearchExtension(mock.pi as any);
    const tool = mock.tools.find((candidate) => candidate.name === "web_fetch") as any;
    mock.pi.exec.mockResolvedValue({
      stdout: JSON.stringify({ url: "https://github.com/acme/project/blob/main/logo.png", path: "/tmp/logo.png" }),
      stderr: "",
      code: 0,
    });

    await tool.execute("call-2", {
      url: "https://github.com/acme/project/blob/main/logo.png",
      maxChars: 1200,
      format: "text",
      raw: false,
      download: true,
    }, undefined, undefined);

    expect(mock.pi.exec).toHaveBeenCalledWith(
      "uv",
      expect.arrayContaining([
        "--url", "https://github.com/acme/project/blob/main/logo.png",
        "--download",
      ]),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it("includes download as the last property after raw", () => {
    expect(webFetchTool).toBeDefined();
    const params = webFetchTool!.parameters as Record<string, any>;
    const propNames = Object.keys(params.properties);

    // Verify download is declared and appears after raw
    expect(propNames).toContain("download");
    expect(propNames.indexOf("download")).toBe(propNames.length - 1);
  });
});

// ── GitHub resource forwarding (tickets 0053–0056) ──────────────────
//
// The TypeScript adapter shells out to scripts/fetch.py via `pi.exec`
// and forwards the parsed JSON result fields generically into the tool
// result `details` (and, where applicable, the human-readable `content`
// text). The tests below mock `pi.exec` to return canned GitHub result
// shapes and assert that every GitHub-specific field survives the hop
// through the adapter unchanged.
describe("web_fetch GitHub result forwarding", () => {
  function loadTool() {
    const mock = createMockPi();
    webSearchExtension(mock.pi as any);
    const tool = mock.tools.find((c) => c.name === "web_fetch") as any;
    return { mock, tool };
  }

  it("forwards GitHub blob content results (text mode)", async () => {
    const { mock, tool } = loadTool();
    const blobResult = {
      url: "https://github.com/acme/project/blob/main/src/index.ts",
      finalUrl: "https://github.com/acme/project/blob/main/src/index.ts",
      statusCode: 200,
      contentType: "text/plain; charset=utf-8",
      format: "markdown",
      content: "export function main() { return 1; }\n",
      truncated: false,
      contentLength: 32,
      fetchedBytes: 32,
      warnings: [],
      sourceTruncated: false,
      data: {
        owner: "acme",
        repo: "project",
        ref: "main",
        path: "src/index.ts",
        name: "index.ts",
        size: 32,
      },
      details: {
        statusCode: 200,
        authenticated: false,
      },
    };
    mock.pi.exec.mockResolvedValue({ stdout: JSON.stringify(blobResult), stderr: "", code: 0 });

    const res = await tool.execute("blob-1", {
      url: blobResult.url,
      maxChars: 1000,
      format: "markdown",
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    // Generic forwarding of every GitHub field
    expect(details.statusCode).toBe(200);
    expect(details.contentType).toBe("text/plain; charset=utf-8");
    expect(details.format).toBe("markdown");
    expect(details.truncated).toBe(false);
    expect(details.sourceTruncated).toBe(false);
    expect(details.warnings).toEqual([]);
    expect(details.data).toEqual(blobResult.data);
    expect(details.details).toEqual(blobResult.details);
    expect(details.raw).toEqual(blobResult);
    // Human-readable content carries the blob body
    expect(res.content[0].text).toContain("export function main()");
  });

  it("forwards GitHub blob content results (download mode)", async () => {
    const { mock, tool } = loadTool();
    const downloadResult = {
      url: "https://github.com/acme/project/blob/main/logo.png",
      finalUrl: "https://github.com/acme/project/blob/main/logo.png",
      statusCode: 200,
      contentType: "image/png",
      path: "/tmp/web-fetch-abc123.png",
      fileName: "logo.png",
      byteSize: 2048,
      sha1: "deadbeef",
      warnings: [],
    };
    mock.pi.exec.mockResolvedValue({ stdout: JSON.stringify(downloadResult), stderr: "", code: 0 });

    const res = await tool.execute("blob-2", {
      url: downloadResult.url,
      download: true,
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(details.path).toBe("/tmp/web-fetch-abc123.png");
    expect(details.fileName).toBe("logo.png");
    expect(details.byteSize).toBe(2048);
    expect(details.sha1).toBe("deadbeef");
    expect(details.raw).toEqual(downloadResult);
    // Human-readable output points to the saved artifact
    expect(res.content[0].text).toContain("/tmp/web-fetch-abc123.png");
  });

  it("forwards GitHub resolution failure results with structured error details", async () => {
    const { mock, tool } = loadTool();
    const failureResult = {
      error: "GitHub API returned 404: Not Found",
      url: "https://github.com/acme/project/tree/main/missing",
      details: {
        statusCode: 404,
        authenticated: true,
        remaining: 4999,
        resetAt: "2023-11-14T22:13:20+00:00",
      },
    };
    mock.pi.exec.mockResolvedValue({ stdout: JSON.stringify(failureResult), stderr: "", code: 1 });

    const res = await tool.execute("fail-1", {
      url: failureResult.url,
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    // The error message is surfaced in the human-readable output
    expect(res.content[0].text).toContain("GitHub API returned 404: Not Found");
    // Structured error details are forwarded verbatim
    expect(details.raw.error).toBe(failureResult.error);
    expect(details.raw.url).toBe(failureResult.url);
    expect(details.raw.details).toEqual(failureResult.details);
  });

  it("forwards rate-limit metadata (remaining quota, reset time, auth status)", async () => {
    const { mock, tool } = loadTool();
    const rateLimitResult = {
      error: "GitHub API returned 429: Too Many Requests",
      url: "https://github.com/acme/project/tree/main",
      details: {
        statusCode: 429,
        authenticated: true,
        remaining: 0,
        resetAt: "2023-11-14T22:13:20+00:00",
      },
    };
    mock.pi.exec.mockResolvedValue({ stdout: JSON.stringify(rateLimitResult), stderr: "", code: 1 });

    const res = await tool.execute("rate-1", {
      url: rateLimitResult.url,
    }, undefined, undefined);

    const details = (res.details as Record<string, any>).raw.details;
    expect(details.statusCode).toBe(429);
    expect(details.authenticated).toBe(true);
    expect(details.remaining).toBe(0);
    expect(details.resetAt).toBe("2023-11-14T22:13:20+00:00");
  });

  it("forwards sourceTruncated and contentArtifactPath for GitHub resources", async () => {
    const { mock, tool } = loadTool();
    const truncatedResult = {
      url: "https://github.com/acme/project/tree/main/huge",
      finalUrl: "https://github.com/acme/project/tree/main/huge",
      statusCode: 200,
      contentType: "text/plain; charset=utf-8",
      format: "markdown",
      content: "# Tree (partial)",
      truncated: true,
      contentLength: 1000,
      fetchedBytes: 50000,
      warnings: ["GitHub returned a partial tree."],
      sourceTruncated: true,
      contentArtifactPath: "/tmp/web-fetch-huge.txt",
      data: { owner: "acme", repo: "project", ref: "main", path: "huge", entries: [] },
      details: { statusCode: 200, authenticated: false },
    };
    mock.pi.exec.mockResolvedValue({ stdout: JSON.stringify(truncatedResult), stderr: "", code: 0 });

    const res = await tool.execute("trunc-1", {
      url: truncatedResult.url,
      maxChars: 1000,
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(details.sourceTruncated).toBe(true);
    expect(details.contentArtifactPath).toBe("/tmp/web-fetch-huge.txt");
    // Human-readable output surfaces both markers
    expect(res.content[0].text).toContain("**Source truncated:** yes");
    expect(res.content[0].text).toContain("/tmp/web-fetch-huge.txt");
  });

  it("forwards warnings from GitHub operations", async () => {
    const { mock, tool } = loadTool();
    const warnedResult = {
      url: "https://github.com/acme/project/tree/main",
      finalUrl: "https://github.com/acme/project/tree/main",
      statusCode: 200,
      contentType: "text/plain; charset=utf-8",
      format: "markdown",
      content: "# Tree",
      warnings: ["Rate limit approaching.", "Partial tree returned."],
      sourceTruncated: false,
      data: { owner: "acme", repo: "project", ref: "main", path: "", entries: [] },
      details: { statusCode: 200, authenticated: false },
    };
    mock.pi.exec.mockResolvedValue({ stdout: JSON.stringify(warnedResult), stderr: "", code: 0 });

    const res = await tool.execute("warn-1", {
      url: warnedResult.url,
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(details.warnings).toEqual(warnedResult.warnings);
    // Both warnings appear in the human-readable output
    expect(res.content[0].text).toContain("Rate limit approaching.");
    expect(res.content[0].text).toContain("Partial tree returned.");
  });
});

// ── Credential confinement, leak prevention, host-restriction (0056) ──
//
// The TypeScript adapter never touches GITHUB_TOKEN directly: it does
// not read it from the environment, does not pass it on the subprocess
// command line, and does not inject it via the exec environment. All
// credential handling lives in the Python layer. These tests assert the
// confinement at the adapter boundary.
describe("web_fetch credential confinement & host restriction", () => {
  const SECRET = "ghp_super-secret-token-DO-NOT-LEAK";

  function loadTool() {
    const mock = createMockPi();
    webSearchExtension(mock.pi as any);
    const tool = mock.tools.find((c) => c.name === "web_fetch") as any;
    return { mock, tool };
  }

  beforeEach(() => {
    // Ensure the secret is present in the environment. The adapter must
    // NOT forward it anywhere — it should not even read it.
    process.env.GITHUB_TOKEN = SECRET;
  });

  it("does not pass GITHUB_TOKEN or an Authorization header on the exec command line", async () => {
    const { mock, tool } = loadTool();
    mock.pi.exec.mockResolvedValue({
      stdout: JSON.stringify({ url: "https://github.com/acme/project/blob/main/x", content: "" }),
      stderr: "",
      code: 0,
    });

    await tool.execute("confine-1", {
      url: "https://github.com/acme/project/blob/main/x",
    }, undefined, undefined);

    const call = mock.pi.exec.mock.calls[0];
    const argv = call[1] as string[];
    // No token-like flag is ever passed to the subprocess
    expect(argv.some((a) => /token/i.test(a))).toBe(false);
    expect(argv.some((a) => /authorization/i.test(a))).toBe(false);
    // The secret value must never appear as a bare argument
    expect(argv).not.toContain(SECRET);
    // The adapter always invokes the fixed fetch.py script — it never
    // constructs a GitHub API URL itself, so the token cannot leak into
    // a metadata-provided or user-provided redirect URL at this layer.
    expect(argv.some((a) => /fetch\.py$/.test(a))).toBe(true);
    expect(argv.some((a) => /^https:\/\/api\.github\.com/.test(a))).toBe(false);
  });

  it("does not inject GITHUB_TOKEN into the subprocess environment", async () => {
    const { mock, tool } = loadTool();
    mock.pi.exec.mockResolvedValue({
      stdout: JSON.stringify({ url: "https://github.com/acme/project/tree/main", content: "" }),
      stderr: "",
      code: 0,
    });

    await tool.execute("confine-2", {
      url: "https://github.com/acme/project/tree/main",
    }, undefined, undefined);

    const opts = mock.pi.exec.mock.calls[0][2] as Record<string, any>;
    // The adapter only sets signal/timeout/cwd — never an `env` override
    expect(opts.env).toBeUndefined();
    // Sanity: the exec options must not carry the secret anywhere
    expect(JSON.stringify(opts)).not.toContain(SECRET);
  });

  it("never lets GITHUB_TOKEN appear in tool outputs or content artifacts", async () => {
    const { mock, tool } = loadTool();
    // Simulate a result that accidentally echoed the token back in
    // content/warnings/data — the adapter must forward fields verbatim,
    // but we assert that the *adapter itself* never introduces the token.
    // Here we confirm a clean result stays clean.
    mock.pi.exec.mockResolvedValue({
      stdout: JSON.stringify({
        url: "https://github.com/acme/project/tree/main",
        finalUrl: "https://github.com/acme/project/tree/main",
        statusCode: 200,
        contentType: "text/plain; charset=utf-8",
        format: "markdown",
        content: "# Tree\nsrc/\n",
        warnings: [],
        sourceTruncated: false,
        contentArtifactPath: "/tmp/web-fetch-clean.txt",
        data: { owner: "acme", repo: "project", ref: "main" },
        details: { statusCode: 200, authenticated: true, remaining: 42 },
      }),
      stderr: "",
      code: 0,
    });

    const res = await tool.execute("leak-1", {
      url: "https://github.com/acme/project/tree/main",
    }, undefined, undefined);

    // The token must not appear anywhere in the serialized tool result
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("ghp_");
    // The content artifact path is forwarded but must not embed the token
    expect(res.content[0].text).toContain("/tmp/web-fetch-clean.txt");
    expect(res.content[0].text).not.toContain(SECRET);
  });

  it("does not forward GITHUB_TOKEN to metadata-provided or user-provided redirect URLs", async () => {
    const { mock, tool } = loadTool();
    // A GitHub result can carry a finalUrl/redirect. The adapter only
    // forwards it inside `details`; it never re-issues a request to it
    // and never attaches credentials to it. We assert the adapter makes
    // exactly one exec call (to the fixed fetch.py) and never calls the
    // redirect URL itself.
    mock.pi.exec.mockResolvedValue({
      stdout: JSON.stringify({
        url: "https://github.com/acme/project/tree/main",
        finalUrl: "https://redirect.example.com/attacker",
        statusCode: 200,
        contentType: "text/plain; charset=utf-8",
        format: "markdown",
        content: "# x",
        warnings: [],
        sourceTruncated: false,
        data: {},
        details: { statusCode: 200, authenticated: true },
      }),
      stderr: "",
      code: 0,
    });

    await tool.execute("redir-1", {
      url: "https://github.com/acme/project/tree/main",
    }, undefined, undefined);

    // Only one subprocess invocation, and it was to the fixed script
    expect(mock.pi.exec).toHaveBeenCalledTimes(1);
    const argv = mock.pi.exec.mock.calls[0][1] as string[];
    expect(argv.some((a) => /fetch\.py$/.test(a))).toBe(true);
    // The redirect URL is never passed as a fetch target
    expect(argv).not.toContain("https://redirect.example.com/attacker");
    // The redirect URL survives in the forwarded details (metadata only)
    const res = await mock.pi.exec.mock.results[0].value.then(() => undefined);
    void res;
    // Re-invoke to inspect forwarded details
    const result = await tool.execute("redir-2", {
      url: "https://github.com/acme/project/tree/main",
    }, undefined, undefined);
    expect((result.details as Record<string, any>).finalUrl).toBe("https://redirect.example.com/attacker");
    // But the secret never accompanies it
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("delegates host-restriction enforcement to the Python layer (no in-process fetch)", async () => {
    const { mock, tool } = loadTool();
    mock.pi.exec.mockResolvedValue({
      stdout: JSON.stringify({
        error: "Host resolves to private address: 169.254.169.254",
        url: "http://169.254.169.254/latest/meta-data/",
      }),
      stderr: "",
      code: 1,
    });

    // The adapter must not pre-validate/filter hosts itself; it forwards
    // the URL verbatim to the subprocess, which enforces host restriction.
    await tool.execute("host-1", {
      url: "http://169.254.169.254/latest/meta-data/",
    }, undefined, undefined);

    const argv = mock.pi.exec.mock.calls[0][1] as string[];
    // The URL is passed through unchanged — no adapter-side rewriting
    expect(argv).toContain("http://169.254.169.254/latest/meta-data/");
    // The adapter did not short-circuit: it still called the subprocess
    expect(mock.pi.exec).toHaveBeenCalledTimes(1);
    // The Python-layer error is forwarded faithfully (host restriction enforced)
    const result = await tool.execute("host-2", {
      url: "http://169.254.169.254/latest/meta-data/",
    }, undefined, undefined);
    expect(result.content[0].text).toContain("Host resolves to private address");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
