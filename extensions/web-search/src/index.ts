/**
 * web-search: TypeScript barrel for the ported web-search surface.
 *
 * Re-exports the in-process `search()` and `fetchUrl()` entry points (and
 * their public types) from the per-module files. `index.ts` imports from
 * here at the final cut (#0009) instead of shelling out to `scripts/*.py`.
 *
 * Phase 2 parallel-then-cut: this barrel is the cut. Before it existed,
 * `index.ts` ran `uv run --project . python scripts/search.py` /
 * `scripts/fetch.py`; now both tools call these functions in-process.
 */

export {
	search,
	buildSearxngUrl,
	normalizeResult,
	clampMaxResults,
	CATEGORIES_CHOICES,
	LANGUAGE_CHOICES,
	type SearchParams,
	type SearchResponse,
	type SearchResult,
	type SearchOptions,
} from "./search.js";

export {
	fetchUrl,
	runDownload,
	fetchResponse,
	validateUrl,
	isPrivateOrLocalAddress,
	isDownloadSupported,
	isBinaryContent,
	mediaTypeOf,
	extensionFor,
	isSupportedContentType,
	downloadJson,
	successJson,
	errorJson,
	dnsResolver,
	FetchError,
	_resetSsrfCache,
	type FetchResult,
	type FetchSuccess,
	type FetchDownload,
	type FetchErrorResult,
	type FetchOptions,
} from "./fetch.js";

export {
	classify,
	isGitHubResource,
	resolveRef,
	fetchGithubResource,
	fetchGithubBlobContent,
	fetchGithubTree,
	renderTree,
	type Classified,
	type GitHubResource,
	type NonSpecialized,
	type ResourceType,
	type ResolvedRef,
	type GhResourceSuccess,
	type GhResourceResult,
	type GhBlobSuccess,
	type GhBlobResult,
	type GhTreeSuccess,
	type GhTreeResult,
	type GhTreeData,
	type TreeEntry,
	type RenderFormat,
} from "./github.js";

export {
	process as processRepresentation,
	categorizeContent,
	decodeBody,
	normalizeWhitespace,
	truncate,
	writeContentArtifact,
	type PipelineResult,
	type ProcessOptions,
	type OutputFormat,
	type ContentCategory,
} from "./representation.js";