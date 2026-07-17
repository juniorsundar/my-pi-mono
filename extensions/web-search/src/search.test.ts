/**
 * vitest twin of scripts/tests/test_search.py — ports the pytest suite for
 * search.ts (the TS port of scripts/search.py).
 *
 * Phase 2 parallel-then-cut (#0009): both pytest (in .venv) and vitest (root)
 * run until the final cut, at which point the pytest suite is deleted with the
 * rest of the Python. This file is the direct port of the pytest spec, so the
 * fidelity bar (shape + behaviour on the exposed surface) is checked against
 * the spec that defined it.
 *
 * HTTP mocking: msw `setupServer` (per #0008). SearXNG response URLs in the
 * pytest suite are matched by msw against the request URL; query params are
 * compared via URLSearchParams so `+` vs `%20` space-encoding (an internal
 * detail) doesn't affect matching — we assert behaviour, not byte-identical
 * URLs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

import {
	search,
	normalizeResult,
	buildSearxngUrl,
	clampMaxResults,
	LANGUAGE_CHOICES,
} from "./search.ts";

const SEARXNG = "http://127.0.0.1:5340";

// ---------------------------------------------------------------------------
// msw server — reset handlers per test for isolation.
// ---------------------------------------------------------------------------

const server = setupServer();

beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
	server.resetHandlers();
	server.close();
});

/**
 * Match a SearXNG request by its query params, ignoring param order and the
 * `+` vs `%20` distinction. Returns an msw handler that responds with `body`.
 */
