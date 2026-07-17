/**
 * vitest twin of scripts/tests/test_fetch.py's GitHub-tree test classes —
 * the github.ts port (step 4/4 of #0009's parallel-then-cut).
 *
 * Ports the pytest suite (TestGitHubTreeRepositoryRoot, Subdirectory,
 * Sorting, TextMode, RawMode, Empty, Bounds, ContentArtifact, Auth, WwwHost,
 * blob 404 routing, token-never-leaks, redirect-no-creds) to vitest, plus
 * unit tests for classify() / resolveRef() / renderTree() lifted directly
 * from scripts/tests/test_fetch.py and scripts/github.py's docstring cases.
 *
 * HTTP mocking: msw `setupServer` (per #0008). GITHUB_TOKEN is set via
 * `vi.stubEnv` per test. The classify seam is exercised through `fetchUrl`
 * (the exposed seam in fetch.ts that now routes github.com URLs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	fetchUrl,
	type FetchSuccess,
	type FetchDownload,
	type FetchErrorResult,
} from "./fetch.js";
import {
	classify,
	resolveRef,
	renderTree,
	fetchGithubBlobContent,
	isGitHubResource,
	type GitHubResource,
} from "./github.js";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ---------------------------------------------------------------------------
// msw + helpers
// ---------------------------------------------------------------------------

const server = setupServer();

beforeEach(() => {
	server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
	server.resetHandlers();
	server.close();
	vi.unstubAllEnvs();
});

/** JSON handler with a body. */
/** Contents-API handler matching the path and checking ?ref via searchParams.
 * Avoids msw's query-param-in-URL warning. */
function contentsGet(path: string, body: unknown, status = 200, ref = "main") {
	server.use(http.get(path, ({ request }) => {
		const sp = new URL(request.url).searchParams;
		if (sp.get("ref") !== ref) return new HttpResponse(null, { status: 404 });
		if (status === 302) return new HttpResponse(null, { status: 302, headers: { location: body as string } });
		return HttpResponse.json(body, { status });
	}));
}

function jsonGet(url: string, body: unknown, status = 200) {
	server.use(http.get(url, () => HttpResponse.json(body, { status })));
}

/** Response with arbitrary status + headers (for redirect/no-cred tests). */
function rawGet(url: string, status: number, headers: Record<string, string> = {}) {
	server.use(http.get(url, () => new HttpResponse(null, { status, headers })));
}

/** Wire the 3 repo-root tree mocks. */
function mockRepoRootTree(entries: unknown[], opts: { truncated?: boolean } = {}) {
	jsonGet("https://api.github.com/repos/owner/repo", {
		default_branch: "main", full_name: "owner/repo",
	});
	jsonGet("https://api.github.com/repos/owner/repo/commits/main", { sha: SHA });
	server.use(http.get(`https://api.github.com/repos/owner/repo/git/trees/${SHA}`, () =>
		HttpResponse.json({ sha: SHA, truncated: opts.truncated ?? false, tree: entries }),
	));
}

function blob(path: string, sha = SHA_B, mode = "100644") {
	return { path, type: "blob", sha, mode };
}
function tree(path: string, sha = SHA_B, mode = "040000") {
	return { path, type: "tree", sha, mode };
}

/** Run a fetchUrl and parse a success result. */
async function fetchOk(url: string, opts: Record<string, unknown> = {}) {
	const r = (await fetchUrl(url, opts)) as FetchSuccess;
	expect(r.error).toBeUndefined();
	return r;
}

// ===========================================================================
// classify — unit tests (lifted from github.py docstring + test cases)
// ===========================================================================

