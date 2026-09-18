/**
 * web-search: GitHub URL classification and API fetch (TypeScript port of
 * scripts/github.py).
 *
 * Classifies github.com URLs into resource families (repository_root, tree,
 * blob, or non-specialized), resolves ambiguous refs against the GitHub API,
 * fetches structured resources (tree, blob content, repo metadata) via the
 * REST API, and renders trees to markdown/text.
 *
 * Phase 2 parallel-then-cut (#0009): built alongside the live Python
 * (`scripts/github.py`), imported by `fetch.ts` (the classify seam) and its
 * vitest twin. `index.ts` keeps shelling out to Python until the final cut.
 *
 * Fidelity bar (map): shape + behaviour on the exposed surface.
 *   - classify: same URL patterns (github.com/www.github.com, owner/repo,
 *     /tree/<ref>/<path>, /blob/<ref>/<path>, .git suffix strip), same
 *     GitHubResource/NonSpecialized shapes.
 *   - resolve_ref: commit-SHA short-circuit; longest-prefix branch then tag
 *     probes; path_remainder semantics.
 *   - fetch_github_resource/tree/blob_content: same success/error envelope
 *     shapes; rate-limit detail extraction; JSON media-type validation;
 *     base64 decode for blobs; recursive git/trees fetch; subdirectory
 *     filtering; lexicographic sort; 2000-entry bound; source-truncation
 *     union; canonical JSON preservation.
 *   - render_tree: markdown and text formats, identical heading/list shape.
 *
 * Library stack (#0008): native `fetch` (no GitHub SDK). HTTP mocked in tests
 * via msw. Auth header resolution reads GITHUB_TOKEN from the environment.
 */

import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types — the GitHubResource / NonSpecialized surface.
// ---------------------------------------------------------------------------

export type ResourceType = "repository_root" | "tree" | "blob";

export interface GitHubResource {
	type: ResourceType;
	owner: string;
	repo: string;
	ref: string | null;
	path: string | null;
}

export interface NonSpecialized {
	url: string;
	reason: string;
}

export type Classified = GitHubResource | NonSpecialized;

export function isGitHubResource(c: Classified): c is GitHubResource {
	return (c as GitHubResource).type !== undefined;
}

// ---------------------------------------------------------------------------
// URL classification — port of github.py classify().
// ---------------------------------------------------------------------------

export function classify(url: string): Classified {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { url, reason: "invalid URL" };
	}

	const host = parsed.hostname;
	if (!host) return { url, reason: "no hostname" };
	if (host !== "github.com" && host !== "www.github.com") {
		return { url, reason: `unrecognised host: ${host}` };
	}

	const rawPath = parsed.pathname.replace(/\/+$/, "");
	// Minimum path: /<owner>/<repo>
	const rawSegments = rawPath.split("/").filter((s) => s.length > 0);
	if (rawSegments.length < 2) {
		return { url, reason: "path too short for owner/repo" };
	}

	const owner = decodeURIComponent(rawSegments[0]);
	const repo = decodeURIComponent(rawSegments[1]).replace(/\.git$/, "");

	if (rawSegments.length === 2) {
		return { type: "repository_root", owner, repo, ref: null, path: null };
	}

	// 3+ segments: check the third segment.
	const resourceIndicator = rawSegments[2];

	if (resourceIndicator === "tree" || resourceIndicator === "blob") {
		// Heuristic: first segment after tree/blob is the ref, remaining
		// segments are the path.
		const ref = rawSegments.length > 3 ? decodeURIComponent(rawSegments[3]) : null;
		const pathSegments = rawSegments.slice(4).map((s) => decodeURIComponent(s));
		const repoPath = pathSegments.length > 0 ? pathSegments.join("/") : null;
		const resourceType: ResourceType = resourceIndicator === "tree" ? "tree" : "blob";
		return {
			type: resourceType,
			owner,
			repo,
			ref,
			path: repoPath,
		};
	}

	return { url, reason: "unrecognised URL pattern" };
}

// ---------------------------------------------------------------------------
// Ref resolution — port of github.py resolve_ref().
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

/** Regex for a full 40-character hex commit SHA. */
const SHA_RE = /^[0-9a-f]{40}$/i;

export interface ResolvedRef {
	ref: string;
	pathRemainder: string | null;
}

