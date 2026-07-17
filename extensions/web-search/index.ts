import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	search as runSearchInternal,
	fetchUrl as fetchUrlInternal,
	writeContentArtifact,
	type OutputFormat,
} from "./src/index.js";

interface SearchResult {
	title: string;
	href: string;
	body: string;
	publishedDate?: string;
	engines?: string[];
}

interface SearchResponse {
	results?: SearchResult[];
	answers?: string[];
	corrections?: string[];
	suggestions?: string[];
	error?: string;
}

interface FetchResponse {
	url?: string;
	finalUrl?: string;
	statusCode?: number;
	contentType?: string;
	title?: string;
	format?: "markdown" | "text" | "raw";
	content?: string;
	truncated?: boolean;
	contentLength?: number;
	fetchedBytes?: number;
	warnings?: string[];
	contentArtifactPath?: string;
	sourceTruncated?: boolean;
	error?: string;
	details?: Record<string, unknown>;
	data?: unknown;
	path?: string;
	fileName?: string;
	byteSize?: number;
	sha1?: string;
}

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query string" }),
	maxResults: Type.Optional(
		Type.Number({ description: "Maximum results (1-20, default 10)", minimum: 1, maximum: 20 }),
	),
	categories: Type.Optional(
		StringEnum(["general", "it", "news", "science", "files", "social media"] as const, {
			description: "Search category filter. Use 'general' for broad, 'it' for code/tech, 'news' for recent news, 'science' for academic, 'files' for downloads, 'social media' for community discussions. Default 'general'.",
		}),
	),
	language: Type.Optional(
		StringEnum(["all", "en", "de", "fr", "es", "pt", "zh", "ja", "ko", "ar", "ru"] as const, {
			description: "Language filter. SearXNG uses ISO codes. Default 'all'.",
		}),
	),
	safesearch: Type.Optional(
		StringEnum(["on", "moderate", "off"] as const, {
			description: "SafeSearch level: on, moderate, off. Default moderate.",
		}),
	),
	timelimit: Type.Optional(
		StringEnum(["d", "w", "m", "y"] as const, {
			description: "Time limit: d (day), w (week), m (month), y (year). Omit for any time.",
		}),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "HTTP(S) URL to fetch and extract readable content from" }),
	prompt: Type.Optional(Type.String({
		description: "Optional question about the fetched document for the agent to answer",
	})),
	maxChars: Type.Optional(Type.Number({
		description: "Maximum characters of extracted content to return (1000-100000, default 30000)",
		minimum: 1000,
		maximum: 100000,
	})),
	format: Type.Optional(StringEnum(["markdown", "text"] as const, {
		description: "Output format for readable content (default markdown). Ignored when raw is true.",
	})),
	raw: Type.Optional(
		Type.Boolean({
			description: "If true, return the raw source text (HTML, JSON, etc.) without readability extraction. Default: false.",
			default: false,
		}),
	),
	download: Type.Optional(
		Type.Boolean({
			description:
				"If true, save the fetched binary file (image, PDF, etc.) to a local temporary " +
				"path and return its path instead of extracting readable text. Pass the returned " +
				"path to the read tool to view the file with a multimodal model. Default: false.",
			default: false,
		}),
	),
});

const EXTENSION_DIR = __dirname;

function getSettingsPath(): string {
	const home = process.env.HOME || "";
	return home ? path.join(home, ".pi", "agent", "settings.json") : "";
}

function getSearxngUrl(): string {
	const settingsPath = getSettingsPath();
	if (!settingsPath || !fs.existsSync(settingsPath)) {
		throw new Error(
			"searxng.url is not configured. " +
			"Add \"searxng\": { \"url\": \"http://your-searxng:8080\" } to settings.json.",
		);
	}
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
	} catch {
		throw new Error("Cannot parse settings.json; check for JSON syntax errors.");
	}
	const searxng = settings.searxng as Record<string, unknown> | undefined;
	const url = searxng?.url;
	if (!url || typeof url !== "string") {
		throw new Error(
			"searxng.url is not configured. " +
			"Add \"searxng\": { \"url\": \"http://your-searxng:8080\" } to settings.json.",
		);
	}
	return url;
}