function searxngOk(
	expectedParams: Record<string, string | undefined>,
	body: unknown,
) {
	const expected = new URLSearchParams();
	for (const [k, v] of Object.entries(expectedParams)) {
		if (v !== undefined) expected.set(k, v);
	}
	server.use(
		http.get(`${SEARXNG}/search`, ({ request }) => {
			const got = new URL(request.url).searchParams;
			// canonicalize for order-insensitive comparison
			const norm = (p: URLSearchParams) =>
				[...p.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&");
			if (norm(got) !== norm(expected)) {
				return HttpResponse.json(
					{ error: "unmatched query" },
					{ status: 500 },
				);
			}
			return HttpResponse.json(body);
		}),
	);
}

/** SearXNG default params for `q=test`, no categories/timelimit. */
const defaultParams = (overrides: Record<string, string | undefined> = {}) => ({
	format: "json",
	q: "test",
	safesearch: "1",
	language: "all",
	...overrides,
});

// ---------------------------------------------------------------------------
// Unit: result normalization
// ---------------------------------------------------------------------------

describe("normalizeResult", () => {
	it("maps searxng fields url/title/content to href/title/body; keeps publishedDate and engines", () => {
		const normalized = normalizeResult({
			url: "https://example.com",
			title: "Example Title",
			content: "Example snippet.",
			engines: ["google", "duckduckgo"],
			score: 0.95,
			publishedDate: "2024-01-01",
		});
		expect(normalized).toEqual({
			title: "Example Title",
			href: "https://example.com",
			body: "Example snippet.",
			publishedDate: "2024-01-01",
			engines: ["google", "duckduckgo"],
		});
		expect(normalized).not.toHaveProperty("score");
		expect(normalized).not.toHaveProperty("category");
		expect(normalized).not.toHaveProperty("infoboxes");
	});

	it("defaults missing fields to empty strings and empty list", () => {
		expect(normalizeResult({})).toEqual({
			title: "",
			href: "",
			body: "",
			publishedDate: "",
			engines: [],
		});
	});

	it("turns None values into empty strings/list", () => {
		expect(
			normalizeResult({ url: null, title: null, content: null }),
		).toEqual({
			title: "",
			href: "",
			body: "",
			publishedDate: "",
			engines: [],
		});
	});

	it("keeps publishedDate and engines from a richer result, excluding noise", () => {
		const normalized = normalizeResult({
			url: "https://example.com",
			title: "Example Title",
			content: "Example snippet.",
			engines: ["google", "duckduckgo"],
			publishedDate: "2024-01-01T12:00:00Z",
			score: 0.95,
			category: "general",
			infoboxes: ["some info"],
		});
		expect(normalized.title).toBe("Example Title");
		expect(normalized.href).toBe("https://example.com");
		expect(normalized.body).toBe("Example snippet.");
		expect(normalized.publishedDate).toBe("2024-01-01T12:00:00Z");
		expect(normalized.engines).toEqual(["google", "duckduckgo"]);
		expect(normalized).not.toHaveProperty("score");
		expect(normalized).not.toHaveProperty("category");
		expect(normalized).not.toHaveProperty("infoboxes");
	});

	it("excludes score, category, infoboxes even when present", () => {
		const normalized = normalizeResult({
			url: "https://x.com",
			title: "X",
			content: "X content",
			score: 0.5,
			category: "news",
			infoboxes: ["something"],
		});
		expect(normalized).not.toHaveProperty("score");
		expect(normalized).not.toHaveProperty("category");
		expect(normalized).not.toHaveProperty("infoboxes");
	});

	it("defaults missing publishedDate/engines to empty string/list", () => {
		const normalized = normalizeResult({
			url: "https://y.com",
			title: "Y",
			content: "Y content",
		});
		expect(normalized.publishedDate).toBe("");
		expect(normalized.engines).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Unit: URL building
// ---------------------------------------------------------------------------

describe("buildSearxngUrl", () => {
	it("builds the default URL with format/q/safesearch/language", () => {
		const url = buildSearxngUrl(SEARXNG, { query: "test" });
		expect(url).toBe(
			`${SEARXNG}/search?format=json&q=test&safesearch=1&language=all`,
		);
	});

	it("strips a trailing slash from the base url", () => {
		expect(buildSearxngUrl(`${SEARXNG}/`, { query: "x" })).toContain(
			`${SEARXNG}/search?`,
		);
	});
});

// ---------------------------------------------------------------------------
// Unit: clampMaxResults
// ---------------------------------------------------------------------------

describe("clampMaxResults", () => {
	it("clamps negative to 1 (no negative slicing)", () =>
		expect(clampMaxResults(-1)).toBe(1));
	it("clamps above 20 to 20", () => expect(clampMaxResults(100)).toBe(20));
	it("defaults undefined to 10", () => expect(clampMaxResults(undefined)).toBe(10));
	it("passes through 1..20", () => {
		expect(clampMaxResults(1)).toBe(1);
		expect(clampMaxResults(20)).toBe(20);
	});
});

// ---------------------------------------------------------------------------
// Integration: search() → SearXNG API → SearchResponse
// ---------------------------------------------------------------------------

describe("search() happy path", () => {
	it("returns normalized results", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 2,
			results: [
				{ title: "First Result", url: "https://first.example.com", content: "First snippet." },
				{ title: "Second Result", url: "https://second.example.com", content: "Second snippet." },
			],
		});
		const out = await search(SEARXNG, { query: "test", maxResults: 10 });
		expect(out.error).toBeUndefined();
		expect(out.results).toHaveLength(2);
		expect(out.results![0]).toEqual({
			title: "First Result",
			href: "https://first.example.com",
			body: "First snippet.",
			publishedDate: "",
			engines: [],
		});
		expect(out.results![1]).toEqual({
			title: "Second Result",
			href: "https://second.example.com",
			body: "Second snippet.",
			publishedDate: "",
			engines: [],
		});
	});

	it("slices client-side to maxResults", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 5,
			results: Array.from({ length: 5 }, (_, i) => ({
				title: `R${i}`,
				url: `https://${i}.com`,
				content: `S${i}`,
			})),
		});
		const out = await search(SEARXNG, { query: "test", maxResults: 3 });
		expect(out.results).toHaveLength(3);
	});

	it("returns empty results when SearXNG returns none", async () => {
		searxngOk(
			{ ...defaultParams({ q: "nothing" }) },
			{ query: "nothing", number_of_results: 0, results: [] },
		);
		const out = await search(SEARXNG, { query: "nothing" });
		expect(out.error).toBeUndefined();
		expect(out.results).toEqual([]);
	});

	it("treats results: null as empty list", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 0,
			results: null,
		});
		const out = await search(SEARXNG, { query: "test" });
		expect(out.error).toBeUndefined();
		expect(out.results).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// maxResults clamping via search()
