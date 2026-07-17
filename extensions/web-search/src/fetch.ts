/**
 * web-search: web-fetch helper (TypeScript port of scripts/fetch.py).
 *
 * Fetches HTTP(S) URLs, validates them against an SSRF guard, extracts
 * readable content (via representation.ts) or downloads binaries to a temp
 * file, and returns a structured JSON response.
 *
 * Phase 2 parallel-then-cut (#0009): built alongside the live Python
 * (`scripts/fetch.py`), imported directly only by its vitest twin. `index.ts`
 * keeps shelling out to Python until the final cut.
 *
 * Fidelity bar (map): the `FetchResponse`/`ExtractedDocument` shape and the
 * *behaviours* must hold — SSRF private-IP blocking (all six IP-range
 * categories), URL scheme/credential validation, redirect re-validation,
 * content-type gating (text vs download allowlist), byte-size cap, binary
 * download to temp file with sha1-named path, raw mode, truncation +
 * content-artifact propagation. Internals free reign. Tests assert shape +
 * behaviour, not byte-identical prose.
 *
 * Library stack (#0008):
 *   - HTTP: native `fetch` + `undici` (redirect follows, timeout via AbortSignal).
 *   - SSRF: hand-rolled `dns.promises.lookup` + `ipaddr.js` (all six categories).
 *   - Representation: reuses `./representation.ts`.
 *
 * GitHub routing (scripts/fetch.py's `classify` → tree/blob branch) is NOT
 * ported here — it lands in step 4/4 with `github.ts`, at which point a
 * `classify()` seam is wired into `fetchUrl`. The generic HTTP path + download
 * + raw are the fetch surface ported in this step.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import * as ipaddr from "ipaddr.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	categorizeContent,
	process as pipelineProcess,
	type OutputFormat,
} from "./representation.js";

// ---------------------------------------------------------------------------
// Public types — the "ExtractedDocument" / FetchResponse surface (map bar).
// ---------------------------------------------------------------------------

export interface FetchSuccess {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string | null;
	title: string | null;
	format: OutputFormat;
	content: string;
	truncated: boolean;
	contentLength: number;
	fetchedBytes: number;
	warnings: string[];
	sourceTruncated: boolean;
	contentArtifactPath?: string;
}

export interface FetchDownload {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string | null;
	path: string;
	fileName: string;
	byteSize: number;
	sha1: string;
	warnings: string[];
}

export interface FetchErrorResult {
	error: string;
	url: string;
	details?: Record<string, unknown>;
}

export type FetchResult = FetchSuccess | FetchDownload | FetchErrorResult;

export interface FetchOptions {
	/** Max chars of extracted content (default 30000, max 100000). */
	maxChars?: number;
	/** Output format (default "markdown"). Ignored when raw/download. */
	format?: "markdown" | "text";
	/** Request timeout in seconds (default 20). */
	timeout?: number;
	/** Max fetch bytes (default 5 MiB). */
	maxBytes?: number;
	/** Return raw decoded source, skip extraction. Mutually exclusive with download. */
	raw?: boolean;
	/** Download the binary body to a temp file and return its path. */
	download?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Binary types accepted only in download mode. */
const SUPPORTED_DOWNLOAD_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/bmp",
	"image/tiff",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"application/pdf",
]);

/** Canonical file extensions for download temp files. */
const DOWNLOAD_EXTENSIONS: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/tiff": ".tiff",
	"image/x-icon": ".ico",
	"image/vnd.microsoft.icon": ".ico",
	"application/pdf": ".pdf",
};

const USER_AGENT =
	"pi-web-fetch/0.1 " +
	"(+https://github.com/earendil-works/pi-coding-agent; like curl/8.0)";

