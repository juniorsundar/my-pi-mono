import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

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

import webSearchExtension from "./index.js";
import { dnsResolver } from "./src/fetch.js";

// ── Helper: create a mock pi that captures tool registrations ──────
interface CapturedTool {
  name: string;
  parameters: unknown;
  description: string;
  [key: string]: unknown;
}

function createMockPi() {
  const tools: CapturedTool[] = [];
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

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const server = setupServer();

beforeEach(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  vi.spyOn(dnsResolver, "lookup").mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ]);
});
afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
});

// ===========================================================================
// web_fetch tool schema — unchanged by the cut
// ===========================================================================

describe("web_fetch tool schema", () => {
  let tools: CapturedTool[];
  let webFetchTool: CapturedTool | undefined;

  beforeEach(() => {
    const mock = createMockPi();
    tools = mock.tools;
    const cleanup = webSearchExtension(mock.pi as any);
    expect(mock.pi.registerTool).toHaveBeenCalled();
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
    const download = params.properties.download;
    expect(download).toBeDefined();
    expect(download.type).toBe("boolean");
    expect(params.required).not.toContain("download");
  });

  it("gives download a description matching existing documentation", () => {
    expect(webFetchTool).toBeDefined();
    const params = webFetchTool!.parameters as Record<string, any>;
    const download = params.properties.download;
    expect(download.description).toBeTruthy();
    expect(download.description.toLowerCase()).toContain("binary");
    expect(download.description.toLowerCase()).toContain("temp");
  });

  it("includes download as the last property after raw", () => {
    expect(webFetchTool).toBeDefined();
    const params = webFetchTool!.parameters as Record<string, any>;
    const keys = Object.keys(params.properties);
    expect(keys.indexOf("download")).toBeGreaterThan(keys.indexOf("raw"));
  });
});

// ===========================================================================
// web_fetch GitHub result forwarding (in-process)
// ===========================================================================
//
// After the final cut (#0009), web_fetch calls src/fetch.ts in-process,
// which routes github.com URLs through src/github.ts. These tests drive
// the real TS path against msw and assert the tool result's details
// surface (the shape the LLM caller consumes) carries the GitHub fields.