/** Generate all prefixes of *ref* from longest to shortest. */
function prefixes(ref: string): string[] {
	const parts = ref.split("/");
	return Array.from({ length: parts.length }, (_, i) =>
		parts.slice(0, i + 1).join("/"),
	).reverse();
}

/** Return the portion of *fullRef* after the resolved *ref* prefix. */
function pathRemainder(ref: string, fullRef: string): string | null {
	if (ref === fullRef) return null;
	const remainder = fullRef.slice(ref.length + 1); // +1 for the separating "/"
	return remainder.length > 0 ? remainder : null;
}

/** Resolve the effective GITHUB_TOKEN from explicit arg or environment. */
function resolveToken(token?: string | null): string | undefined {
	return token !== undefined && token !== null ? token : process.env.GITHUB_TOKEN;
}

/** Build request headers, optionally adding GITHUB_TOKEN auth. */
function ghHeaders(token?: string | null): Record<string, string> {
	const effective = resolveToken(token);
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "pi-agent/1.0",
	};
	if (effective) headers.Authorization = `Bearer ${effective}`;
	return headers;
}

/**
 * Resolve an ambiguous GitHub ref string against the GitHub API.
 *
 * If the entire *fullRef* starts with a valid 40-character commit SHA, the
 * SHA is used immediately without API calls. Otherwise, each prefix of
 * *fullRef* (longest first) is tried as a branch name, then as a tag name.
 * The longest valid ref wins.
 *
 * Throws Error if *fullRef* cannot be resolved.
 */
export async function resolveRef(
	owner: string,
	repo: string,
	fullRef: string,
	token?: string | null,
): Promise<ResolvedRef> {
	const resolvedToken = resolveToken(token);
	const headers = ghHeaders(resolvedToken);

	// --- Short-circuit: commit SHA ---
	const sha = fullRef.slice(0, 40);
	if (SHA_RE.test(sha)) {
		return { ref: sha, pathRemainder: pathRemainder(sha, fullRef) };
	}

	const candidates = prefixes(fullRef);

	// --- Try branches ---
	for (const prefix of candidates) {
		const url = `${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(prefix)}`;
		const resp = await fetch(url, { headers, redirect: "manual" });
		if (resp.status === 200) {
			return { ref: prefix, pathRemainder: pathRemainder(prefix, fullRef) };
		}
	}

	// --- Try tags (via git ref API) ---
	for (const prefix of candidates) {
		const url = `${GITHUB_API}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(prefix)}`;
		const resp = await fetch(url, { headers, redirect: "manual" });
		if (resp.status === 200) {
			return { ref: prefix, pathRemainder: pathRemainder(prefix, fullRef) };
		}
	}

	throw new Error(`cannot resolve ref '${fullRef}' for ${owner}/${repo}`);
}

// ---------------------------------------------------------------------------
// Shared HTTP / error helpers
// ---------------------------------------------------------------------------

export interface GhError {
	error: string;
	url: string;
	details: Record<string, unknown>;
}

/** Build structured error details from an HTTP error response. */
function httpErrorDetails(
	statusCode: number,
	headers: Headers,
	authenticated: boolean,
): Record<string, unknown> {
	const details: Record<string, unknown> = { statusCode, authenticated };
	const remaining = headers.get("x-ratelimit-remaining");
	if (remaining !== null) {
		const n = Number(remaining);
		if (!Number.isNaN(n)) details.remaining = n;
	}
	const resetEpoch = headers.get("x-ratelimit-reset");
	if (resetEpoch !== null) {
		const n = Number(resetEpoch);
		if (!Number.isNaN(n)) details.resetAt = new Date(n * 1000).toISOString();
	}
	return details;
}

/** Reason phrase from the response; statusText can be empty (HTTP/2, mocks). */
function reasonPhrase(response: Response): string {
	return response.statusText || `HTTP ${response.status}`;
}

/** Build the GitHub API URL for a recognised resource. */
function buildApiUrl(resource: GitHubResource): string {
	if (resource.type === "repository_root") {
		return `${GITHUB_API}/repos/${resource.owner}/${resource.repo}`;
	}
	// tree and blob both use the contents API; differences are handled by
	// the caller based on the response shape.
	const repoPath = resource.path ?? "";
	let url = `${GITHUB_API}/repos/${resource.owner}/${resource.repo}/contents/${encodeURIComponent(repoPath)}`;
	if (resource.ref) {
		url += `?ref=${encodeURIComponent(resource.ref)}`;
	}
	return url;
}

