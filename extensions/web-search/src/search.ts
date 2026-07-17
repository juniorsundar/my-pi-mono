/**
 * web-search: SearXNG search backend (TypeScript port of scripts/search.py).
 *
 * Phase 2 parallel-then-cut (#0009): this module is built alongside the live
 * Python (`scripts/search.py`), imported directly only by its vitest twin.
 * `index.ts` keeps shelling out to Python until the final cut, at which point
 * it switches to the `src/index.ts` barrel which re-exports `search()`.
 *
 * Fidelity bar (map): shape + behaviour-identical on the exposed surface —
 * the `SearchResponse` shape and the SearXNG request behaviour (URL building,
 * safesearch/timelimit/language/categories param mapping, client-side slicing,
 * null/missing-field handling, error paths). Internals free reign. Tests
 * assert shape + behaviour, not byte-identical prose.
 *
 * Library stack (#0008): native `fetch` + `undici` for HTTP.
 */

// ---------------------------------------------------------------------------
// Types — match index.ts's SearchResponse/SearchResult shape exactly.
// ---------------------------------------------------------------------------

export interface SearchResult {
	title: string;
	href: string;
	body: string;
	publishedDate: string;
	engines: string[];
}

export interface SearchResponse {
	results?: SearchResult[];
	answers?: string[];
	corrections?: string[];
	suggestions?: string[];
	error?: string;
}

export interface SearchParams {
	query: string;
	maxResults?: number;
	language?: string;
	categories?: string;
	safesearch?: "on" | "moderate" | "off";
	timelimit?: "d" | "w" | "m" | "y";
}