function clampMaxResults(value: number | undefined): number {
	if (!Number.isFinite(value)) return 10;
	return Math.max(1, Math.min(20, Math.trunc(value ?? 10)));
}

async function runSearch(
	pi: ExtensionAPI,
	params: {
		query: string;
		maxResults?: number;
		language?: string;
		categories?: string;
		safesearch?: "on" | "moderate" | "off";
		timelimit?: "d" | "w" | "m" | "y";
	},
	signal?: AbortSignal,
	timeoutMs = 20_000,
): Promise<SearchResponse> {
	let searxngUrl: string;
	try {
		searxngUrl = getSearxngUrl();
	} catch (error: any) {
		return { error: error?.message ?? String(error) };
	}

	// In-process call to the TS port (final cut, #0009). Previously this
	// shelled out to `uv run --project . python scripts/search.py`.
	try {
		return await runSearchInternal(searxngUrl, {
			query: params.query,
			maxResults: clampMaxResults(params.maxResults),
			language: params.language,
			categories: params.categories,
			safesearch: params.safesearch,
			timelimit: params.timelimit,
		}, { signal, timeoutMs });
	} catch (error: any) {
		return { error: error?.message ?? String(error) };
	}
}

function formatResults(response: SearchResponse): string {
	if (response.error) return `Search failed: ${response.error}`;

	const parts: string[] = [];

	// Enrichment fields (answers, corrections, suggestions)
	if (response.answers?.length) {
		parts.push("**Answers:**");
		for (const answer of response.answers) {
			parts.push(`- ${answer}`);
		}
	}
	if (response.corrections?.length) {
		parts.push("**Spell corrections:**");
		for (const correction of response.corrections) {
			parts.push(`- ${correction}`);
		}
	}
	if (response.suggestions?.length) {
		parts.push("**Suggestions:**");
		for (const suggestion of response.suggestions) {
			parts.push(`- ${suggestion}`);
		}
	}

	if (response.results?.length) {
		const lines = response.results
			.map((result, index) => {
				const title = result.title || "Untitled";
				const href = result.href || "No URL";
				const body = result.body || "No snippet";
				let text = `${index + 1}. **${title}**\n   ${href}\n   ${body}`;
				if (result.publishedDate) {
					text += `\n   Published: ${result.publishedDate}`;
				}
				if (result.engines?.length) {
					text += `\n   Engines: ${result.engines.join(", ")}`;
				}
				return text;
			})
			.join("\n\n");
		parts.push(lines);
	} else if (!response.answers?.length && !response.corrections?.length && !response.suggestions?.length) {
		parts.push("No results found.");
	}

	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Inline preview threshold for fetched content.
 *
 * Downstream layers (pi core tool-result handling / provider proxies) cap
 * tool-result text well below our own 30,000-char limit — observed at
 * ~2000 chars, cut mid-word with a `[truncated]` marker. To stay safely
 * under that cap regardless of where it lives, content longer than this is
 * never inlined into the tool result. Instead we write the full content to
 * a temp artifact and emit a short preview + path, letting the agent page
 * through the rest with the read tool (which chunks at 2000 lines / 50KB
 * and is not subject to the tool-result cap).
 */
const INLINE_PREVIEW_CHARS = 1500;

function clampMaxChars(value: number | undefined): number {
	if (!Number.isFinite(value)) return 30_000;
	return Math.max(1_000, Math.min(100_000, Math.trunc(value ?? 30_000)));
}

function normalFetchedFormat(value: unknown): "markdown" | "text" {
	if (value === "markdown" || value === "text") return value;
	return "markdown";
}

async function runFetch(
	pi: ExtensionAPI,
	params: {
		url: string;
		maxChars?: number;
		format?: "markdown" | "text";
		download?: boolean;
		raw?: boolean;
	},
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<FetchResponse> {
	// In-process call to the TS port (final cut, #0009). Previously this
	// shelled out to `uv run --project . python scripts/fetch.py`.
	try {
		return await fetchUrlInternal(params.url, {
			maxChars: clampMaxChars(params.maxChars),
			format: normalFetchedFormat(params.format ?? "markdown"),
			raw: params.raw === true,
			download: params.download === true,
			timeout: Math.round((timeoutMs ?? (params.download ? 60_000 : 30_000)) / 1000),
		}) as FetchResponse;
	} catch (error: any) {
		return {
			error: error?.message ?? String(error),
			url: params.url,
		};
	}
}

function formatFetchResult(response: FetchResponse, prompt?: string): string {
	if (response.error) return `Fetch failed: ${response.error}`;

	// Download mode: emit a short "saved to" notice instead of the full
	// "# Fetched document" preamble. The path is what the caller needs to act on.
	if (response.path) {
		const parts: string[] = [];
		parts.push("# Downloaded file\n");
		parts.push(`**Source:** ${response.url || "unknown"}`);
		if (response.finalUrl && response.finalUrl !== response.url) {
			parts.push(`**Final URL:** ${response.finalUrl}`);
		}
		parts.push(`**Status:** ${response.statusCode ?? "?"}`);
		if (response.contentType) parts.push(`**Content-Type:** ${response.contentType}`);
		parts.push(`**Saved to:** \`${response.path}\``);
		if (response.fileName) parts.push(`**File name:** \`${response.fileName}\``);
		if (typeof response.byteSize === "number") {
			parts.push(`**Size:** ${response.byteSize} bytes`);
		}
		if (response.sha1) parts.push(`**SHA-1:** \`${response.sha1}\``);
		if (response.warnings?.length) {
			parts.push("**Warnings:**");
			for (const w of response.warnings) parts.push(`- ${w}`);
		}
		if (prompt) {
			parts.push("");
			parts.push(`**Prompt for this file:** ${prompt}`);
		}
		return parts.join("\n");
	}

	const parts: string[] = [];

	parts.push("# Fetched document\n");
	parts.push(`**Source:** ${response.url || "unknown"}`);
	if (response.finalUrl && response.finalUrl !== response.url) {
		parts.push(`**Final URL:** ${response.finalUrl}`);
	}
	if (response.title) parts.push(`**Title:** ${response.title}`);
	parts.push(`**Status:** ${response.statusCode ?? "?"}`);
	if (response.contentType) parts.push(`**Content-Type:** ${response.contentType}`);
	if (response.truncated) {
		parts.push(`**Truncated:** yes (${response.contentLength ?? "?"} chars of ${response.fetchedBytes ?? "?"} bytes fetched)`);
	}
	if (response.sourceTruncated) {
		parts.push(`**Source truncated:** yes (the upstream or transport limited the response)`);
	}
	if (response.contentArtifactPath) {
		parts.push(`**Content artifact:** \`${response.contentArtifactPath}\` (use the read tool to inspect omitted content)`);
	}
	if (response.warnings?.length) {
		parts.push("**Warnings:**");
		for (const w of response.warnings) parts.push(`- ${w}`);
	}

	if (prompt) {
		parts.push("");
		parts.push(`**Prompt for this document:** ${prompt}`);
	}

	if (response.content) {
		const content = response.content;
		// Always write large content to a temp artifact and emit only a short
		// preview inline. This keeps the tool result under the downstream
		// tool-result cap (~2000 chars) regardless of where it is enforced.
		// The agent pages through the full content via the read tool.
		if (content.length > INLINE_PREVIEW_CHARS) {
			const outputFormat: OutputFormat = response.format === "text" ? "text" : "markdown";
			let artifactPath = response.contentArtifactPath ?? "";
			if (!artifactPath) {
				try {
					artifactPath = writeContentArtifact(content, outputFormat);
				} catch {
					artifactPath = "";
				}
			}
			parts.push("");
			parts.push("## Preview");
			parts.push(content.slice(0, INLINE_PREVIEW_CHARS));
			parts.push(`\n[... preview truncated at ${INLINE_PREVIEW_CHARS} chars; full content is ${content.length} chars.]`);
			if (artifactPath) {
				parts.push(`**Full content:** \`${artifactPath}\` (use the read tool to inspect; pass offset/limit to page through).`);
			}
		} else {
			parts.push("");
			parts.push("## Content");
			parts.push(content);
		}
	}

	return parts.join("\n");
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using SearXNG (local multi-engine aggregator). Returns titles, URLs, and snippets. " +
			"Use for current facts, documentation, news, package versions, or information not in training data. " +
			"Supports categories (general, it, news, science, files, social media), language, safesearch, and time filters. " +
			"Results include enrichment fields: answers, corrections, suggestions, publication dates, and engine provenance. " +
			"Output is limited to 20 results.",
		promptSnippet: "Search the web via SearXNG and return titles, URLs, and snippets",
		promptGuidelines: [
			"Use web_search when you need current, factual, or documentation-related information not in your training data.",
			"Use web_search to find current package versions, official documentation URLs, news, or recent API changes.",
			"When using web_search results, include source URLs in your answer and prefer official or primary sources.",
			"Do not use web_search for questions about files in the repository or the current conversation history.",
			"Use web_fetch when the user provides a URL or after web_search discovers a relevant URL.",
			"Use web_search first when no URL is known yet.",
			"Use web_search to filter by category (it, news, science, files, social media) for targeted searches, or omit for general search.",
			"Use web_search with language filter to find results in a specific language when helping with locale-specific dependencies.",
			"When web_search returns answers (direct answer boxes), prefer those over fetching individual pages.",
			"When web_search returns corrections or suggestions, use them to refine your search strategy.",
		],
		parameters: WebSearchParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: `Searching web for: ${params.query}` }],
				details: { query: params.query },
			});

			const results = await runSearch(pi, {
				query: params.query,
				maxResults: params.maxResults,
				language: params.language,
				categories: params.categories,
				safesearch: params.safesearch,
				timelimit: params.timelimit,
			}, signal);

			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: {
					query: params.query,
					categories: params.categories,
					language: params.language,
					resultCount: results.results?.length ?? 0,
					raw: results,
				},
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch an HTTP(S) URL and extract readable document content as markdown." +
			" Use after web_search to read a specific URL." +
			" Returns source metadata (title, status, content-type), the extracted text," +
			" and a flag if the content was truncated." +
			" Accepts an optional prompt for the agent to answer about the document." +
			" Pass download=true to save a binary file (image, PDF) to a local temp path" +
			" instead of extracting text; the returned path can then be passed to the read tool." +
			" Pass raw=true to return the decoded source text (HTML, JSON, etc.) without extraction." +
			" Does not execute JavaScript; pages requiring JS may have incomplete content.",
		promptSnippet: "Fetch a URL and return readable document content with source metadata, or download a binary file to a local path, or return raw source with raw=true",
		promptGuidelines: [
			"Use web_fetch when the user provides a URL or after web_search discovers a relevant URL.",
			"Use web_search first when no URL is known yet.",
			"Cite the finalUrl (or source URL) when using fetched content.",
			"Note when content was truncated (truncated: true).",
			"Do not use web_fetch for files in the repository or the current conversation.",
			"Static fetch only; pages requiring JavaScript may have incomplete content.",
			"Use download=true for image and PDF URLs; the returned path can be passed to the read tool to view the file with a multimodal model.",
		],
		parameters: WebFetchParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: `Fetching URL: ${params.url}` }],
				details: { url: params.url },
			});

			const result = await runFetch(pi, {
				url: params.url,
				maxChars: params.maxChars,
				format: params.format,
				download: params.download,
				raw: params.raw,
			}, signal);

			return {
				content: [{ type: "text", text: formatFetchResult(result, params.prompt) }],
				details: {
					url: params.url,
					prompt: params.prompt,
					finalUrl: result.finalUrl,
					statusCode: result.statusCode,
					contentType: result.contentType,
					title: result.title,
					truncated: result.truncated,
					contentLength: result.contentLength,
					fetchedBytes: result.fetchedBytes,
					format: result.format,
					contentArtifactPath: result.contentArtifactPath,
					sourceTruncated: result.sourceTruncated,
					warnings: result.warnings,
					details: result.details,
					data: result.data,
					// Download-mode fields (only populated when download=true).
					path: result.path,
					fileName: result.fileName,
					byteSize: result.byteSize,
					sha1: result.sha1,
					raw: result,
				},
			};
		},
	});

	pi.registerCommand("web-search", {
		description: "Search the web via SearXNG: /web-search <query>",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /web-search <query>", "warning");
				return;
			}

			ctx.ui.notify(`Searching via SearXNG: ${query}`, "info");
			const results = await runSearch(pi, { query }, ctx.signal);
			const text = formatResults(results);

			pi.sendMessage(
				{
					customType: "web-search-results",
					content: `### Web search results for: "${query}"\n\n${text}`,
					display: true,
					details: { query, resultCount: results.results?.length ?? 0, raw: results },
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("web-fetch", {
		description: "Fetch a URL: /web-fetch <url> [--max-chars N] [--format markdown|text] [--raw] [--download]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /web-fetch <url> [--max-chars N] [--format markdown|text] [--raw] [--download]", "warning");
				return;
			}

			// Simple arg parsing for the command
			const parts = trimmed.split(/\s+/);
			const url = parts.find((p) => p.startsWith("http://") || p.startsWith("https://")) || parts[0];
			const maxIdx = parts.indexOf("--max-chars");
			const maxChars = maxIdx >= 0 ? parseInt(parts[maxIdx + 1], 10) || undefined : undefined;
			const fmtIdx = parts.indexOf("--format");
			const format = fmtIdx >= 0 && parts[fmtIdx + 1] === "text" ? "text" as const : undefined;
			const download = parts.indexOf("--download") >= 0;
			const raw = parts.indexOf("--raw") >= 0;

			ctx.ui.notify(`Fetching: ${url}`, "info");
			const result = await runFetch(pi, { url, maxChars, format, download, raw }, ctx.signal);
			const text = formatFetchResult(result);

			pi.sendMessage(
				{
					customType: "web-fetch-result",
					content: text,
					display: true,
					details: {
						url,
						finalUrl: result.finalUrl,
						statusCode: result.statusCode,
						contentArtifactPath: result.contentArtifactPath,
						sourceTruncated: result.sourceTruncated,
						warnings: result.warnings,
						details: result.details,
						data: result.data,
						path: result.path,
						fileName: result.fileName,
						byteSize: result.byteSize,
						sha1: result.sha1,
						raw: result,
					},
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Fire-and-forget SearXNG connectivity probe — does not block session.
		(async () => {
			let searxngUrl: string;
			try {
				searxngUrl = getSearxngUrl();
			} catch (error: any) {
				ctx.ui.notify(
					`web-search: SearXNG not configured: ${error?.message ?? String(error)}`,
					"warning",
				);
				return;
			}

			try {
				// In-process connectivity probe (final cut, #0009). Previously
				// this shelled out to `uv run ... scripts/search.py`.
				await runSearchInternal(searxngUrl, {
					query: "health check",
					maxResults: 1,
				}, { timeoutMs: 15_000 });
			} catch (error: any) {
				ctx.ui.notify(
					`web-search: SearXNG unreachable at ${searxngUrl}: ${error?.message ?? String(error)}`,
					"error",
				);
			}
		})();
	});
}