// ---------------------------------------------------------------------------
// Shared GitHub API fetch — one request/error envelope for all API calls.
// ---------------------------------------------------------------------------

interface GhApiPayload {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string;
	data: unknown; // parsed API response (object | array)
}

/** Shared GitHub API GET: network/HTTP/media-type/JSON errors → GhError. */
async function ghApiFetch(
	url: string,
	apiUrl: string,
	token: string | undefined,
): Promise<GhApiPayload | GhError> {
	const authenticated = token !== undefined;

	let response: Response;
	try {
		response = await fetch(apiUrl, {
			headers: ghHeaders(token),
			redirect: "manual",
			signal: AbortSignal.timeout(20_000),
		});
	} catch (exc: any) {
		return {
			error: `GitHub API request failed: ${exc?.message ?? String(exc)}`,
			url,
			details: { authenticated },
		};
	}

	const finalUrl = response.url || apiUrl;

	if (response.status >= 400) {
		return {
			error: `GitHub API returned ${response.status}: ${reasonPhrase(response)}`,
			url,
			details: httpErrorDetails(response.status, response.headers, authenticated),
		};
	}

	const responseContentType = response.headers.get("content-type") ?? "";
	if (responseContentType && !responseContentType.toLowerCase().includes("json")) {
		return {
			error: `GitHub API returned unexpected media type: ${responseContentType}`,
			url,
			details: { authenticated },
		};
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		return {
			error: "GitHub API returned malformed JSON",
			url,
			details: { authenticated },
		};
	}

	return {
		url,
		finalUrl,
		statusCode: response.status,
		contentType: responseContentType || "application/json",
		data,
	};
}

/** Type guard for the GhError envelope shared by all GitHub fetchers. */
export function isGhError(
	r: GhApiPayload | GhTreeResult | GhBlobResult,
): r is GhError {
	return typeof (r as { error?: unknown }).error === "string";
}

// ---------------------------------------------------------------------------
// fetch_github_blob_content — Contents API, base64 decode.
// ---------------------------------------------------------------------------

export interface GhBlobSuccess {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string; // MIME guessed from file name
	name: string;
	size: number;
	data: Buffer; // decoded file bytes
}
export type GhBlobResult = GhBlobSuccess | GhError;

/** Minimal mimetypes.guess_type equivalent. Defers to the OS / known map. */
function guessType(name: string): string | null {
	// Node has no built-in mimetypes module; use the download allowlist for
	// the common binary types GitHub blobs hit (images, pdf), then a small
	// text map. Falls back to application/octet-stream at the caller.
	const ext = path.extname(name).toLowerCase();
	const map: Record<string, string> = {
		".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
		".html": "text/html", ".htm": "text/html", ".xml": "text/xml",
		".json": "application/json", ".csv": "text/csv", ".yaml": "text/yaml",
		".yml": "text/yaml", ".js": "text/javascript", ".ts": "text/typescript",
		".py": "text/x-python", ".sh": "text/x-shellscript", ".rst": "text/x-rst",
		".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
		".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
		".bmp": "image/bmp", ".tiff": "image/tiff", ".tif": "image/tiff",
		".ico": "image/x-icon", ".pdf": "application/pdf",
	};
	return map[ext] ?? null;
}

export async function fetchGithubBlobContent(
	url: string,
	token?: string | null,
): Promise<GhBlobResult> {
	const resolvedToken = resolveToken(token);
	const authenticated = resolvedToken !== undefined;

	const classified = classify(url);
	if (!isGitHubResource(classified)) {
		return {
			error: `Not a recognised GitHub resource: ${classified.reason}`,
			url,
			details: {},
		};
	}
	if (classified.type !== "blob") {
		return {
			error: `Unsupported resource type for blob content fetch: ${classified.type}`,
			url,
			details: {},
		};
	}

	const apiResult = await ghApiFetch(url, buildApiUrl(classified), resolvedToken);
	if (isGhError(apiResult)) return apiResult;
	const data = apiResult.data;

	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return {
			error: "GitHub API returned unexpected data shape for blob content",
			url,
			details: { authenticated },
		};
	}
	const obj = data as Record<string, unknown>;
	if (obj.encoding !== "base64" || typeof obj.content !== "string") {
		return {
			error: "GitHub API did not return base64-encoded content for blob URL",
			url,
			details: { authenticated },
		};
	}

	let decodedBytes: Buffer;
	try {
		decodedBytes = Buffer.from(obj.content, "base64");
	} catch (exc: any) {
		return {
			error: `Failed to decode base64 content from GitHub API: ${exc?.message ?? String(exc)}`,
			url,
			details: { authenticated },
		};
	}

	const name = typeof obj.name === "string" ? obj.name : "";
	const contentType = guessType(name) ?? "application/octet-stream";
	const size = typeof obj.size === "number" ? obj.size : decodedBytes.length;

	return {
		url,
		finalUrl: apiResult.finalUrl,
		statusCode: apiResult.statusCode,
		contentType,
		name,
		size,
		data: decodedBytes,
	};
}