const ACCEPT_HEADER =
	"text/html, application/xhtml+xml, text/plain, " +
	"text/markdown, application/json, application/xml, text/xml;q=0.9, */*;q=0.1";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FetchError extends Error {
	details: Record<string, unknown>;
	constructor(message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.details = details;
	}
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

const privateHostCache = new Map<string, boolean>();

/** Mockable DNS resolver. Tests replace `dnsResolver.lookup` to control SSRF
 * outcomes without touching real DNS. */
export const dnsResolver = {
	async lookup(hostname: string): Promise<{ address: string; family: number }[]> {
		return await dnsLookup(hostname, { all: true });
	},
};

/**
 * Check if hostname resolves to a private/local IP.
 * Returns `[isPrivate, reason]`. All six IP-range categories are checked
 * (loopback, private, link-local, multicast, unspecified, reserved) — direct
 * port of fetch.py's is_private_or_local_address.
 */
export async function isPrivateOrLocalAddress(
	hostname: string,
): Promise<[boolean, string]> {
	const cached = privateHostCache.get(hostname);
	if (cached !== undefined) return [cached, ""];

	let addrinfos: Awaited<ReturnType<typeof dnsLookup>>[];
	try {
		// all() returns every resolved address (IPv4 + IPv6); Python's getaddrinfo
		// returns the same set. We check each one.
		addrinfos = await dnsResolver.lookup(hostname);
	} catch (exc: any) {
		privateHostCache.set(hostname, true);
		return [true, `DNS resolution failed: ${exc?.message ?? exc}`];
	}

	for (const { address } of addrinfos) {
		let ip: ipaddr.IPv4 | ipaddr.IPv6;
		try {
			ip = ipaddr.parse(address);
		} catch {
			continue;
		}
		const range = ip.range();
		if (range === "loopback") {
			privateHostCache.set(hostname, true);
			return [true, `Host resolves to loopback address: ${address}`];
		}
		if (range === "private") {
			privateHostCache.set(hostname, true);
			return [true, `Host resolves to private address: ${address}`];
		}
		if (range === "linkLocal") {
			privateHostCache.set(hostname, true);
			return [true, `Host resolves to link-local address: ${address}`];
		}
		if (range === "multicast") {
			privateHostCache.set(hostname, true);
			return [true, `Host resolves to multicast address: ${address}`];
		}
		if (range === "unspecified") {
			privateHostCache.set(hostname, true);
			return [true, `Host resolves to unspecified address: ${address}`];
		}
		if (range === "reserved") {
			privateHostCache.set(hostname, true);
			return [true, `Host resolves to reserved address: ${address}`];
		}
	}

	privateHostCache.set(hostname, false);
	return [false, ""];
}

/** Reset the SSRF cache (test helper). */
export function _resetSsrfCache(): void {
	privateHostCache.clear();
}

/**
 * Validate URL scheme/format/SSRF, returning the parsed URL or throwing
 * FetchError. Direct port of fetch.py's validate_url.
 */
export async function validateUrl(url: string): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (exc: any) {
		throw new FetchError("Invalid URL format", {
			url,
			detail: exc?.message ?? String(exc),
		});
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new FetchError(
			`Unsupported URL scheme: '${parsed.protocol.replace(/:$/, "")}'. Only http and https are allowed.`,
			{ url, scheme: parsed.protocol },
		);
	}

	const host = parsed.hostname;
	if (!host) throw new FetchError("URL has no hostname", { url });

	// Embedded credentials.
	if (parsed.username || parsed.password) {
		throw new FetchError(
			"URL contains embedded credentials (username:password). Refusing to fetch.",
			{ url },
		);
	}

	const [isPrivate, reason] = await isPrivateOrLocalAddress(host);
	if (isPrivate) {
		throw new FetchError(`Fetch refused: ${reason}`, { url, host });
	}

	return parsed;
}

// ---------------------------------------------------------------------------
// HTTP fetching
// ---------------------------------------------------------------------------

interface RawFetchResult {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string | null;
	body: Buffer;
	fetchedBytes: number;
}

/**
 * Fetch URL and return response metadata + body bytes.
 *
 * mode="text" (default): reject responses whose Content-Type is not HTML or
 *   text-like.
 * mode="download": reject responses whose Content-Type is not in the binary
 *   download allowlist.
 *
 * Streams the body with a size limit (direct port of fetch.py's fetch_response).
 */
