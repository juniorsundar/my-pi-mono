/**
 * vitest twin of scripts/tests/test_representation.py — ports the pytest suite
 * for representation.ts (the TS port of scripts/representation.py).
 *
 * Phase 2 parallel-then-cut (#0009): both pytest (in .venv) and vitest (root)
 * run until the final cut. This file is the direct port of the pytest spec.
 *
 * Fidelity bar: shape + behaviour, not byte-identical prose — the readability
 * library differs (@mozilla/readability + linkedom vs readability-lxml +
 * BeautifulSoup), so extracted text/markdown is asserted by substring/shape,
 * matching the pytest suite's own assertions (which already use `in`/`not in`
 * rather than exact equality for HTML-derived content).
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	process,
	categorizeContent,
	decodeBody,
	normalizeWhitespace,
	truncate,
	type PipelineResult,
} from "./representation.ts";

const FIXTURE_ARTICLE_HTML = `<html>
<head><title>Test README</title></head>
<body>
<nav>Site Menu</nav>
<article>
<h1>Project Name</h1>
<p>Description of the project.</p>
<h2>Getting Started</h2>
<p>Run the following:</p>
<pre><code>npm install</code></pre>
<h2>Configuration</h2>
<p>Edit your config.</p>
</article>
<footer>Site Footer</footer>
</body>
</html>`;

// Track artifact files created during tests so we can clean them up.
const createdArtifacts: string[] = [];
afterEach(() => {
	for (const p of createdArtifacts.splice(0)) {
		try {
			fs.rmSync(p, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

function run(opts: {
	body: Buffer | Uint8Array;
	contentType: string | null;
	url: string;
	outputFormat: "markdown" | "text" | "raw";
	maxChars: number;
	sourceTruncated?: boolean;
	raw?: boolean;
}): PipelineResult {
	const r = process(opts);
	if (r.contentArtifactPath) createdArtifacts.push(r.contentArtifactPath);
	return r;
}

// ===========================================================================
// Tracer bullet: process() returns a PipelineResult
// ===========================================================================

describe("process() tracer bullet", () => {
	it("returns a PipelineResult with decoded content", () => {
		const r = run({
			body: Buffer.from("hello world"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r).toBeTruthy();
		expect(typeof r.content).toBe("string");
		expect(r.contentLength).toBe(r.content.length);
	});
});

// ===========================================================================
// Text-like extraction
// ===========================================================================

describe("text-like extraction", () => {
	it("preserves plain text", () => {
		const r = run({
			body: Buffer.from("Just plain text."),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toBe("Just plain text.");
	});

	it("pretty-prints JSON", () => {
		const r = run({
			body: Buffer.from('{"b":1,"a":2}'),
			contentType: "application/json",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		// pretty-printed with 2-space indent
		expect(r.content).toContain('"b": 1');
		expect(r.content).toContain('"a": 2');
		expect(r.content).toContain("\n");
	});

	it("falls back to raw text for invalid JSON with a warning", () => {
		const r = run({
			body: Buffer.from("not valid json"),
			contentType: "application/json",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toBe("not valid json");
		expect(r.warnings.length).toBeGreaterThan(0);
		expect(r.warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
	});

	it("preserves XML", () => {
		const xml = "<root><item>value</item></root>";
		const r = run({
			body: Buffer.from(xml),
			contentType: "application/xml",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toContain("<root>");
		expect(r.content).toContain("value");
	});
});

// ===========================================================================
// HTML extraction (semantic container first, readability fallback)
// ===========================================================================

describe("HTML extraction", () => {
	it("semantic container extracts headings into markdown", () => {
		const r = run({
			body: Buffer.from(FIXTURE_ARTICLE_HTML, "utf-8"),
			contentType: "text/html; charset=utf-8",
			url: "https://example.com/readme",
			outputFormat: "markdown",
			maxChars: 100_000,
		});
		expect(r.content).toContain("# Project Name");
		expect(r.content).toContain("## Getting Started");
		expect(r.content).toContain("## Configuration");
		expect(r.content).toContain("npm install");
		expect(r.content).toContain("Description of the project");
		// site chrome stripped
		expect(r.content).not.toContain("Site Menu");
		expect(r.content).not.toContain("Site Footer");
	});

	it("extracts title from <title>", () => {
		const r = run({
			body: Buffer.from(FIXTURE_ARTICLE_HTML, "utf-8"),
			contentType: "text/html; charset=utf-8",
			url: "https://example.com/readme",
			outputFormat: "markdown",
			maxChars: 100_000,
		});
		expect(r.title).toBe("Test README");
	});

	it("falls back to readability when no semantic container", () => {
		const html = Buffer.from(
			`<html><head><title>Blog Post</title></head><body><div class="post"><h1>My Blog Post</h1><p>Some interesting content here.</p></div></body></html>`,
		);
		const r = run({
			body: html,
			contentType: "text/html; charset=utf-8",
			url: "https://example.com/blog",
			outputFormat: "markdown",
			maxChars: 100_000,
		});
		expect(r.content).not.toBeNull();
		expect(r.content.length).toBeGreaterThan(0);
	});

	it("falls back to readability when article is too short", () => {
		const html = Buffer.from(
			`<html><head><title>Test</title></head><body><article><p>Hi</p></article></body></html>`,
		);
		const r = run({
			body: html,
			contentType: "text/html; charset=utf-8",
			url: "https://example.com/test",
			outputFormat: "markdown",
			maxChars: 100_000,
		});
		expect(r.content).not.toBeNull();
		expect(r.content.length).toBeGreaterThan(0);
	});
});

// ===========================================================================
// Encoding detection
// ===========================================================================

describe("encoding detection", () => {
	it("defaults to UTF-8 when no charset", () => {
		const r = run({
			body: Buffer.from("café résumé", "utf-8"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toBe("café résumé");
	});

	it("respects explicit utf-8 charset", () => {
		const r = run({
			body: Buffer.from("café", "utf-8"),
			contentType: "text/plain; charset=utf-8",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toBe("café");
	});

	it("respects latin1 charset", () => {
		const r = run({
			body: Buffer.from("café", "latin1"),
			contentType: "text/plain; charset=iso-8859-1",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toBe("café");
	});

	it("falls back on wrong charset", () => {
		// bytes are valid utf-8 but we claim ascii; toString('ascii') still
		// decodes the low bytes, so the result is non-empty.
		const r = run({
			body: Buffer.from("hello", "utf-8"),
			contentType: "text/plain; charset=ascii",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toBe("hello");
	});

	it("falls back on unknown charset (LookupError path)", () => {
		const r = run({
			body: Buffer.from("café", "utf-8"),
			contentType: "text/plain; charset=bogus-charset",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		// unknown charset → utf-8 fallback
		expect(r.content).toBe("café");
	});
});

// ===========================================================================
// Truncation
// ===========================================================================

describe("truncation", () => {
	it("does not truncate short content", () => {
		const r = run({
			body: Buffer.from("Short text."),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.content).toBe("Short text.");
		expect(r.truncated).toBe(false);
	});

	it("truncates long content with a message", () => {
		const body = "A".repeat(2000);
		const r = run({
			body: Buffer.from(body, "utf-8"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 1000,
		});
		expect(r.truncated).toBe(true);
		expect(r.content).toContain("Content truncated");
		expect(r.content.length).toBeLessThan(2000);
	});

	it("appends the standard truncation notice", () => {
		const body = "A".repeat(2000);
		const r = run({
			body: Buffer.from(body, "utf-8"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 1000,
		});
		expect(r.content).toContain("[... Content truncated at 1000 characters.");
		expect(r.content).toContain("Total document length: 2000 characters.");
		expect(r.content).toContain("Use --max-chars to increase limit up to 100,000.");
	});

	it("clamps maxChars below 1000 to 1000", () => {
		const body = "A".repeat(5000);
		const r = run({
			body: Buffer.from(body, "utf-8"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100, // below minimum
		});
		// clamped to 1000: the notice names 1000, not 100
		expect(r.content).toContain("truncated at 1000 characters");
		expect(r.content.length).toBeLessThan(2000);
	});
});

// ===========================================================================
// Metadata propagation
// ===========================================================================

describe("metadata propagation", () => {
	it("title propagates for HTML", () => {
		const r = run({
			body: Buffer.from(
				"<html><head><title>My Page</title></head><body><article><p>Content</p></article></body></html>",
			),
			contentType: "text/html",
			url: "https://example.com",
			outputFormat: "markdown",
			maxChars: 100_000,
		});
		expect(r.title).toBe("My Page");
	});

	it("title is null for text content", () => {
		const r = run({
			body: Buffer.from("Just text"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.title).toBeNull();
	});

	it("contentLength matches content", () => {
		const body = "Hello, world! ".repeat(10);
		const r = run({
			body: Buffer.from(body, "utf-8"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.contentLength).toBe(r.content.length);
	});

	it("warnings propagate from extraction", () => {
		const r = run({
			body: Buffer.from("not valid json"),
			contentType: "application/json",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.warnings.length).toBeGreaterThan(0);
		expect(r.warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
	});
});

// ===========================================================================
// Content artifact
// ===========================================================================

describe("content artifact", () => {
	it("writes an artifact with the full content when truncated", () => {
		const textLine = "Line of text for the content artifact test. ";
		const body = Buffer.from(textLine.repeat(200), "utf-8"); // ~10k chars
		const r = run({
			body,
			contentType: "text/plain",
			url: "https://example.com/long.txt",
			outputFormat: "text",
			maxChars: 5000,
		});
		expect(r.truncated).toBe(true);
		expect(r.contentArtifactPath).not.toBeNull();
		expect(fs.existsSync(r.contentArtifactPath!)).toBe(true);

		const full = run({
			body,
			contentType: "text/plain",
			url: "https://example.com/long.txt",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(full.truncated).toBe(false);

		const artifactContent = fs.readFileSync(r.contentArtifactPath!, "utf-8");
		expect(artifactContent).toBe(full.content);
		expect(artifactContent.length).toBeGreaterThan(r.content.length);

		// in the system temp directory
		expect(r.contentArtifactPath!.startsWith(os.tmpdir())).toBe(true);
	});

	it("creates no artifact when not truncated", () => {
		const r = run({
			body: Buffer.from("Short content that fits.", "utf-8"),
			contentType: "text/plain",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
		});
		expect(r.truncated).toBe(false);
		expect(r.contentArtifactPath).toBeNull();
	});

	it("writes the artifact into the system temp directory with the prefix", () => {
		const textLine = "Line of text for temp directory test. ";
		const body = Buffer.from(textLine.repeat(200), "utf-8");
		const r = run({
			body,
			contentType: "text/plain",
			url: "https://example.com/temp-test.txt",
			outputFormat: "text",
			maxChars: 1000,
		});
		expect(r.truncated).toBe(true);
		expect(r.contentArtifactPath).not.toBeNull();
		expect(r.contentArtifactPath!.startsWith(os.tmpdir())).toBe(true);
		const dirName = path.basename(path.dirname(r.contentArtifactPath!));
		expect(dirName.startsWith("pi-web-fetch-")).toBe(true);
		expect(fs.existsSync(r.contentArtifactPath!)).toBe(true);
		fs.rmSync(r.contentArtifactPath!, { recursive: true, force: true });
		expect(fs.existsSync(r.contentArtifactPath!)).toBe(false);
	});
});

// ===========================================================================
// sourceTruncated flag (independent of truncated)
// ===========================================================================

describe("sourceTruncated flag", () => {
	it("both flags false when content fits and no source truncation", () => {
		const r = run({
			body: Buffer.from("short content"),
			contentType: "text/plain",
			url: "https://example.com/",
			outputFormat: "text",
			maxChars: 100_000,
			sourceTruncated: false,
		});
		expect(r.truncated).toBe(false);
		expect(r.sourceTruncated).toBe(false);
	});

	it("truncated=true, sourceTruncated=false when preview cut but source complete", () => {
		const textLine = "Line of text for the source-truncated test. ";
		const r = run({
			body: Buffer.from(textLine.repeat(200), "utf-8"),
			contentType: "text/plain",
			url: "https://example.com/",
			outputFormat: "text",
			maxChars: 1000,
			sourceTruncated: false,
		});
		expect(r.truncated).toBe(true);
		expect(r.sourceTruncated).toBe(false);
	});

	it("sourceTruncated=true when source was cut but preview fits", () => {
		const r = run({
			body: Buffer.from("short content"),
			contentType: "text/plain",
			url: "https://example.com/",
			outputFormat: "text",
			maxChars: 100_000,
			sourceTruncated: true,
		});
		expect(r.truncated).toBe(false);
		expect(r.sourceTruncated).toBe(true);
	});

	it("both flags true when preview and source are both truncated", () => {
		const textLine = "Line of text for both-truncated test. ";
		const r = run({
			body: Buffer.from(textLine.repeat(200), "utf-8"),
			contentType: "text/plain",
			url: "https://example.com/",
			outputFormat: "text",
			maxChars: 1000,
			sourceTruncated: true,
		});
		expect(r.truncated).toBe(true);
		expect(r.sourceTruncated).toBe(true);
	});
});

// ===========================================================================
// Content artifact format
// ===========================================================================

describe("content artifact format", () => {
	it("uses .md extension for markdown output", () => {
		const textLine = "Line of text for format test. ";
		const r = run({
			body: Buffer.from(textLine.repeat(200), "utf-8"),
			contentType: "text/markdown",
			url: "https://example.com/test.md",
			outputFormat: "markdown",
			maxChars: 1000,
		});
		expect(r.truncated).toBe(true);
		expect(r.contentArtifactPath).not.toBeNull();
		expect(r.contentArtifactPath!.endsWith(".md")).toBe(true);
	});

	it("uses .txt extension for text output", () => {
		const textLine = "Line of text for format test. ";
		const r = run({
			body: Buffer.from(textLine.repeat(200), "utf-8"),
			contentType: "text/plain",
			url: "https://example.com/test.txt",
			outputFormat: "text",
			maxChars: 1000,
		});
		expect(r.truncated).toBe(true);
		expect(r.contentArtifactPath).not.toBeNull();
		expect(r.contentArtifactPath!.endsWith(".txt")).toBe(true);
	});
});

// ===========================================================================
// Raw mode
// ===========================================================================

describe("raw mode", () => {
	it("bypasses extraction and returns decoded source as-is", () => {
		const rawHtml = Buffer.from(
			"<html><body><h1>Hello</h1><p>World</p></body></html>",
		);
		const r = run({
			body: rawHtml,
			contentType: "text/html",
			url: "https://example.com",
			outputFormat: "markdown",
			maxChars: 100_000,
			raw: true,
		});
		expect(r.content).toContain("<h1>Hello</h1>");
		expect(r.content).toContain("<html>");
		expect(r.title).toBeNull();
		expect(r.truncated).toBe(false);
		expect(r.warnings).toEqual([]);
	});

	it("ignores the outputFormat parameter when raw=true", () => {
		const rawHtml = Buffer.from("<html><body><h1>Same</h1></body></html>");
		const md = run({
			body: rawHtml,
			contentType: "text/html",
			url: "https://example.com",
			outputFormat: "markdown",
			maxChars: 100_000,
			raw: true,
		});
		const txt = run({
			body: rawHtml,
			contentType: "text/html",
			url: "https://example.com",
			outputFormat: "text",
			maxChars: 100_000,
			raw: true,
		});
		expect(md.content).toBe(txt.content);
		expect(md.content).toContain("<h1>Same</h1>");
		expect(md.title).toBeNull();
		expect(txt.title).toBeNull();
	});

	it("truncates raw output with an artifact (same pipeline as readable)", () => {
		const longLine = "<p>" + "x".repeat(100) + "</p>";
		const body = Buffer.from(
			"<html><body>" + longLine.repeat(30) + "</body></html>",
			"utf-8",
		);
		const r = run({
			body,
			contentType: "text/html",
			url: "https://example.com",
			outputFormat: "markdown",
			maxChars: 500,
			raw: true,
		});
		expect(r.truncated).toBe(true);
		expect(r.contentArtifactPath).not.toBeNull();
		expect(fs.existsSync(r.contentArtifactPath!)).toBe(true);
		const artifactContent = fs.readFileSync(r.contentArtifactPath!, "utf-8");
		expect(artifactContent).toContain("<html>");
		expect(artifactContent.length).toBeGreaterThan(r.content.length);
	});
});

// ===========================================================================
// Unit: exported helpers (shape parity)
// ===========================================================================

describe("categorizeContent", () => {
	it.each([
		["text/html", "html"],
		["text/html; charset=utf-8", "html"],
		["application/xhtml+xml", "html"],
		["text/plain", "text_like"],
		["text/markdown", "text_like"],
		["application/json", "text_like"],
		["application/xml", "text_like"],
		["text/xml", "text_like"],
		["image/png", "unsupported"],
		["", "unsupported"],
	] as const)("categorizes %s as %s", (ct, expected) => {
		expect(categorizeContent(ct || null)).toBe(expected);
	});
});

describe("normalizeWhitespace", () => {
	it("collapses excessive blank lines and trims trailing whitespace", () => {
		// Python keeps up to 2 blank lines: 3 blank lines -> 2 (so 'a\n\n\nb').
		expect(normalizeWhitespace("a  \n\n\n\nb\n\n")).toBe("a\n\n\nb");
	});
	it("strips leading/trailing blank lines", () => {
		expect(normalizeWhitespace("\n\nhi\n\n")).toBe("hi");
	});
});

describe("truncate", () => {
	it("clamps maxChars to [1000, 100000]", () => {
		const [, t1] = truncate("A".repeat(5000), 100);
		expect(t1).toBe(true);
	});
	it("returns content unchanged when under the limit", () => {
		const [c, t] = truncate("short", 100_000);
		expect(c).toBe("short");
		expect(t).toBe(false);
	});
});