/**
 * web-search: representation pipeline (TypeScript port of scripts/representation.py).
 *
 * The pipeline accepts fetched bytes and a representation mode, then returns
 * source metadata, the available representation, a bounded content preview,
 * completeness flags, warnings, and an optional content artifact path.
 *
 * This is a deep module: it hides decoding, readability extraction, character
 * truncation, and the distinction between preview and source truncation behind
 * one interface (`process`).
 *
 * Phase 2 parallel-then-cut (#0009): built alongside the live Python
 * (`scripts/representation.py`), imported directly only by its vitest twin.
 * `index.ts` keeps shelling out to Python until the final cut.
 *
 * Fidelity bar (map): the exported `PipelineResult` shape (the "ExtractedDocument"
 * surface) and the *behaviours* must hold — content categorization, decoding,
 * semantic-container-then-readability extraction, truncation with the standard
 * notice, temp-file artifact on truncation, source_truncated independence, raw
 * mode. Internals are free reign: a different readability library
 * (`@mozilla/readability` + `linkedom` per #0008/#0011) extracting slightly
 * different prose is acceptable; the consumer is an LLM, not a diff. The TS
 * test suite asserts shape + behaviour, not byte-identical prose.
 *
 * Library stack (#0008/#0011):
 *   - HTML parse + readability: `@mozilla/readability` + `linkedom` (PRIMARY);
 *     `cheerio` would be fallback if a real limitation surfaces (#0011 passed).
 *   - HTML→markdown: `turndown` (ATX headings + `-` bullets, matching
 *     markdownify's config).
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import * as Turndown from "turndown";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public types — the exported "ExtractedDocument" surface (map fidelity bar).
// ---------------------------------------------------------------------------

export type OutputFormat = "markdown" | "text" | "raw";
export type ContentCategory = "html" | "text_like" | "unsupported";

export interface PipelineResult {
	/** Extracted document title, if available. */
	title: string | null;
	/** The representation content (preview or full). */
	content: string;
	/** Whether content was truncated due to max_chars limit. */
	truncated: boolean;
	/** Path to a temp file holding the full representation, or null if no truncation. */
	contentArtifactPath: string | null;
	/** Whether the source itself was truncated by a transport/upstream limit. */
	sourceTruncated: boolean;
	/** Non-fatal warnings from the pipeline. */
	warnings: string[];
	/** Length of `content`; kept in sync (mirrors the Python @property). */
	readonly contentLength: number;
}

export interface ProcessOptions {
	body: Buffer | Uint8Array;
	contentType: string | null;
	url: string;
	outputFormat: OutputFormat;
	maxChars: number;
	sourceTruncated?: boolean;
	/** If true, skip extraction and return the decoded body as-is (outputFormat ignored). */
	raw?: boolean;
}

// ---------------------------------------------------------------------------
// Content-type helpers
// ---------------------------------------------------------------------------

const SUPPORTED_HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const SUPPORTED_TEXT_TYPES = new Set(["text/plain", "text/markdown"]);
const SUPPORTED_DATA_TYPES = new Set([
	"application/json",
	"application/xml",
	"text/xml",
]);

