# Personal OAuth reliability fork

This branch is based on upstream **v0.5.86** (`39e36d3d`). It is an independently maintained selection of upstream pull-request changes, not an upstream release or an endorsement of unmerged PRs.

## Included changes

| Upstream PR | Scope in this fork |
| --- | --- |
| [#2622](https://github.com/decolua/9router/pull/2622) | Preserve reasoning display without literal think tags. |
| [#3984](https://github.com/decolua/9router/pull/3984) | Claude cache accounting and client usage details; additional regression cases. |
| [#4069](https://github.com/decolua/9router/pull/4069) | Preserve optional function-tool arguments through Chat → Responses → Codex. |
| [#3827](https://github.com/decolua/9router/pull/3827) | Preserve xhigh on Claude model families identified by the PR as supporting it; retain existing adaptive display options. |
| [#4078](https://github.com/decolua/9router/pull/4078) | Opt-in per-conversation account selection, with integration coverage for exclusions, model locks, preferred accounts, and interleaving. |
| [#3386](https://github.com/decolua/9router/pull/3386) | Codex SSE context overflow detection and non-fallback HTTP 413. **Excludes unrelated model-list changes.** |
| [#2667](https://github.com/decolua/9router/pull/2667) | One same-account retry for specifically rejected encrypted reasoning history. |
| [#4278](https://github.com/decolua/9router/pull/4278) | Preserve Pi model limits, metadata, and custom provider settings. |
| [#3556](https://github.com/decolua/9router/pull/3556) | Adapted first-byte watchdog with lifecycle tests. **Keeps the existing 200-second prefill deadline**, not the proposed 30 seconds. Clears timers on EOF/cancel and only switches to stall timing after nonempty bytes. |

## Verification

```sh
npm install --ignore-scripts
npm --prefix tests install --ignore-scripts --legacy-peer-deps
sh scripts/test-oauth-fork.sh
npm run build
```

The focused test runner is pinned to Vitest 4.1.11. Tests use synthetic credentials and streams, not live provider accounts. See the release notes for actual executed checks. No benchmark or model-quality improvement is guaranteed.

## Operational notes

- Cache affinity is opt-in via `providerStrategies.<provider>.fallbackStrategy = "cache-affinity"` or the dashboard. It is routing affinity, not storage of prompts. Existing fill-first behavior is unchanged unless enabled.
- Stable explicit `prompt_cache_key` values are preferred. Without one, request-prefix changes (including compaction) can change account selection. Native Responses bodies without a key are not covered by the prefix fallback in this version.
- Higher reasoning effort may cost more and take longer. Model capabilities must be checked against the actual upstream account/model.
- The first-byte watchdog runs in stream piping; it does not add a deadline to every executor's pre-stream work. Existing fetch and provider-specific timeouts remain relevant.
- Invalid encrypted-content recovery removes only rejected top-level reasoning ciphertext on a retry; it cannot preserve reasoning state that the provider refuses to decrypt.
- Old usage database records are not rewritten.
- CLI fingerprint updating must build this pinned fork revision rather than re-cloning an upstream tag and losing these patches.
- This repository contains source only. Keep provider credentials, environment files, request logs, databases, deployment backups, and private host configuration outside it.

## Updating

Retain individual commits and upstream PR links. Rebase onto a reviewed upstream version, remove patches superseded upstream, rerun regression/build checks, and deploy with a database backup and rollback image. Do not automatically merge every upstream commit or PR.