// ---------------------------------------------------------------------------

describe("search() maxResults clamping", () => {
	it("clamps 100 to 20", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 25,
			results: Array.from({ length: 25 }, (_, i) => ({
				title: `R${i}`,
				url: `https://${i}.com`,
				content: `S${i}`,
			})),
		});
		const out = await search(SEARXNG, { query: "test", maxResults: 100 });
		expect(out.results).toHaveLength(20);
	});

	it("clamps -1 to 1 (forward slicing with 5 results)", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 5,
			results: Array.from({ length: 5 }, (_, i) => ({
				title: `R${i}`,
				url: `https://${i}.com`,
				content: `S${i}`,
			})),
		});
		const out = await search(SEARXNG, { query: "test", maxResults: -1 });
		expect(out.results).toHaveLength(1);
		expect(out.results![0].title).toBe("R0");
	});

	it("clamps -1 to 1 with 2 results (first is R1→ actually R0)", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 2,
			results: [
				{ title: "R1", url: "https://1.com", content: "S1" },
				{ title: "R2", url: "https://2.com", content: "S2" },
			],
		});
		const out = await search(SEARXNG, { query: "test", maxResults: -1 });
		expect(out.results).toHaveLength(1);
		expect(out.results![0].title).toBe("R1");
	});
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("search() error paths", () => {
	it("unreachable instance → error mentioning 'SearXNG request failed'", async () => {
		// No handler registered for 127.0.0.1:9999 → onUnhandledRequest: error
		// throws, caught by search() and wrapped as a request failure.
		const out = await search("http://127.0.0.1:9999", { query: "test" });
		expect(out.error).toMatch(/SearXNG request failed/);
	});

	it("HTTP 500 → error mentioning 'SearXNG request failed'", async () => {
		server.use(
			http.get(`${SEARXNG}/search`, () =>
				HttpResponse.json({ error: "boom" }, { status: 500 }),
			),
		);
		const out = await search(SEARXNG, { query: "test" });
		expect(out.error).toMatch(/SearXNG request failed/);
	});

	it("non-JSON response → 'non-JSON' error", async () => {
		server.use(
			http.get(`${SEARXNG}/search`, () =>
				new HttpResponse("<html>Internal Server Error</html>", {
					headers: { "content-type": "text/html" },
				}),
			),
		);
		const out = await search(SEARXNG, { query: "test" });
		expect(out.error).toMatch(/non-JSON/);
	});

	it("timeout → 'SearXNG request failed' error", async () => {
		server.use(
			http.get(`${SEARXNG}/search`, async () => {
				await new Promise((r) => setTimeout(r, 500));
				return HttpResponse.json({});
			}),
		);
		const out = await search(SEARXNG, { query: "test" }, { timeoutMs: 30 });
		expect(out.error).toMatch(/SearXNG request failed/);
	});
});

// ---------------------------------------------------------------------------
// Parameter mapping (safesearch / timelimit / language / categories)
// ---------------------------------------------------------------------------

