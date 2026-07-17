/**
 * web-search: integration test for the final cut (#0009).
 *
 * Proves the tool surface is unchanged after the cut: exercises the TS barrel
 * (`src/index.ts`) end-to-end — `search()` + `fetchUrl()` together, including
 * the GitHub routing seam — against msw, with no Python anywhere in the path.
 *
 * This is the cut's acceptance test: the four modules (search, representation,
 * fetch, github) compose through the barrel the way `index.ts` now calls them
 * in-process. Shape + behaviour on the exposed surface must hold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

import { search, fetchUrl } from "./index.js";
import { dnsResolver } from "./fetch.js";
import type {
	SearchResponse,
	FetchSuccess,
	FetchDownload,
	FetchErrorResult,
} from "./index.js";

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

describe("integration: barrel surface (search + fetchUrl)", () => {
	it("search returns the SearchResponse shape the web_search tool surfaces", async () => {
		server.use(http.get("http://searxng:8080/search", ({ request }) => {
			const sp = new URL(request.url).searchParams;
			expect(sp.get("q")).toBe("typescript");
			expect(sp.get("format")).toBe("json");
			return HttpResponse.json({
				results: [
					{ title: "TS", url: "https://ts.dev", content: "lang", publishedDate: "2024-01-01" },
				],
				answers: ["TS is a typed superset of JS"],
				corrections: [],
				suggestions: ["typescript tutorial"],
			});
		}));
		const r: SearchResponse = await search("http://searxng:8080", {
			query: "typescript", maxResults: 5,
		});
		expect(r.error).toBeUndefined();
		expect(r.results).toHaveLength(1);
		expect(r.results![0].title).toBe("TS");
		expect(r.results![0].href).toBe("https://ts.dev");
		expect(r.answers).toEqual(["TS is a typed superset of JS"]);
		expect(r.suggestions).toEqual(["typescript tutorial"]);
	});

	it("fetchUrl text path returns the FetchSuccess shape web_fetch surfaces", async () => {
		server.use(http.get("https://example.com/", () =>
			HttpResponse.html(
				"<html><head><title>Example</title></head><body><article><p>Hello</p></article></body></html>",
			),
		));
		const r = (await fetchUrl("https://example.com/", { maxChars: 500 })) as FetchSuccess;
		expect(r.error).toBeUndefined();
		expect(r.format).toBe("markdown");
		expect(r.title).toBe("Example");
		expect(r.content).toContain("Hello");
		expect(r.statusCode).toBe(200);
		expect(r).toHaveProperty("contentLength");
		expect(r).toHaveProperty("fetchedBytes");
		expect(r).toHaveProperty("sourceTruncated");
	});

	it("fetchUrl download path returns the FetchDownload shape web_fetch surfaces", async () => {
		const body = Buffer.from("%PDF-1.4 test", "latin1");
		server.use(http.get("https://example.com/doc.pdf", () =>
			new HttpResponse(body, { headers: { "content-type": "application/pdf" } }),
		));
		const r = (await fetchUrl("https://example.com/doc.pdf", { download: true })) as FetchDownload;
		expect(r.error).toBeUndefined();
		expect(r.contentType).toBe("application/pdf");
		expect(r.fileName.endsWith(".pdf")).toBe(true);
		expect(r.byteSize).toBe(body.length);
		expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
		expect(r.path).toBeTruthy();
		const fs = await import("node:fs");
		expect(fs.existsSync(r.path)).toBe(true);
		fs.rmSync(r.path, { force: true });
	});

	it("fetchUrl error path returns the FetchErrorResult shape web_fetch surfaces", async () => {
		// image/* in text mode is rejected by the content-type allowlist.
		server.use(http.get("https://example.com/x.jpg", () =>
			new HttpResponse(Buffer.from([0xff, 0xd8, 0xff]), {
				headers: { "content-type": "image/jpeg" },
			}),
		));
		const r = (await fetchUrl("https://example.com/x.jpg")) as FetchErrorResult;
		expect(r.error).toMatch(/Unsupported content type/);
		expect(r.url).toBe("https://example.com/x.jpg");
	});

	it("fetchUrl routes github.com URLs through the API (classify seam)", async () => {
		// A GitHub repository-root URL must never fall back to HTML extraction;
		// it routes through fetchGithubTree via the classify seam.
		const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		server.use(http.get("https://api.github.com/repos/o/r", () =>
			HttpResponse.json({ default_branch: "main", full_name: "o/r" }),
		));
		server.use(http.get("https://api.github.com/repos/o/r/commits/main", () =>
			HttpResponse.json({ sha: SHA }),
		));
		server.use(http.get(`https://api.github.com/repos/o/r/git/trees/${SHA}`, () =>
			HttpResponse.json({
				sha: SHA, truncated: false,
				tree: [{ path: "README.md", type: "blob", sha: "b".repeat(40), mode: "100644" }],
			}),
		));
		const r = (await fetchUrl("https://github.com/o/r")) as FetchSuccess;
		expect(r.error).toBeUndefined();
		expect(r.content).toContain("# Repository: o/r");
		expect(r.content).toContain("README.md");
		expect(r.contentType).toContain("text/plain");
	});

	it("search + fetchUrl compose: search a topic, fetch a result URL", async () => {
		// search returns a result, then fetchUrl extracts that result's page.
		server.use(http.get("http://searxng:8080/search", () =>
			HttpResponse.json({
				results: [
					{ title: "Vitest", url: "https://vitest.dev/", content: "test runner" },
				],
			}),
		));
		server.use(http.get("https://vitest.dev/", () =>
			HttpResponse.html(
				"<html><head><title>Vitest</title></head><body><article><p>Vite-native test runner</p></article></body></html>",
			),
		));
		const s = await search("http://searxng:8080", { query: "vitest", maxResults: 3 });
		const href = s.results![0].href;
		const f = (await fetchUrl(href, { maxChars: 1000 })) as FetchSuccess;
		expect(f.title).toBe("Vitest");
		expect(f.content).toContain("Vite-native test runner");
	});
});