export interface SearchOptions {
	signal?: AbortSignal;
	/** Request timeout in milliseconds. SearXNG aggregates engines, so be generous. */
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants — mirror search.py.
// ---------------------------------------------------------------------------

const SAFESEARCH_MAP: Record<string, number> = {
	off: 0,
	moderate: 1,
	on: 2,
};

const TIMELIMIT_MAP: Record<string, string> = {
	d: "day",
	w: "week",
	m: "month",
	y: "year",
};

/** SearXNG aggregates multiple engines — generous timeout (search.py uses 15s). */
const DEFAULT_TIMEOUT_MS = 15_000;

export const CATEGORIES_CHOICES = [
	"general",
	"it",
	"news",
	"science",
	"files",
	"social media",
] as const;

export const LANGUAGE_CHOICES = [
	"all",
	"en",
	"de",
	"fr",
	"es",
	"pt",
	"zh",
	"ja",
	"ko",
	"ar",
	"ru",
] as const;

// ---------------------------------------------------------------------------
// Result normalization — direct port of normalize_result().
// ---------------------------------------------------------------------------

/**
 * Normalize a raw SearXNG result dict into the output shape.
 * Keeps: title, href, body, publishedDate, engines.
 * Excludes: score, category, infoboxes (only the 5 fields are copied, so
 * extra noise on the input never reaches the output).
 * Missing fields default to empty string / empty list.
 */
export function normalizeResult(
	raw: Record<string, unknown> | null | undefined,
): SearchResult {
	const enginesRaw = raw?.engines;
	const engines = Array.isArray(enginesRaw)
		? enginesRaw.filter((e): e is string => typeof e === "string")
		: [];
	return {
		title: String(raw?.title ?? ""),
		href: String((raw as Record<string, unknown> | undefined)?.url ?? ""),
		body: String(raw?.content ?? ""),
		publishedDate: String(raw?.publishedDate ?? ""),
		engines,
	};
}

// ---------------------------------------------------------------------------
// URL building — direct port of build_searxng_url().
// ---------------------------------------------------------------------------

/**
 * Build the SearXNG /search?format=json URL from search params.
 *
 * Param order (locked to match search.py's urlencode order):
 * format, q, safesearch, language, categories, time_range.
 *
 * Encoding: URLSearchParams encodes spaces as `+` (same as Python's
 * urlencode default). `safesearch` defaults to 1 (moderate); `language`
 * defaults to "all"; `categories` and `timelimit` are omitted when absent.
 */
export function buildSearxngUrl(baseUrl: string, params: SearchParams): string {
	const base = baseUrl.replace(/\/+$/, "");
	const safesearch = SAFESEARCH_MAP[params.safesearch ?? "moderate"] ?? 1;
	const language = params.language ?? "all";

	const search = new URLSearchParams();
	search.set("format", "json");
	search.set("q", params.query);
	search.set("safesearch", String(safesearch));
	search.set("language", language);

	if (params.categories) search.set("categories", params.categories);
	if (params.timelimit) {
		search.set("time_range", TIMELIMIT_MAP[params.timelimit] ?? params.timelimit);
	}

	return `${base}/search?${search.toString()}`;
}

// ---------------------------------------------------------------------------
// Choice validation — ports argparse's `choices=` rejection.
// ---------------------------------------------------------------------------

function validateChoices(params: SearchParams): string | null {
	if (params.safesearch !== undefined && !(params.safesearch in SAFESEARCH_MAP)) {
		return `invalid safesearch: ${params.safesearch}`;
	}
	if (params.timelimit !== undefined && !(params.timelimit in TIMELIMIT_MAP)) {
		return `invalid timelimit: ${params.timelimit}`;
	}
	if (
		params.language !== undefined &&
		!(LANGUAGE_CHOICES as readonly string[]).includes(params.language)
	) {
		return `invalid language: ${params.language}`;
	}
	if (
		params.categories !== undefined &&
		!(CATEGORIES_CHOICES as readonly string[]).includes(params.categories)
	) {
		return `invalid categories: ${params.categories}`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Client-side maxResults clamping — ports search.py's
//   max_results = max(1, min(args.max_results, 20))
// ---------------------------------------------------------------------------

export function clampMaxResults(value: number | undefined): number {
	const n = value ?? 10;
	return Math.max(1, Math.min(20, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// search() — the exposed entry point index.ts will call at the final cut.
// ---------------------------------------------------------------------------

/**
 * Run a SearXNG search and return the normalized SearchResponse.
 *
 * Behaviour ports search.py's `main()`:
 *   - validates choices (argparse exit 2 → `{ error }`)
 *   - GETs the SearXNG JSON endpoint with a timeout
 *   - network/HTTP errors → `{ error: "SearXNG request failed: ..." }`
 *   - non-JSON body → `{ error: "SearXNG returned non-JSON response" }`
 *   - null results → `[]`; slices to clampMaxResults(maxResults)
 *   - passes through answers/corrections/suggestions (null → [])
 */
export async function search(
	searxngUrl: string,
	params: SearchParams,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const validationError = validateChoices(params);
	if (validationError) return { error: validationError };

	const url = buildSearxngUrl(searxngUrl, params);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// search.py uses httpx.get(url, timeout=SEARXNG_TIMEOUT). Native fetch has
	// no built-in timeout, so synthesize one via AbortSignal.timeout() and
	// merge it with any caller-supplied signal (either firing aborts).
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;

	let response: Response;
	try {
		response = await fetch(url, { signal });
	} catch (error: any) {
		return { error: `SearXNG request failed: ${error?.message ?? String(error)}` };
	}

	if (!response.ok) {
		return { error: `SearXNG request failed: HTTP ${response.status}` };
	}

	let data: any;
	try {
		data = await response.json();
	} catch {
		return { error: "SearXNG returned non-JSON response" };
	}

	const resultsRaw = data.results ?? null;
	const results = Array.isArray(resultsRaw) ? resultsRaw : [];
	const max = clampMaxResults(params.maxResults);
	const normalized = results.slice(0, max).map(normalizeResult);

	const answers = Array.isArray(data.answers) ? data.answers : [];
	const corrections = Array.isArray(data.corrections) ? data.corrections : [];
	const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];

	return { results: normalized, answers, corrections, suggestions };
}