// ---------------------------------------------------------------------------
// fetch_github_tree — git/trees API, recursive, sorted, bounded.
// ---------------------------------------------------------------------------

export interface TreeEntry {
	path: string;
	type: string;
	mode: string;
	sha: string;
}

export interface GhTreeData {
	owner: string;
	repo: string;
	ref: string;
	path: string | null;
	defaultBranch: string;
	entries: TreeEntry[];
	canonicalJson: string;
	totalCount: number;
	displayedCount: number;
	upstreamTruncated: boolean;
}

export interface GhTreeSuccess {
	url: string;
	finalUrl: string;
	statusCode: number;
	contentType: string;
	data: GhTreeData;
	warnings: string[];
	sourceTruncated: boolean;
}
export type GhTreeResult = GhTreeSuccess | GhError;

const ENTRY_BOUND = 2000;

export async function fetchGithubTree(
	url: string,
	token?: string | null,
): Promise<GhTreeResult> {
	const resolvedToken = resolveToken(token);
	const authenticated = resolvedToken !== undefined;

	const classified = classify(url);
	if (!isGitHubResource(classified)) {
		return {
			error: `Not a recognised GitHub resource: ${classified.reason}`,
			url,
			details: {},
		};
	}
	if (classified.type !== "repository_root" && classified.type !== "tree") {
		return {
			error: `Unsupported resource type for tree fetch: ${classified.type}`,
			url,
			details: {},
		};
	}

	const owner = classified.owner;
	const repo = classified.repo;

	// 2. Fetch repo metadata for default_branch.
	const repoApi = `${GITHUB_API}/repos/${owner}/${repo}`;
	const repoResult = await ghApiFetch(url, repoApi, resolvedToken);
	if (isGhError(repoResult)) return repoResult;
	const repoData = repoResult.data as { default_branch?: string };
	const defaultBranch: string = repoData?.default_branch ?? "main";
	const finalUrl = repoResult.finalUrl;

	// 3. Determine effective ref and path.
	let ref: string;
	let effectivePath: string | null;
	if (classified.type === "repository_root") {
		ref = defaultBranch;
		effectivePath = null;
	} else {
		// Tree URL: for slash-containing refs, resolve_ref is needed. The
		// full ref string is everything after /tree/ in the URL path.
		const parsed = new URL(url);
		const pathParts = parsed.pathname.replace(/\/+$/, "").split("/");
		// pathParts = ['', owner, repo, 'tree', ...]
		if (pathParts.length > 4) {
			const fullRefStr = pathParts.slice(4).map((s) => decodeURIComponent(s)).join("/");
			try {
				const resolved = await resolveRef(owner, repo, fullRefStr, resolvedToken);
				ref = resolved.ref;
				effectivePath = resolved.pathRemainder ?? null;
			} catch {
				// Fall back to classify's split.
				ref = classified.ref ?? defaultBranch;
				effectivePath = classified.path;
			}
		} else {
			ref = defaultBranch;
			effectivePath = null;
		}
	}

	// 4. Get commit SHA from the ref (handles branches, tags, and SHAs).
	const commitUrl = `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
	const commitResult = await ghApiFetch(url, commitUrl, resolvedToken);
	if (isGhError(commitResult)) return commitResult;
	const commitData = commitResult.data as { sha?: string };
	const commitSha: string | undefined = commitData?.sha;
	if (!commitSha) {
		return {
			error: "GitHub commit data missing SHA",
			url,
			details: { authenticated },
		};
	}

	// 5. Fetch recursive git tree.
	const treeUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`;
	const treeResult = await ghApiFetch(url, treeUrl, resolvedToken);
	if (isGhError(treeResult)) return treeResult;
	const treeData = treeResult.data as { truncated?: boolean; tree?: unknown[] };
	const upstreamTruncated: boolean = Boolean(treeData?.truncated);
	const rawEntries: any[] = Array.isArray(treeData?.tree) ? treeData.tree : [];

	// 6. Filter to requested subdirectory for tree URLs.
	let filtered: any[];
	if (effectivePath) {
		const prefix = effectivePath.replace(/\/+$/, "") + "/";
		filtered = rawEntries.filter((e) =>
			typeof e?.path === "string" && e.path.startsWith(prefix),
		);
	} else {
		filtered = [...rawEntries];
	}

	// 7. Sort lexicographically (deterministic ordering).
	filtered.sort((a, b) => {
		const ap = typeof a?.path === "string" ? a.path : "";
		const bp = typeof b?.path === "string" ? b.path : "";
		return ap < bp ? -1 : ap > bp ? 1 : 0;
	});

	// 8. Bound at 2,000 entries (after sorting — deterministic truncation).
	const boundTruncated = filtered.length > ENTRY_BOUND;
	if (boundTruncated) filtered = filtered.slice(0, ENTRY_BOUND);

	// 9. Source truncation: upstream OR local bound.
	const sourceTruncated = upstreamTruncated || boundTruncated;

	// Build canonical JSON from the original treeData (before filtering/bounding).
	const canonical = JSON.stringify(treeData);

	// Capture warnings.
	const warnings: string[] = [];
	if (upstreamTruncated) {
		warnings.push(
			"GitHub API returned a truncated tree. The displayed listing may be incomplete.",
		);
	}
	if (boundTruncated) {
		warnings.push(
			`Repository tree exceeds ${ENTRY_BOUND} entries. Showing the first ${ENTRY_BOUND} entries.`,
		);
	}

	return {
		url,
		finalUrl,
		statusCode: 200,
		contentType: "application/json",
		data: {
			owner,
			repo,
			ref,
			path: effectivePath,
			defaultBranch,
			entries: filtered as TreeEntry[],
			canonicalJson: canonical,
			totalCount: rawEntries.length,
			displayedCount: filtered.length,
			upstreamTruncated,
		},
		warnings,
		sourceTruncated,
	};
}

