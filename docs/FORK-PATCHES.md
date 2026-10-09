# Personal OAuth reliability fork

This branch is based on upstream **v0.5.86** (`39e36d3d`). It is an independently maintained selection of upstream pull-request changes, not an upstream release or an endorsement of unmerged PRs.

## Included changes

| Upstream PR | Scope in this fork |
| --- | --- |
| [#2622](https://github.com/decolua/9router/pull/2622) | Preserve reasoning display without literal think tags. |
| [#3984](https://github.com/decolua/9router/pull/3984) | Claude cache accounting and client usage details; additional regression cases. |
| [#4069](https://github.com/decolua/9router/pull/4069) | Preserve optional function-tool arguments through Chat → Responses → Codex. |
| [#3827](https://github.com/decolua/9router/pull/3827) | **Superseded in v0.5.95** — upstream now gates xhigh for claude-adaptive itself (all Claude except 4.6 models). Fork version of `thinkingLevels.js`/`thinkingUnified.js` dropped in favour of upstream during the v0.5.95 merge. |
| [#4078](https://github.com/decolua/9router/pull/4078) | Opt-in per-conversation account selection, with integration coverage for exclusions, model locks, preferred accounts, and interleaving. |
| [#3386](https://github.com/decolua/9router/pull/3386) | Codex SSE context overflow detection and non-fallback HTTP 413. **Excludes unrelated model-list changes.** |
| [#2667](https://github.com/decolua/9router/pull/2667) | One same-account retry for specifically rejected encrypted reasoning history. |
| [#4278](https://github.com/decolua/9router/pull/4278) | Preserve Pi model limits, metadata, and custom provider settings. |
| [#3556](https://github.com/decolua/9router/pull/3556) | Adapted first-byte watchdog with lifecycle tests. **Keeps the existing 200-second prefill deadline**, not the proposed 30 seconds. Clears timers on EOF/cancel and only switches to stall timing after nonempty bytes. |
| [#3595](https://github.com/decolua/9router/pull/3595) | Model-context dashboard, persisted exact provider/model overrides, capability propagation, validation, and reset-to-current-default semantics. **Excludes glob/global overrides and all unrelated compatibility, statistics, schema, and retry changes.** |
| [#4241](https://github.com/decolua/9router/pull/4241) | Per-API-key limits (RPM, daily/monthly tokens incl. input/output, monthly requests, monthly USD budget; HTTP 429 + `Retry-After`) and usage meters on Endpoint/Usage pages. **Merged with upstream v0.5.99 per-key access control** (both column sets in `apiKeys`, both survive export/import). Also wired into the System One handler, which postdates the PR. |

## Verification

```sh
npm install --ignore-scripts
npm --prefix tests install --ignore-scripts --legacy-peer-deps
sh scripts/test-oauth-fork.sh
npm run build
```

The focused test runner is pinned to Vitest 4.1.11. Tests use synthetic credentials and streams, not live provider accounts. Initial unfiltered verification: **184 passed, 1 failed**. The one failure, `GLM-5.2 also gets reasoning_effort (supported from 5.2 onward)`, reproduces identically on pristine v0.5.86 (64 passed, 1 failed in that upstream file). It is not modified or hidden; the OAuth deployment gate explicitly excludes only this unrelated baseline case. No benchmark or model-quality improvement is guaranteed.

Optional Docker build arguments `CLAUDE_CLI_VERSION` and `CODEX_CLI_VERSION` override the upstream constants at build time. Record the exact Git commit, versions, and image ID for each deployment.

## Operational notes

- Cache affinity is opt-in via `providerStrategies.<provider>.fallbackStrategy = "cache-affinity"` or the dashboard. It is routing affinity, not storage of prompts. Existing fill-first behavior is unchanged unless enabled.
- Model-context overrides are exact canonical `provider/model` keys and alter only total context metadata. They do not alter `maxOutput`; reset deletes the override so future registered defaults remain authoritative.
- Stable explicit `prompt_cache_key` values are preferred. Without one, request-prefix changes (including compaction) can change account selection. Native Responses bodies without a key are not covered by the prefix fallback in this version.
- Higher reasoning effort may cost more and take longer. Model capabilities must be checked against the actual upstream account/model.
- The first-byte watchdog runs in stream piping; it does not add a deadline to every executor's pre-stream work. Existing fetch and provider-specific timeouts remain relevant.
- Invalid encrypted-content recovery removes only rejected top-level reasoning ciphertext on a retry; it cannot preserve reasoning state that the provider refuses to decrypt.
- Old usage database records are not rewritten.
- Per-key token/budget limits are computed from `usageHistory` after responses complete, so concurrent in-flight requests can overshoot slightly; RPM is exact per process. Limit checks fail open on internal errors. Windows follow server local time.
- CLI fingerprint updating must build this pinned fork revision rather than re-cloning an upstream tag and losing these patches.
- This repository contains source only. Keep provider credentials, environment files, request logs, databases, deployment backups, and private host configuration outside it.

## Updating

Retain individual commits and upstream PR links. Rebase onto a reviewed upstream version, remove patches superseded upstream, rerun regression/build checks, and deploy with a database backup and rollback image. Do not automatically merge every upstream commit or PR.