export async function fetchResponse(
	url: string,
	timeout: number,
	maxBytes: number,
	mode: "text" | "download" = "text",
): Promise<RawFetchResult> {
	const parsed = await validateUrl(url);
	const urlStr = parsed.toString();

	const controller = new AbortController();
	const timeoutMs = timeout * 1000;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([controller.signal, timeoutSignal]);

	let response: Response;
	try {
		response = await fetch(urlStr, {
			redirect: "follow",
			signal,
			headers: {
				"User-Agent": USER_AGENT,
				Accept: ACCEPT_HEADER,
			},
		});
	} catch (exc: any) {
		throw new FetchError(`Fetch failed: ${exc?.message ?? String(exc)}`, {
			url: urlStr,
		});
	}

	const finalUrl = response.url || urlStr;
	if (finalUrl !== urlStr) {
		// Re-validate final URL after redirects (SSRF via redirect).
		await validateUrl(finalUrl);
	}

	const contentType = response.headers.get("content-type");

	let allowed: boolean;
	let unsupportedMsg: string;
	if (mode === "download") {
		allowed = isDownloadSupported(contentType);
		unsupportedMsg =
			`Content type '${contentType ?? "unknown"}' is not supported in download mode. ` +
			`Allowed: ${[...SUPPORTED_DOWNLOAD_TYPES].sort()}`;
	} else {
		const category = categorizeContent(contentType);
		allowed = category !== "unsupported";
		unsupportedMsg = `Unsupported content type: ${contentType ?? "unknown"}`;
	}

	if (!allowed) {
		throw new FetchError(unsupportedMsg, {
			url: urlStr,
			finalUrl,
			statusCode: response.status,
			contentType,
		});
	}

	// Stream body with a size limit.
	const reader = response.body?.getReader();
	if (!reader) {
		throw new FetchError("Response has no readable body", {
			url: urlStr,
			finalUrl,
			statusCode: response.status,
			contentType,
		});
	}
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			controller.abort();
			throw new FetchError(
				`Response exceeds maximum fetch size (${maxBytes} bytes)`,
				{ url: urlStr, finalUrl, statusCode: response.status, contentType, maxBytes },
			);
		}
		chunks.push(Buffer.from(value));
	}
	const body = Buffer.concat(chunks);

	return {
		url: urlStr,
		finalUrl,
		statusCode: response.status,
		contentType,
		body,
		fetchedBytes: totalBytes,
	};
}

// ---------------------------------------------------------------------------
// Content categorization helpers
// ---------------------------------------------------------------------------

export function isDownloadSupported(contentType: string | null): boolean {
	if (!contentType) return false;
	const mediaType = contentType.split(";")[0].trim().toLowerCase();
	return SUPPORTED_DOWNLOAD_TYPES.has(mediaType);
}

export function isBinaryContent(data: Buffer | Uint8Array): boolean {
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
	// 1. Cannot decode as UTF-8 → binary.
	let text: string;
	try {
		text = buf.toString("utf-8");
	} catch {
		return true;
	}
	// 2. Null bytes present → binary.
	return text.includes("\x00");
}

export function mediaTypeOf(contentType: string | null): string | null {
	if (!contentType) return null;
	return contentType.split(";")[0].trim().toLowerCase() || null;
}

export function extensionFor(contentType: string | null, url: string): string {
	const mediaType = mediaTypeOf(contentType);
	if (mediaType && mediaType in DOWNLOAD_EXTENSIONS) {
		return DOWNLOAD_EXTENSIONS[mediaType];
	}
	let urlPath = "";
	try {
		urlPath = new URL(url).pathname;
	} catch {
		urlPath = "";
	}
	const urlExt = path.extname(urlPath).toLowerCase();
	if (urlExt && urlExt.length <= 6 && /^[\x00-\x7f]+$/.test(urlExt)) {
		return urlExt;
	}
	if (mediaType) {
		const guessed = mimeExtensionFor(mediaType);
		if (guessed) return guessed;
	}
	return ".bin";
}

/** Minimal mimetypes.guess_extension equivalent for the download allowlist. */
function mimeExtensionFor(mediaType: string): string | null {
	return DOWNLOAD_EXTENSIONS[mediaType] ?? null;
}

export function isSupportedContentType(contentType: string | null): boolean {
	return categorizeContent(contentType) !== "unsupported";
}

// ---------------------------------------------------------------------------
// JSON response builders
// ---------------------------------------------------------------------------

export function downloadJson(args: {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string | null;
	path: string;
	fileName: string;
	byteSize: number;
	sha1: string;
	warnings: string[];
}): FetchDownload {
	return {
		url: args.url,
		finalUrl: args.finalUrl,
		statusCode: args.statusCode,
		contentType: args.contentType,
		path: args.path,
		fileName: args.fileName,
		byteSize: args.byteSize,
		sha1: args.sha1,
		warnings: args.warnings,
	};
}

export function successJson(args: {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string | null;
	title: string | null;
	outputFormat: OutputFormat;
	content: string;
	truncated: boolean;
	fetchedBytes: number;
	warnings: string[];
	contentArtifactPath?: string | null;
	sourceTruncated?: boolean;
}): FetchSuccess {
	const result: FetchSuccess = {
		url: args.url,
		finalUrl: args.finalUrl,
		statusCode: args.statusCode,
		contentType: args.contentType,
		title: args.title,
		format: args.outputFormat,
		content: args.content,
		truncated: args.truncated,
		contentLength: args.content.length,
		fetchedBytes: args.fetchedBytes,
		warnings: args.warnings,
		sourceTruncated: args.sourceTruncated ?? false,
	};
	if (args.contentArtifactPath) result.contentArtifactPath = args.contentArtifactPath;
	return result;
}