describe("classify", () => {
	it("repository root: owner/repo only", () => {
		const c = classify("https://github.com/owner/repo") as GitHubResource;
		expect(c.type).toBe("repository_root");
		expect(c.owner).toBe("owner");
		expect(c.repo).toBe("repo");
		expect(c.ref).toBeNull();
		expect(c.path).toBeNull();
	});
	it("repository root strips .git suffix", () => {
		const c = classify("https://github.com/owner/repo.git") as GitHubResource;
		expect(c.repo).toBe("repo");
		expect(c.type).toBe("repository_root");
	});
	it("tree URL: ref + path", () => {
		const c = classify("https://github.com/owner/repo/tree/main/src/lib") as GitHubResource;
		expect(c.type).toBe("tree");
		expect(c.owner).toBe("owner");
		expect(c.repo).toBe("repo");
		expect(c.ref).toBe("main");
		expect(c.path).toBe("src/lib");
	});
	it("blob URL: ref + path", () => {
		const c = classify("https://github.com/owner/repo/blob/main/README.md") as GitHubResource;
		expect(c.type).toBe("blob");
		expect(c.ref).toBe("main");
		expect(c.path).toBe("README.md");
	});
	it("tree URL with no path (ref only)", () => {
		const c = classify("https://github.com/owner/repo/tree/main") as GitHubResource;
		expect(c.type).toBe("tree");
		expect(c.ref).toBe("main");
		expect(c.path).toBeNull();
	});
	it("www.github.com is accepted", () => {
		const c = classify("https://www.github.com/owner/repo") as GitHubResource;
		expect(c.type).toBe("repository_root");
	});
	it("non-github host → NonSpecialized", () => {
		const c = classify("https://gitlab.com/owner/repo");
		expect(isGitHubResource(c)).toBe(false);
	});
	it("path too short → NonSpecialized", () => {
		const c = classify("https://github.com/owner");
		expect(isGitHubResource(c)).toBe(false);
	});
	it("unrecognised third segment → NonSpecialized", () => {
		const c = classify("https://github.com/owner/repo/issues/1");
		expect(isGitHubResource(c)).toBe(false);
	});
	it("decodes percent-escaped segments", () => {
		const c = classify("https://github.com/owner/repo/tree/main/src%20lib") as GitHubResource;
		expect(c.path).toBe("src lib");
	});
});

// ===========================================================================
// resolveRef — unit tests
// ===========================================================================

describe("resolveRef", () => {
	it("short-circuits a 40-char commit SHA without API calls", async () => {
		const r = await resolveRef("owner", "repo", SHA);
		expect(r.ref).toBe(SHA);
		expect(r.pathRemainder).toBeNull();
	});
	it("SHA with a path remainder", async () => {
		const r = await resolveRef("owner", "repo", `${SHA}/src/lib`);
		expect(r.ref).toBe(SHA);
		expect(r.pathRemainder).toBe("src/lib");
	});
	it("resolves a branch (longest prefix)", async () => {
		jsonGet("https://api.github.com/repos/o/r/branches/feature", { name: "feature" });
		jsonGet("https://api.github.com/repos/o/r/branches/feature%2Flong%2Fsrc", { name: "x" }, 404);
		jsonGet("https://api.github.com/repos/o/r/branches/feature%2Flong", { name: "x" }, 404);
		jsonGet("https://api.github.com/repos/o/r/branches/feature", { name: "feature" });
		const r = await resolveRef("o", "r", "feature/long/src/lib");
		expect(r.ref).toBe("feature");
		expect(r.pathRemainder).toBe("long/src/lib");
	});
	it("throws when the ref cannot be resolved", async () => {
		// No branch matches; tag probes also 404.
		jsonGet("https://api.github.com/repos/o/r/branches/nope", null, 404);
		jsonGet("https://api.github.com/repos/o/r/git/ref/tags/nope", null, 404);
		await expect(resolveRef("o", "r", "nope")).rejects.toThrow(/cannot resolve ref/);
	});
});

// ===========================================================================
// renderTree — unit tests
// ===========================================================================

