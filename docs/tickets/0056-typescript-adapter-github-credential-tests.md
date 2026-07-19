### Parent

Spec 0009 — Recoverable Web Fetches and GitHub Resources

### What to build

The TypeScript adapter correctly forwards all GitHub-specific result fields (tree structures, blob content, resolution failures, rate-limit metadata, warnings, `sourceTruncated`, `contentArtifactPath`) to the tool result. Credential confinement is verified end-to-end at this layer.

### Acceptance criteria

- [x] The TypeScript adapter forwards GitHub tree structure results including partial-tree warnings
- [x] The TypeScript adapter forwards GitHub blob content results
- [x] The TypeScript adapter forwards GitHub resolution failure results with structured error details
- [x] The TypeScript adapter forwards rate-limit metadata (remaining quota, reset time, authentication status)
- [x] The TypeScript adapter forwards `sourceTruncated` and `contentArtifactPath` for GitHub resources
- [x] The TypeScript adapter forwards warnings from GitHub operations
- [x] `GITHUB_TOKEN` is verified to be sent only to fixed GitHub API requests (credential confinement test)
- [x] `GITHUB_TOKEN` never appears in tool outputs or content artifacts (credential leak test)
- [x] `GITHUB_TOKEN` is not forwarded to metadata-provided or user-provided redirect URLs
- [x] Tests cover parameter forwarding, timeout selection, schema exposure, and result formatting for all GitHub resource types
- [x] Tests cover credential confinement, credential leak prevention, and host-restriction enforcement

### Blocked by

- 0053 — GitHub repository and tree resource representation
- 0054 — GitHub blob resource and binary download
- 0055 — GitHub resolution failures and rate-limit reporting