describe("web_fetch GitHub result forwarding", () => {
  function loadTool() {
    const mock = createMockPi();
    webSearchExtension(mock.pi as any);
    const tool = mock.tools.find((c) => c.name === "web_fetch") as any;
    return { mock, tool };
  }

  function ghApi(url: string, handler: Parameters<typeof http.get>[1]) {
    server.use(http.get(url, handler));
  }

  it("forwards GitHub tree results through the public tool result", async () => {
    const { tool } = loadTool();
    ghApi("https://api.github.com/repos/acme/project", () =>
      HttpResponse.json({ default_branch: "main", full_name: "acme/project" }),
    );
    ghApi("https://api.github.com/repos/acme/project/commits/main", () =>
      HttpResponse.json({ sha: SHA }),
    );
    ghApi(`https://api.github.com/repos/acme/project/git/trees/${SHA}`, () =>
      HttpResponse.json({
        sha: SHA, truncated: false,
        tree: [{ path: "src/index.ts", type: "blob", sha: SHA_B, mode: "100644" }],
      }),
    );

    const res = await tool.execute("call-1", {
      url: "https://github.com/acme/project/tree/main/src",
    }, undefined, undefined);
    const details = res.details as Record<string, any>;

    expect(details.statusCode).toBe(200);
    expect(details.contentType).toContain("text/plain");
    expect(details.format).toBe("markdown");
    expect(details.warnings).toEqual([]);
    expect(details.sourceTruncated).toBe(false);
    // The rendered tree content carries the entry
    expect(res.content[0].text).toContain("src/index.ts");
    expect(res.content[0].text).toContain("# Repository: acme/project");
  });

  it("forwards GitHub blob content results (text mode)", async () => {
    const { tool } = loadTool();
    const content = "export function main() { return 1; }\n";
    ghApi("https://api.github.com/repos/acme/project/contents/src%2Findex.ts", ({ request }) => {
      const sp = new URL(request.url).searchParams;
      expect(sp.get("ref")).toBe("main");
      return HttpResponse.json({
        name: "index.ts", path: "src/index.ts",
        content: Buffer.from(content).toString("base64"),
        encoding: "base64", size: content.length,
      });
    });

    const res = await tool.execute("blob-1", {
      url: "https://github.com/acme/project/blob/main/src/index.ts",
      maxChars: 1000,
      format: "markdown",
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(details.statusCode).toBe(200);
    expect(details.format).toBe("markdown");
    expect(details.truncated).toBe(false);
    expect(details.sourceTruncated).toBe(false);
    expect(res.content[0].text).toContain("export function main()");
  });

  it("forwards GitHub blob content results (download mode)", async () => {
    const { tool } = loadTool();
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG sig
    ghApi("https://api.github.com/repos/acme/project/contents/logo.png", () =>
      HttpResponse.json({
        name: "logo.png", path: "logo.png",
        content: content.toString("base64"),
        encoding: "base64", size: content.length,
      }),
    );

    const res = await tool.execute("blob-2", {
      url: "https://github.com/acme/project/blob/main/logo.png",
      download: true,
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(details.contentType).toBe("image/png");
    expect(details.fileName.endsWith(".png")).toBe(true);
    expect(details.byteSize).toBe(content.length);
    expect(details.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(details.path).toBeTruthy();
    expect(res.content[0].text).toContain(details.path);
   	const fs = await import("node:fs");
   	expect(fs.existsSync(details.path)).toBe(true);
   	fs.rmSync(details.path, { force: true });
  });

  it("forwards GitHub resolution failure results with structured error details", async () => {
    const { tool } = loadTool();
    ghApi("https://api.github.com/repos/acme/project/contents/missing", ({ request }) => {
      const sp = new URL(request.url).searchParams;
      expect(sp.get("ref")).toBe("main");
      return HttpResponse.json(
        { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
        { status: 404 },
      );
    });

    const res = await tool.execute("fail-1", {
      url: "https://github.com/acme/project/blob/main/missing",
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(res.content[0].text).toContain("GitHub API returned 404");
    expect(details.raw.error).toMatch(/GitHub API returned 404/);
    expect(details.raw.url).toBe("https://github.com/acme/project/blob/main/missing");
    expect(details.raw.details.statusCode).toBe(404);
  });

  it("forwards rate-limit metadata (remaining quota, reset time, auth status)", async () => {
    const { tool } = loadTool();
    vi.stubEnv("GITHUB_TOKEN", "ghp_test-token");
    ghApi("https://api.github.com/repos/acme/project", ({ request }) => {
      expect(request.headers.get("Authorization")).toBe("Bearer ghp_test-token");
      return new HttpResponse(
        JSON.stringify({ message: "Too Many Requests" }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000",
          },
        },
      );
    });

    const res = await tool.execute("rate-1", {
      url: "https://github.com/acme/project/tree/main",
    }, undefined, undefined);

    const details = (res.details as Record<string, any>).raw.details;
    expect(details.statusCode).toBe(429);
    expect(details.authenticated).toBe(true);
    expect(details.remaining).toBe(0);
    expect(details.resetAt).toBeTruthy();
  });

  it("forwards sourceTruncated and contentArtifactPath for truncated GitHub trees", async () => {
    const { tool } = loadTool();
    ghApi("https://api.github.com/repos/acme/project", () =>
      HttpResponse.json({ default_branch: "main", full_name: "acme/project" }),
    );
    ghApi("https://api.github.com/repos/acme/project/commits/main", () =>
      HttpResponse.json({ sha: SHA }),
    );
    ghApi(`https://api.github.com/repos/acme/project/git/trees/${SHA}`, () =>
      HttpResponse.json({
        sha: SHA, truncated: true,
        tree: [{ path: "only.md", type: "blob", sha: SHA_B, mode: "100644" }],
      }),
    );

    const res = await tool.execute("trunc-1", {
      url: "https://github.com/acme/project/tree/main",
      maxChars: 5000,
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(details.sourceTruncated).toBe(true);
    expect(details.warnings.some((w: string) => w.includes("truncated tree"))).toBe(true);
    expect(res.content[0].text).toContain("**Source truncated:** yes");
  });

  it("forwards warnings from GitHub operations", async () => {
    const { tool } = loadTool();
    ghApi("https://api.github.com/repos/acme/project", () =>
      HttpResponse.json({ default_branch: "main", full_name: "acme/project" }),
    );
    ghApi("https://api.github.com/repos/acme/project/commits/main", () =>
      HttpResponse.json({ sha: SHA }),
    );
    ghApi(`https://api.github.com/repos/acme/project/git/trees/${SHA}`, () =>
      HttpResponse.json({
        sha: SHA, truncated: false,
        tree: Array.from({ length: 2100 }, (_, i) => ({
          path: `file_${String(i).padStart(4, "0")}.py`,
          type: "blob", sha: SHA_B, mode: "100644",
       	})),
      }),
    );

    const res = await tool.execute("warn-1", {
      url: "https://github.com/acme/project/tree/main",
    }, undefined, undefined);

    const details = res.details as Record<string, any>;
    expect(details.sourceTruncated).toBe(true);
    expect(details.warnings.some((w: string) => w.includes("exceeds 2000"))).toBe(true);
  });
});

// ===========================================================================
// web_fetch credential confinement, leak prevention, host-restriction
// ===========================================================================
//
// After the cut, credential handling lives in the TS layer (src/github.ts):
// GITHUB_TOKEN is read from the environment and sent as a Bearer header to
// api.github.com only, never to non-GitHub hosts, and never serialized into
// tool output. Host restriction (SSRF) is enforced in src/fetch.ts via
// dnsResolver + ipaddr.js. These tests assert that confinement at the
// in-process boundary.

describe("web_fetch credential confinement & host restriction", () => {
  const SECRET = "ghp_super-secret-token-DO-NOT-LEAK";

  function loadTool() {
    const mock = createMockPi();
    webSearchExtension(mock.pi as any);
    const tool = mock.tools.find((c) => c.name === "web_fetch") as any;
    return { mock, tool };
  }

  beforeEach(() => {
    process.env.GITHUB_TOKEN = SECRET;
  });
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it("sends Bearer auth to api.github.com when GITHUB_TOKEN is set", async () => {
    const { tool } = loadTool();
    let authHeader: string | null = null;
    server.use(http.get("https://api.github.com/repos/acme/project", ({ request }) => {
      authHeader = request.headers.get("Authorization");
      return HttpResponse.json({ default_branch: "main", full_name: "acme/project" });
    }));
    server.use(http.get("https://api.github.com/repos/acme/project/commits/main", () =>
      HttpResponse.json({ sha: SHA }),
    ));
    server.use(http.get(`https://api.github.com/repos/acme/project/git/trees/${SHA}`, () =>
      HttpResponse.json({ sha: SHA, truncated: false, tree: [] }),
    ));

    await tool.execute("auth-1", {
      url: "https://github.com/acme/project",
    }, undefined, undefined);

    expect(authHeader).toBe(`Bearer ${SECRET}`);
  });

  it("never lets GITHUB_TOKEN appear in tool outputs or content", async () => {
    const { tool } = loadTool();
    const content = "public content";
    server.use(http.get("https://api.github.com/repos/acme/project/contents/README.md", ({ request }) => {
      const sp = new URL(request.url).searchParams;
      expect(sp.get("ref")).toBe("main");
      return HttpResponse.json({
        name: "README.md", path: "README.md",
        content: Buffer.from(content).toString("base64"),
        encoding: "base64", size: content.length,
      });
    }));

    const res = await tool.execute("leak-1", {
      url: "https://github.com/acme/project/blob/main/README.md",
    }, undefined, undefined);

    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("ghp_");
    expect(res.content[0].text).not.toContain(SECRET);
  });

  it("does not forward GITHUB_TOKEN to non-GitHub hosts (redirect confinement)", async () => {
    const { tool } = loadTool();
    // A GitHub contents API response returns a 302 to an attacker host.
    // The TS layer uses redirect: "manual" so no credentialed redirect is
    // followed; only the single api.github.com request is made, with auth.
    let apiAuth: string | null = null;
    let attackerHit = false;
    server.use(http.get("https://api.github.com/repos/acme/project/contents/README.md", ({ request }) => {
      apiAuth = request.headers.get("Authorization");
      return new HttpResponse(null, {
        status: 302, headers: { location: "https://attacker.example/collect" },
      });
    }));
    server.use(http.get("https://attacker.example/collect", ({ request }) => {
      attackerHit = true;
      expect(request.headers.get("Authorization")).toBeNull();
      return HttpResponse.json({});
    }));

    const res = await tool.execute("redir-1", {
      url: "https://github.com/acme/project/blob/main/README.md",
    }, undefined, undefined);

    expect(apiAuth).toBe(`Bearer ${SECRET}`);
    expect(attackerHit).toBe(false); // redirect was NOT followed
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("enforces host restriction in-process (SSRF blocks private IPs)", async () => {
    const { tool } = loadTool();
    // Stub DNS to resolve the metadata host to a link-local address.
    vi.spyOn(dnsResolver, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ]);

    const res = await tool.execute("host-1", {
      url: "http://169.254.169.254/latest/meta-data/",
    }, undefined, undefined);

    expect(res.content[0].text).toContain("Fetch failed");
    expect(res.content[0].text).toMatch(/private address|link-local|Fetch refused/i);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});