describe("renderTree", () => {
	const treeData = {
		owner: "owner", repo: "repo", ref: "main", path: null,
		defaultBranch: "main", entries: [blob("README.md"), tree("src")],
		canonicalJson: "{}", totalCount: 2, displayedCount: 2, upstreamTruncated: false,
	} as any;

	it("markdown: header + fenced listing", () => {
		const out = renderTree(treeData, "markdown");
		expect(out).toContain("# Repository: owner/repo");
		expect(out).toContain("- **Owner:** owner");
		expect(out).toContain("- **Ref:** main");
		expect(out).toContain("- **Entries:** 2");
		expect(out).toContain("```");
		expect(out).toContain("README.md");
		expect(out).toContain("src/");
	});
	it("text: plain metadata, no fences", () => {
		const out = renderTree(treeData, "text");
		expect(out).not.toContain("#");
		expect(out).toContain("Repository: owner/repo");
		expect(out).toContain("Owner: owner");
		expect(out).toContain("Ref: main");
		expect(out).toContain("Entries: 2");
		expect(out).toContain("README.md");
	});
});

// ===========================================================================
// fetchUrl tree path — repository root
// ===========================================================================

describe("fetchUrl: GitHub tree (repository root)", () => {
	it("resolves default branch and returns a sorted rendered tree", async () => {
		mockRepoRootTree([
			blob("README.md"), blob("src/main.py"), tree("src/utils"),
			blob("src/utils/helper.py"),
		]);
		const r = await fetchOk("https://github.com/owner/repo", { format: "markdown" });
		expect(r.statusCode).toBe(200);
		expect(r.format).toBe("markdown");
		expect(r.contentType).toContain("text/plain");
		const c = r.content;
		expect(c).toContain("# Repository: owner/repo");
		expect(c).toContain("- **Default branch:** main");
		// sorted lexicographically
		const readmeIdx = c.indexOf("README.md");
		const mainIdx = c.indexOf("src/main.py");
		expect(readmeIdx).toBeLessThan(mainIdx);
		// tree entries get a trailing slash
		expect(c).toContain("src/utils/");
		expect(r.sourceTruncated).toBe(false);
		expect(r.truncated).toBe(false);
	});
});

// ===========================================================================
// fetchUrl tree path — subdirectory filtering + slash refs
// ===========================================================================

describe("fetchUrl: GitHub tree (subdirectory + slash refs)", () => {
	it("filters entries to the requested subdirectory", async () => {
		// repo metadata (always fetched first)
		jsonGet("https://api.github.com/repos/owner/repo", { default_branch: "main", full_name: "owner/repo" });
		// resolve_ref probes: branch probes all 404 except feature/long.
		jsonGet("https://api.github.com/repos/owner/repo/branches/feature%2Flong%2Fsrc%2Flib", null, 404);
		jsonGet("https://api.github.com/repos/owner/repo/branches/feature%2Flong%2Fsrc", null, 404);
		jsonGet("https://api.github.com/repos/owner/repo/branches/feature%2Flong", { name: "feature/long" });
		// tree fetch
		jsonGet("https://api.github.com/repos/owner/repo/commits/feature%2Flong", { sha: SHA });
		server.use(http.get(`https://api.github.com/repos/owner/repo/git/trees/${SHA}`, () =>
			HttpResponse.json({
				sha: SHA, truncated: false,
				tree: [
					blob("README.md"), blob("src/main.py"),
					blob("src/lib/core.py"), blob("src/lib/utils.py"),
					blob("tests/test_main.py"),
				],
			}),
		));
		const r = await fetchOk(
			"https://github.com/owner/repo/tree/feature/long/src/lib",
			{ format: "markdown" },
		);
		expect(r.content).toContain("src/lib/core.py");
		expect(r.content).toContain("src/lib/utils.py");
		expect(r.content).not.toContain("src/main.py");
		expect(r.content).not.toContain("README.md");
		expect(r.content).toContain("- **Path:** src/lib");
	});

	it("slash ref with no subdirectory returns all entries", async () => {
		jsonGet("https://api.github.com/repos/owner/repo", { default_branch: "main", full_name: "owner/repo" });
		jsonGet("https://api.github.com/repos/owner/repo/branches/feature%2Flong", { name: "feature/long" });
		jsonGet("https://api.github.com/repos/owner/repo/commits/feature%2Flong", { sha: SHA });
		server.use(http.get(`https://api.github.com/repos/owner/repo/git/trees/${SHA}`, () =>
			HttpResponse.json({ sha: SHA, truncated: false, tree: [blob("README.md"), blob("src/lib/core.py")] }),
		));
		const r = await fetchOk(
			"https://github.com/owner/repo/tree/feature/long",
			{ format: "markdown" },
		);
		expect(r.content).toContain("README.md");
		expect(r.content).toContain("src/lib/core.py");
	});
});