export function categorizeContent(contentType: string | null): ContentCategory {
	if (!contentType) return "unsupported";
	const mediaType = contentType.split(";")[0].trim().toLowerCase();
	if (SUPPORTED_HTML_TYPES.has(mediaType)) return "html";
	if (SUPPORTED_TEXT_TYPES.has(mediaType) || SUPPORTED_DATA_TYPES.has(mediaType))
		return "text_like";
	return "unsupported";
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

export function decodeBody(
	body: Buffer | Uint8Array,
	contentType: string | null,
): string {
	let charset = "utf-8";
	if (contentType) {
		for (const part of contentType.split(";")) {
			const p = part.trim();
			if (p.toLowerCase().startsWith("charset=")) {
				charset = p.slice(8).trim().replace(/^['"]|['"]$/g, "");
				break;
			}
		}
	}
	const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
	const nodeEncoding = toNodeEncoding(charset);
	try {
		return buf.toString(nodeEncoding);
	} catch {
		// Invalid bytes for the declared encoding, or an encoding node still
		// can't handle — fall back to utf-8 with replacement (Python's
		// `body.decode("utf-8", errors="replace")`).
		return buf.toString("utf-8");
	}
}

/** Map common IANA charset labels to Node's BufferEncoding names. */
function toNodeEncoding(charset: string): BufferEncoding {
	const c = charset.trim().toLowerCase().replace(/_/g, "-");
	if (c === "utf-8" || c === "utf8" || c === "us-ascii" || c === "ascii") return "utf-8";
	if (c === "iso-8859-1" || c === "latin1" || c === "iso8859-1" || c === "iso_8859-1") {
		return "latin1";
	}
	if (c === "utf-16le" || c === "utf-16" || c === "utf16") return "utf-16le";
	if (c === "base64") return "base64";
	if (c === "hex") return "hex";
	// Unknown — return as-is; toString() will fall back via the try/catch above.
	return c as BufferEncoding;
}

// ---------------------------------------------------------------------------
// HTML extraction — semantic container helpers
// ---------------------------------------------------------------------------

const SEMANTIC_STRIP_TAGS = ["script", "style", "noscript", "nav", "form", "button"];
const ANCHOR_CLASSES = new Set(["anchor", "headerlink", "header-anchor"]);
const ANCHOR_GLYPHS = new Set(["#", "¶", "§"]);

/** Block-level tags whose children should be separated by newlines in text. */
const BLOCK_TAGS = new Set([
	"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "br", "pre",
	"blockquote", "article", "section", "header", "footer", "nav", "ul", "ol",
	"table", "tbody", "thead", "dl", "dt", "dd", "figure", "figcaption", "address",
]);

function isElement(node: ChildNode): node is Element {
	return node.nodeType === 1;
}

function findMainContainer(document: Document): Element | null {
	// linkedom Document supports querySelector.
	for (const selector of ["article", "main"]) {
		const el = document.querySelector(selector);
		if (el) return el;
	}
	return document.querySelector('[role="main"]');
}

/** Extract text with a newline separator between block boundaries (BS4 get_text(separator="\n")). */
function getTextWithSeparator(node: Element, separator = "\n"): string {
	let out = "";
	const walk = (n: Node): void => {
		for (const child of Array.from(n.childNodes)) {
			if (child.nodeType === 3) {
				// text node
				out += child.textContent ?? "";
			} else if (isElement(child as ChildNode)) {
				const el = child as Element;
				walk(el);
				if (BLOCK_TAGS.has(el.tagName.toLowerCase())) out += separator;
			}
		}
	};
	walk(node);
	return out;
}

function extractTitle(document: Document, container: Element | null): string | null {
	const headTitle = document.querySelector("title");
	if (headTitle) {
		const text = (headTitle.textContent ?? "").trim();
		if (text) return text;
	}
	if (container) {
		const heading = container.querySelector("h1,h2,h3,h4,h5,h6");
		if (heading) {
			const text = (heading.textContent ?? "").trim();
			if (text) return text;
		}
	}
	return null;
}

function stripBoilerplate(container: Element): void {
	for (const tag of SEMANTIC_STRIP_TAGS) {
		for (const el of Array.from(container.querySelectorAll(tag))) {
			el.remove();
		}
	}
}

function stripAnchorLinks(container: Element): void {
	for (const a of Array.from(container.querySelectorAll("a"))) {
		const text = (a.textContent ?? "").trim();
		if (text === "" || ANCHOR_GLYPHS.has(text)) {
			a.remove();
			continue;
		}
		const classAttr = a.getAttribute("class") ?? "";
		const classes = new Set(classAttr.split(/\s+/).filter(Boolean));
		for (const c of classes) {
			if (ANCHOR_CLASSES.has(c)) {
				a.remove();
				break;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// HTML extraction — readability fallback
// ---------------------------------------------------------------------------

function extractViaReadability(
	htmlText: string,
	url: string,
	outputFormat: OutputFormat,
): [string | null, string, string[]] {
	const warnings: string[] = [];
	const { document } = parseHTML(htmlText);
	const article = new Readability(document).parse();
	const title = article?.title ?? null;
	const summaryHtml = article?.content ?? "";

	// Clean the readability summary the same way the Python path does.
	const { document: summaryDoc } = parseHTML(
		`<div>${summaryHtml}</div>`,
	);
	const wrap = summaryDoc.querySelector("div")!;
	for (const tag of ["script", "style", "noscript", "nav", "footer", "header"]) {
		for (const el of Array.from(wrap.querySelectorAll(tag))) el.remove();
	}
	const readableHtml = wrap.innerHTML;
	const extractedText = getTextWithSeparator(wrap)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
		.join("\n");

	let finalText = extractedText;
	if (extractedText.trim().length < 50) {
		warnings.push(
			"Readability extraction returned very little content; " +
				"page may require JavaScript. Falling back to raw HTML text.",
		);
		const { document: fullDoc } = parseHTML(htmlText);
		for (const tag of ["script", "style", "noscript"]) {
			for (const el of Array.from(fullDoc.querySelectorAll(tag))) el.remove();
		}
		const body = fullDoc.querySelector("body");
		finalText = (body ? getTextWithSeparator(body) : getTextWithSeparator(fullDoc.body ?? fullDoc.documentElement!))
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.join("\n");
	}

	let content: string;
	if (outputFormat === "markdown") {
		try {
			const td = new Turndown.default({ headingStyle: "atx", bulletListMarker: "-" });
			let md = td.turndown(readableHtml);
			md = normalizeWhitespace(md);
			if (md.trim().length < 50) {
				warnings.push(
					"Markdown conversion produced minimal output; falling back to plain text.",
				);
				content = finalText;
			} else {
				content = md;
			}
		} catch (exc: any) {
			warnings.push(`Markdown conversion failed: ${exc?.message ?? exc}; using plain text.`);
			content = finalText;
		}
	} else {
		content = finalText;
	}

	return [title, normalizeWhitespace(content), warnings];
}

// ---------------------------------------------------------------------------
// HTML extraction — main entry point
// ---------------------------------------------------------------------------

function extractHtml(
	htmlText: string,
	url: string,
	outputFormat: OutputFormat,
): [string | null, string, string[]] {
	const warnings: string[] = [];
	const { document } = parseHTML(htmlText);

	const container = findMainContainer(document);
	let useReadability = false;

	let extractedText = "";
	let workingContainer: Element | null = null;

	if (container) {
		// Clone so we can strip in place without touching the original doc.
		const clone = container.cloneNode(true) as Element;
		stripBoilerplate(clone);
		stripAnchorLinks(clone);
		workingContainer = clone;
		extractedText = getTextWithSeparator(clone)
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.join("\n");
		if (extractedText.trim().length < 50) {
			warnings.push(
				"Semantic container contained very little text; " +
					"falling back to readability extraction.",
			);
			useReadability = true;
		}
	} else {
		useReadability = true;
	}

	if (useReadability) {
		return extractViaReadability(htmlText, url, outputFormat);
	}

	const title = extractTitle(document, workingContainer);

	let content: string;
	if (outputFormat === "markdown") {
		try {
			const td = new Turndown.default({ headingStyle: "atx", bulletListMarker: "-" });
			let md = td.turndown(workingContainer!.outerHTML);
			md = normalizeWhitespace(md);
			if (md.trim().length < 50) {
				warnings.push(
					"Markdown conversion produced minimal output; falling back to plain text.",
				);
				content = extractedText;
			} else {
				content = md;
			}
		} catch (exc: any) {
			warnings.push(`Markdown conversion failed: ${exc?.message ?? exc}; using plain text.`);
			content = extractedText;
		}
	} else {
		content = extractedText;
	}

	return [title, normalizeWhitespace(content), warnings];
}

// ---------------------------------------------------------------------------
// Text-like extraction
// ---------------------------------------------------------------------------

function extractTextLike(
	text: string,
	contentType: string | null,
	outputFormat: OutputFormat,
): [string | null, string, string[]] {
	const warnings: string[] = [];
	let content = text;
	const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();

	if (mediaType === "application/json") {
		try {
			const parsed = JSON.parse(text);
			content = JSON.stringify(parsed, null, 2);
		} catch {
			content = text;
			warnings.push(
				"Content type is JSON but body is not valid JSON; returning raw text.",
			);
		}
	}

	if (mediaType === "application/xml" || mediaType === "text/xml") {
		content = normalizeWhitespace(text);
	}

	if (mediaType === "text/markdown" && outputFormat === "text") {
		// Python wraps in <pre>{text}</pre> and extracts text: strips markdown
		// syntax down to its text. We mimic by parsing a pre and reading text.
		const { document } = parseHTML(`<pre>${escapeHtml(text)}</pre>`);
		const pre = document.querySelector("pre")!;
		content = (pre.textContent ?? "").trim();
	}

	return [null, normalizeWhitespace(content), warnings];
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

export function normalizeWhitespace(text: string): string {
	const lines = text.split(/\r?\n/);
	const result: string[] = [];
	let blankCount = 0;
	for (const line of lines) {
		const stripped = line.replace(/\s+$/, "");
		if (stripped) {
			result.push(stripped);
			blankCount = 0;
		} else {
			blankCount += 1;
			if (blankCount <= 2) result.push("");
		}
	}
	while (result.length && result[0] === "") result.shift();
	while (result.length && result[result.length - 1] === "") result.pop();
	return result.join("\n");
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

export function truncate(text: string, maxChars: number): [string, boolean] {
	const limit = Math.max(1_000, Math.min(maxChars, 100_000));
	if (text.length <= limit) return [text, false];
	let cut = text.slice(0, limit);
	const lastNewline = cut.lastIndexOf("\n");
	if (lastNewline > limit / 2) cut = text.slice(0, lastNewline);
	cut +=
		`\n\n[... Content truncated at ${limit} characters. ` +
		`Total document length: ${text.length} characters. ` +
		`Use --max-chars to increase limit up to 100,000.]`;
	return [cut, true];
}

// ---------------------------------------------------------------------------
// Content artifact
// ---------------------------------------------------------------------------

function writeContentArtifact(fullContent: string, outputFormat: OutputFormat): string {
	const suffix = outputFormat === "markdown" ? ".md" : ".txt";
	const prefix = "pi-web-fetch-";
	// mkstemp equivalent: unique temp path with the right suffix.
	const dir = os.tmpdir();
	let tmpPath = "";
	// node:fs.mkdtempSync gives a unique dir; place a file inside it.
	const uniqueDir = fs.mkdtempSync(path.join(dir, prefix));
	tmpPath = path.join(uniqueDir, `content${suffix}`);
	fs.writeFileSync(tmpPath, fullContent, "utf-8");
	return tmpPath;
}

// ---------------------------------------------------------------------------
// Public API: process()
// ---------------------------------------------------------------------------

export function process(opts: ProcessOptions): PipelineResult {
	const { body, contentType, url, outputFormat, maxChars, sourceTruncated = false, raw = false } = opts;

	// 1. Decode bytes to string.
	const text = decodeBody(body, contentType);

	// 2. Categorize and extract.
	let title: string | null = null;
	let warnings: string[] = [];
	let content: string;

	if (raw) {
		title = null;
		warnings = [];
		content = text;
	} else {
		const category = categorizeContent(contentType);
		if (category === "html") {
			[title, content, warnings] = extractHtml(text, url, outputFormat);
		} else {
			[title, content, warnings] = extractTextLike(text, contentType, outputFormat);
		}
	}

	// 3. Save full content before truncation.
	const fullContent = content;

	// 4. Truncate.
	const [truncatedContent, truncated] = truncate(content, maxChars);

	// 5. Write content artifact if truncated.
	let contentArtifactPath: string | null = null;
	if (truncated) {
		contentArtifactPath = writeContentArtifact(fullContent, outputFormat);
	}

	return {
		title,
		content: truncatedContent,
		truncated,
		contentArtifactPath,
		sourceTruncated,
		warnings,
		get contentLength() {
			return truncatedContent.length;
		},
	};
}