// ---------------------------------------------------------------------------
// Tree rendering — port of github.py render_tree().
// ---------------------------------------------------------------------------

export type RenderFormat = "markdown" | "text";

export function renderTree(treeData: GhTreeData, outputFormat: RenderFormat): string {
	const owner = treeData.owner ?? "?";
	const repo = treeData.repo ?? "?";
	const ref = treeData.ref ?? "?";
	const treePath = treeData.path;
	const defaultBranch = treeData.defaultBranch ?? "?";
	const entries: TreeEntry[] = treeData.entries ?? [];
	const displayedCount = treeData.displayedCount ?? 0;

	const lines: string[] = [];
	const repoFull = `${owner}/${repo}`;

	if (outputFormat === "markdown") {
		lines.push(`# Repository: ${repoFull}`);
		lines.push("");
		lines.push(`- **Owner:** ${owner}`);
		lines.push(`- **Repository:** ${repo}`);
		lines.push(`- **Ref:** ${ref}`);
		if (defaultBranch) lines.push(`- **Default branch:** ${defaultBranch}`);
		if (treePath) lines.push(`- **Path:** ${treePath}`);
		lines.push(`- **Entries:** ${displayedCount}`);
		lines.push("");
		lines.push("```");
		for (const entry of entries) {
			const entryPath = entry.path ?? "";
			const entryType = entry.type ?? "blob";
			const suffix = entryType === "tree" ? "/" : "";
			lines.push(`${entryPath}${suffix}`);
		}
		lines.push("```");
	} else {
		// text mode
		lines.push(`Repository: ${repoFull}`);
		lines.push(`Owner: ${owner}`);
		lines.push(`Ref: ${ref}`);
		if (defaultBranch) lines.push(`Default branch: ${defaultBranch}`);
		if (treePath) lines.push(`Path: ${treePath}`);
		lines.push(`Entries: ${displayedCount}`);
		lines.push("");
		for (const entry of entries) {
			const entryPath = entry.path ?? "";
			const entryType = entry.type ?? "blob";
			const suffix = entryType === "tree" ? "/" : "";
			lines.push(`${entryPath}${suffix}`);
		}
	}

	return lines.join("\n");
}