// ===========================================================================
// fetchUrl tree path — text mode
// ===========================================================================

describe("fetchUrl: GitHub tree (text mode)", () => {
	it("text mode has no markdown formatting", async () => {
		mockRepoRootTree([blob("README.md"), blob("src/main.py")]);
		const r = await fetchOk("https://github.com/owner/repo", { format: "text" });
		expect(r.format).toBe("text");
		expect(r.content).not.toContain("#");
		expect(r.content).not.toContain("```");
		expect(r.content).toContain("Repository: owner/repo");
		expect(r.content).toContain("Entries: 2");
	});
});

// ===========================================================================
// fetchUrl tree path — raw mode (canonical JSON)
// ===========================================================================

describe("fetchUrl: GitHub tree (raw mode)", () => {
	it("raw mode returns canonical GitHub API JSON", async () => {
		const apiTree = {
			sha: SHA, truncated: false,
			tree: [{ path: "README.md", type: "blob", sha: SHA_B, mode: "100644" }],
		};
		mockRepoRootTree([apiTree.tree[0]]);
		// msw returns its own serialization; the port preserves treeData as-is
		const r = await fetchOk("https://github.com/owner/repo", { raw: true });
		expect(r.format).toBe("raw");
		expect(r.contentType).toContain("application/json");
		// The canonical JSON is the parsed tree response; it round-trips.
		const parsed = JSON.parse(r.content);
		expect(parsed.sha).toBe(SHA);
		expect(Array.isArray(parsed.tree)).toBe(true);
	});
});

// ===========================================================================
// fetchUrl tree path — empty tree
// ===========================================================================

