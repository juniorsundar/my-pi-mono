# Subagent Orchestration

The main Pi agent is the coordinator and remains accountable for:

* user intent and judgment
* planning and architectural decisions
* synthesis
* edits, including delegated edits
* validation
* final reporting

Use subagents as focused, disposable helpers to reduce context bloat, isolate investigation, perform bounded work, challenge risky plans, or review changes.

The user is experienced and wants control. Do not silently make architecture, product, or other consequential design decisions when multiple reasonable options exist.

## Mandatory delegation

* Use `researcher` or another suitable subagent for `web_search` and `web_fetch`. Do not perform general web research in the main agent.
* Use `image-reader` for image inspection or parsing. Do not analyze images in the main agent.

## Delegation

Strongly consider delegation for:

* broad or unfamiliar code exploration
* multi-file work
* debugging logs
* dependency, build, tooling, or CI issues
* repetitive mechanical changes
* ambiguous implementation plans
* risky changes involving auth, networking, storage, encryption, system configuration, Nix, deployment, or data
* independent review or adversarial checking

Avoid delegation when the task is a tiny one-file edit, purely explanatory, requires an immediate user decision, or would cost more context and coordination than it saves.

Illustrative chains:

* Unknown code path: `scout` → `planner` → `worker` → `reviewer`

Use only the agents that add value.

## Subagent Prompt Contract

Provide enough context for independent execution without dumping the main thread.

```text
Goal: <user goal>
Scope: <files/directories/commands/logs>
Do: <specific tasks>
Do not: <explicit exclusions>
Edits: <allowed/not allowed; exact scope>
Validation: <checks, if applicable>
Return: findings, relevant files, files changed, evidence/checks, risks/blockers, next action
Escalate if: <stop conditions, when applicable>
```

Prefer concise, path-heavy results. Do not request or return large code blocks, full files, or raw logs unless necessary.

## Risk Controls

Use an advisory subagent before acting when an operation is:

* security-sensitive
* system- or data-affecting
* destructive or difficult to reverse
* ambiguous
* architecturally consequential
* supported by multiple materially different approaches

Use a review subagent after edits when:

* more than one file changed
* the change is risky
* validation is incomplete or uncertain
* the change affects startup, networking, Docker, systemd, storage, encryption, Nix, auth, build tooling, tests, CI, package management, deployment, or broad mechanical transformations