export function errorJson(
	message: string,
	url: string,
	details?: Record<string, unknown>,
): FetchErrorResult {
	const result: FetchErrorResult = { error: message, url };
	if (details && Object.keys(details).length) result.details = details;
	return result;
}

// ---------------------------------------------------------------------------
// Download path
// ---------------------------------------------------------------------------

/**
 * Download a binary response to a temp file and return its metadata.
 * Raises FetchError on validation/HTTP/MIME/size failures; never writes a
 * partial file. Direct port of fetch.py's run_download.
 */
export async function runDownload(
	url: string,
	timeout: number,
	maxBytes: number,
): Promise<FetchDownload> {
	const fetchResult = await fetchResponse(url, timeout, maxBytes, "download");
	const { finalUrl, statusCode, contentType, body, fetchedBytes } = fetchResult;

	if (!body.length) {
		throw new FetchError("Response body was empty; nothing to download.", {
			url,
			finalUrl,
			statusCode,
			contentType,
		});
	}

	// SHA-1 as a content address for the temp file name; not for security.
	const sha1 = crypto.createHash("sha1").update(body).digest("hex");
	const extension = extensionFor(contentType, finalUrl);
	const fileName = `web-fetch-${sha1.slice(0, 12)}${extension}`;
	const targetPath = path.join(os.tmpdir(), fileName);

	// Refuse to clobber an unrelated file at the same path.
	if (fs.existsSync(targetPath) && fs.statSync(targetPath).size !== body.length) {
		throw new FetchError(
			`Refusing to overwrite existing file at ${targetPath} with different content.`,
			{ url, path: targetPath },
		);
	}

	fs.writeFileSync(targetPath, body);

	const warnings: string[] = [];
	if (statusCode && statusCode >= 400) {
		warnings.push(
			`HTTP ${statusCode} — saved body anyway, but the response is an error page.`,
		);
	}

	return downloadJson({
		url,
		finalUrl,
		statusCode,
		contentType,
		path: targetPath,
		fileName,
		byteSize: body.length,
		sha1,
		warnings,
	});
}

// ---------------------------------------------------------------------------
// Main entry point — the exposed seam index.ts will call at the final cut.
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and extract readable content (or download a binary).
 *
 * Direct port of fetch.py's `main()` minus the GitHub routing branch, which
 * lands in step 4/4 with github.ts. Behaviour:
 *   - raw + download mutually exclusive → errorJson
 *   - download → runDownload
 *   - else → fetchResponse (text mode) → representation pipeline → successJson
 *   - effective format: "raw" when raw, else format (default "markdown")
 *
 * Errors are returned as `errorJson` (never thrown to the caller), matching
 * the Python `main()`'s try/except FetchError → JSON envelope contract.
 */
export async function fetchUrl(
	url: string,
	opts: FetchOptions = {},
): Promise<FetchResult> {
	const maxChars = opts.maxChars ?? 30_000;
	const format = opts.format ?? "markdown";
	const timeout = opts.timeout ?? 20;
	const maxBytes = opts.maxBytes ?? 5_242_880;

	try {
		if (opts.raw && opts.download) {
			throw new FetchError(
				"raw and download are mutually exclusive. " +
					"Use either raw (return decoded source) or download (save to file), not both.",
				{ url },
			);
		}

		// TODO(step 4/4): GitHub routing — classify(url) → tree/blob branch.
		// For now the generic HTTP path handles all URLs.

		if (opts.download) {
			return await runDownload(url, timeout, maxBytes);
		}

		const fetchResult = await fetchResponse(url, timeout, maxBytes);

		const effectiveFormat: OutputFormat = opts.raw ? "raw" : format;

		const pipeline = pipelineProcess({
			body: fetchResult.body,
			contentType: fetchResult.contentType,
			url: fetchResult.url,
			outputFormat: opts.raw ? "text" : effectiveFormat,
			maxChars,
			raw: opts.raw,
		});

		return successJson({
			url: fetchResult.url,
			finalUrl: fetchResult.finalUrl,
			statusCode: fetchResult.statusCode,
			contentType: fetchResult.contentType,
			title: pipeline.title,
			outputFormat: effectiveFormat,
			content: pipeline.content,
			truncated: pipeline.truncated,
			fetchedBytes: fetchResult.fetchedBytes,
			warnings: pipeline.warnings,
			contentArtifactPath: pipeline.contentArtifactPath,
			sourceTruncated: pipeline.sourceTruncated,
		});
	} catch (exc) {
		if (exc instanceof FetchError) {
			return errorJson(exc.message, url, exc.details);
		}
		const e = exc as Error;
		return errorJson(e?.message ?? String(exc), url);
	}
}