describe("fetchUrl: GitHub tree (empty)", () => {
	it("empty tree renders an empty fenced listing", async () => {
		mockRepoRootTree([]);
		const r = await fetchOk("https://github.com/owner/repo");
		expect(r.sourceTruncated).toBe(false);
		expect(r.truncated).toBe(false);
		expect(r.content).toContain("- **Entries:** 0");
		expect(r.content).toContain("```");
		// exactly two fences
		expect(r.content.match(/```/g)?.length).toBe(2);
		// listing between fences is empty
		const start = r.content.indexOf("```");
		const end = r.content.indexOf("```", start + 1);
		const listing = r.content.slice(start + 3, end).trim();
		expect(listing).toBe("");
	});
});

// ===========================================================================
// fetchUrl tree path — 2000-entry bound
// ===========================================================================

describe("fetchUrl: GitHub tree (entry bound)", () => {
	it("bounds at 2000 entries and sets sourceTruncated", async () => {
		const entries = Array.from({ length: 2100 }, (_, i) =>
			blob(`file_${String(i).padStart(4, "0")}.py`),
		);
		mockRepoRootTree(entries);
		const r = await fetchOk("https://github.com/owner/repo");
		expect(r.sourceTruncated).toBe(true);
		expect(r.warnings.some((w) => w.includes("exceeds 2000"))).toBe(true);
		// content listing has exactly 2000 paths
		expect(r.content).toContain("file_0000.py");
		expect(r.content).toContain("file_1999.py");
		expect(r.content).not.toContain("file_2000.py");
	});

	it("upstream-truncated tree sets sourceTruncated + warning", async () => {
		mockRepoRootTree([blob("README.md")], { truncated: true });
		const r = await fetchOk("https://github.com/owner/repo");
		expect(r.sourceTruncated).toBe(true);
		expect(r.warnings.some((w) => w.includes("truncated tree"))).toBe(true);
	});
});

// ===========================================================================
// fetchUrl tree path — content artifact on maxChars truncation
// ===========================================================================

describe("fetchUrl: GitHub tree (content artifact)", () => {
	it("writes a content artifact when the rendered tree exceeds maxChars", async () => {
		const entries = Array.from({ length: 100 }, (_, i) =>
			blob(`file_${String(i).padStart(4, "0")}.py`),
		);
		mockRepoRootTree(entries);
		const r = await fetchOk("https://github.com/owner/repo", { maxChars: 500 });
		expect(r.truncated).toBe(true);
		expect(r.contentArtifactPath).toBeTruthy();
		expect(fs.existsSync(r.contentArtifactPath!)).toBe(true);
		const full = fs.readFileSync(r.contentArtifactPath!, "utf-8");
		expect(full).toContain("file_0000.py");
		expect(full).toContain("file_0099.py");
		// sourceTruncated stays false — the tree isn't partial
		expect(r.sourceTruncated).toBe(false);
		fs.rmSync(r.contentArtifactPath!, { force: true });
	});
});

// ===========================================================================
// fetchUrl tree path — auth
// ===========================================================================

describe("fetchUrl: GitHub tree (auth)", () => {
	it("sends Bearer auth on all three API calls when GITHUB_TOKEN is set", async () => {
		vi.stubEnv("GITHUB_TOKEN", "ghp_tree-token");
		const seen = new Map<string, string | null>();
		server.use(http.get("https://api.github.com/repos/owner/repo", ({ request }) => {
			seen.set("repo", request.headers.get("Authorization"));
			return HttpResponse.json({ default_branch: "main", full_name: "owner/repo" });
		}));
		server.use(http.get("https://api.github.com/repos/owner/repo/commits/main", ({ request }) => {
			seen.set("commit", request.headers.get("Authorization"));
			return HttpResponse.json({ sha: SHA });
		}));
		server.use(http.get(
			`https://api.github.com/repos/owner/repo/git/trees/${SHA}`,
			({ request }) => {
				seen.set("tree", request.headers.get("Authorization"));
				return HttpResponse.json({ sha: SHA, truncated: false, tree: [blob("README.md")] });
			},
		));
		await fetchOk("https://github.com/owner/repo");
		expect(seen.get("repo")).toBe("Bearer ghp_tree-token");
		expect(seen.get("commit")).toBe("Bearer ghp_tree-token");
		expect(seen.get("tree")).toBe("Bearer ghp_tree-token");
	});
});

// ===========================================================================
// fetchUrl tree path — www host
// ===========================================================================

describe("fetchUrl: GitHub tree (www host)", () => {
	it("www.github.com repository-root URL resolves", async () => {
		mockRepoRootTree([blob("README.md")]);
		const r = await fetchOk("https://www.github.com/owner/repo");
		expect(r.statusCode).toBe(200);
		expect(r.content).toContain("README.md");
	});
});

// ===========================================================================
// fetchUrl blob path — 404 routing, download, text, raw
// ===========================================================================

describe("fetchUrl: GitHub blob", () => {
	it("404 is routed through the API and returns a structured error", async () => {
		contentsGet(
			"https://api.github.com/repos/owner/missing/contents/README.md",
			{ message: "Not Found", documentation_url: "https://docs.github.com/rest" },
			404,
		);
		const r = (await fetchUrl(
			"https://github.com/owner/missing/blob/main/README.md",
		)) as FetchErrorResult;
		expect(r.error).toBeTruthy();
		expect(r.url).toBe("https://github.com/owner/missing/blob/main/README.md");
		expect(r.details?.statusCode).toBe(404);
		expect(r.details?.authenticated).toBe(false);
	});

	it("text-mode blob decodes content and extracts", async () => {
		const content = "# Title\n\nHello world.\n";
		contentsGet(
			"https://api.github.com/repos/owner/repo/contents/README.md",
			{ name: "README.md", path: "README.md", content: Buffer.from(content).toString("base64"), encoding: "base64", size: content.length },
		);
		const r = await fetchOk(
			"https://github.com/owner/repo/blob/main/README.md",
			{ format: "markdown" },
		);
		expect(r.contentType).toContain("text/markdown");
		expect(r.content).toContain("Title");
	});

	it("download-mode blob writes a temp file", async () => {
		const content = Buffer.from("\xff\xd8\xff\xe0JFIF", "latin1");
		contentsGet(
			"https://api.github.com/repos/owner/repo/contents/photo.jpg",
			{ name: "photo.jpg", path: "photo.jpg", content: content.toString("base64"), encoding: "base64", size: content.length },
		);
		const r = (await fetchUrl(
			"https://github.com/owner/repo/blob/main/photo.jpg",
			{ download: true },
		)) as FetchDownload;
		expect(r.error).toBeUndefined();
		expect(r.fileName.endsWith(".jpg")).toBe(true);
		expect(fs.existsSync(r.path)).toBe(true);
		expect(fs.readFileSync(r.path)).toEqual(content);
		fs.rmSync(r.path, { force: true });
	});

	it("binary blob in text mode returns an error prompting download", async () => {
		const content = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
		contentsGet(
			"https://api.github.com/repos/owner/repo/contents/photo.jpg",
			{ name: "photo.jpg", path: "photo.jpg", content: content.toString("base64"), encoding: "base64", size: content.length },
		);
		const r = (await fetchUrl(
			"https://github.com/owner/repo/blob/main/photo.jpg",
		)) as FetchErrorResult;
		expect(r.error).toMatch(/binary blob/i);
		expect(r.details?.contentType).toContain("image/jpeg");
	});

	it("raw-mode blob returns the decoded source unmodified", async () => {
		const content = "plain text body\n";
		contentsGet(
			"https://api.github.com/repos/owner/repo/contents/notes.txt",
			{ name: "notes.txt", path: "notes.txt", content: Buffer.from(content).toString("base64"), encoding: "base64", size: content.length },
		);
		const r = await fetchOk(
			"https://github.com/owner/repo/blob/main/notes.txt",
			{ raw: true },
		);
		expect(r.format).toBe("raw");
		expect(r.content).toContain("plain text body");
	});
});

// ===========================================================================
// fetchUrl blob path — credentials safety
// ===========================================================================

describe("fetchUrl: GitHub blob (credentials safety)", () => {
	it("token never appears in tool output", async () => {
		vi.stubEnv("GITHUB_TOKEN", "ghp_secret-never-leak");
		const content = "public content without credentials";
		contentsGet(
			"https://api.github.com/repos/owner/repo/contents/README.md",
			{ name: "README.md", path: "README.md", content: Buffer.from(content).toString("base64"), encoding: "base64", size: content.length },
		);
		const r = await fetchOk("https://github.com/owner/repo/blob/main/README.md");
		expect(r.content).not.toContain("ghp_secret-never-leak");
	});

	it("api redirect does not carry credentials to another host", async () => {
		vi.stubEnv("GITHUB_TOKEN", "ghp_redirect-secret");
		let authHeader: string | null = null;
		server.use(http.get(
			"https://api.github.com/repos/owner/repo/contents/README.md",
			({ request }) => {
				authHeader = request.headers.get("Authorization");
				return new HttpResponse(null, {
					status: 302, headers: { location: "https://attacker.example/collect" },
				});
			},
		));
		const result = await fetchGithubBlobContent(
			"https://github.com/owner/repo/blob/main/README.md",
		);
		expect("error" in result).toBe(true);
		expect(authHeader).toBe("Bearer ghp_redirect-secret");
		// native fetch follows redirects by default; github.ts uses redirect:"manual"
		// so only ONE request was made (no credentialed redirect followed).
	});
});