describe("search() parameter mapping", () => {
	it.each([
		["on", 2],
		["moderate", 1],
		["off", 0],
	] as const)("safesearch '%s' → safesearch=%s", async (ss, n) => {
		searxngOk(defaultParams({ safesearch: String(n) }), { results: [] });
		const out = await search(SEARXNG, { query: "test", safesearch: ss });
		expect(out.error).toBeUndefined();
	});

	it.each([
		["d", "day"],
		["w", "week"],
		["m", "month"],
		["y", "year"],
	] as const)("timelimit '%s' → time_range=%s", async (tl, range) => {
		searxngOk(defaultParams({ time_range: range }), { results: [] });
		const out = await search(SEARXNG, { query: "test", timelimit: tl });
		expect(out.error).toBeUndefined();
	});

	it("omits time_range when no timelimit", async () => {
		searxngOk(defaultParams(), { results: [] });
		const out = await search(SEARXNG, { query: "test" });
		expect(out.error).toBeUndefined();
	});

	it.each(LANGUAGE_CHOICES.map((l) => [l] as const))(
		"language '%s' is passed through",
		async (lang) => {
			searxngOk(defaultParams({ language: lang }), { results: [] });
			const out = await search(SEARXNG, { query: "test", language: lang });
			expect(out.error).toBeUndefined();
		},
	);

	it.each([
		["general", "general"],
		["it", "it"],
		["news", "news"],
		["science", "science"],
		["files", "files"],
		["social media", "social media"],
	] as const)("categories '%s' is passed through", async (cat) => {
		searxngOk(defaultParams({ categories: cat }), { results: [] });
		const out = await search(SEARXNG, { query: "test", categories: cat });
		expect(out.error).toBeUndefined();
	});

	it("omits categories param by default", async () => {
		searxngOk(defaultParams(), { results: [] });
		const out = await search(SEARXNG, { query: "test" });
		expect(out.error).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Choice validation (argparse exit 2 → { error })
// ---------------------------------------------------------------------------

describe("search() choice validation", () => {
	it("rejects invalid categories", async () => {
		const out = await search(SEARXNG, { query: "test", categories: "bogus" as any });
		expect(out.error).toMatch(/categories/);
	});
	it("rejects invalid language", async () => {
		const out = await search(SEARXNG, { query: "test", language: "bogus" });
		expect(out.error).toMatch(/language/);
	});
	it("rejects invalid timelimit", async () => {
		const out = await search(SEARXNG, { query: "test", timelimit: "x" as any });
		expect(out.error).toMatch(/timelimit/);
	});
	it("rejects invalid safesearch", async () => {
		const out = await search(SEARXNG, { query: "test", safesearch: "bogus" as any });
		expect(out.error).toMatch(/safesearch/);
	});
});

// ---------------------------------------------------------------------------
// Enrichment fields (answers / corrections / suggestions)
// ---------------------------------------------------------------------------

describe("search() enrichment fields", () => {
	it("passes through answers/corrections/suggestions", async () => {
		searxngOk(defaultParams({ q: "population of france" }), {
			query: "population of france",
			number_of_results: 1,
			results: [
				{
					title: "France population",
					url: "https://example.com/france",
					content: "France has 68M people.",
				},
			],
			answers: ["France has a population of approximately 68 million."],
			corrections: ["population of france"],
			suggestions: ["population of germany", "france demographics"],
		});
		const out = await search(SEARXNG, { query: "population of france" });
		expect(out.answers).toEqual([
			"France has a population of approximately 68 million.",
		]);
		expect(out.corrections).toEqual(["population of france"]);
		expect(out.suggestions).toEqual([
			"population of germany",
			"france demographics",
		]);
	});

	it("defaults missing enrichment fields to empty arrays", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 0,
			results: [],
		});
		const out = await search(SEARXNG, { query: "test" });
		expect(out.answers).toEqual([]);
		expect(out.corrections).toEqual([]);
		expect(out.suggestions).toEqual([]);
	});

	it("defaults null enrichment fields to empty arrays", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 0,
			results: [],
			answers: null,
			corrections: null,
			suggestions: null,
		});
		const out = await search(SEARXNG, { query: "test" });
		expect(out.answers).toEqual([]);
		expect(out.corrections).toEqual([]);
		expect(out.suggestions).toEqual([]);
	});

	it("includes publishedDate and engines on each result", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 1,
			results: [
				{
					title: "R1",
					url: "https://r1.com",
					content: "Snippet 1",
					engines: ["google", "duckduckgo"],
					publishedDate: "2024-06-01T10:00:00Z",
				},
			],
		});
		const out = await search(SEARXNG, { query: "test" });
		expect(out.results).toHaveLength(1);
		expect(out.results![0].publishedDate).toBe("2024-06-01T10:00:00Z");
		expect(out.results![0].engines).toEqual(["google", "duckduckgo"]);
		expect(out.results![0]).not.toHaveProperty("score");
		expect(out.results![0]).not.toHaveProperty("category");
	});

	it("defaults a result's missing publishedDate to empty string", async () => {
		searxngOk(defaultParams(), {
			query: "test",
			number_of_results: 1,
			results: [{ title: "R1", url: "https://r1.com", content: "Snippet 1" }],
		});
		const out = await search(SEARXNG, { query: "test" });
		expect(out.results![0].publishedDate).toBe("");
	});
});