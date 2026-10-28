# Reasoning capability discovery

## Contract

`GET /v1/models` publishes `capabilities.thinkingLevels` for LLM models using
`open-sse/providers/thinkingLevels.js:getThinkingLevels(provider, model)`.
For example, the Codex GPT 6.1 Sol registry currently returns
`["low", "medium", "high", "xhigh", "max"]`. This is model/provider-specific,
not a promise that every reasoning model accepts `max`.

- Static fallback and active-connection discovery both publish the registry.
- Custom connection prefixes are resolved to the actual provider identity.
- Combo levels are the intersection of all recursively resolved seats. Empty or
  cyclic combos fail closed; a mixed combo cannot promise a seat's unsupported effort.
- Non-reasoning models publish an empty array. Existing capability fields remain intact.
- Registry levels describe request support, not visible reasoning summaries.
  Missing reasoning summaries are a separate transport/display issue.

Clients should honor explicit `reasoning:false`, intersect advertised values with
levels they understand, and never infer `max` merely from `reasoning:true`.
The companion Pi adapter retains legacy behavior through `xhigh` when metadata is
absent; explicit empty/malformed metadata fails closed.

## Companion client and pin ownership

Adapter: https://github.com/giovannirandykusuma/pi-add-9router,
branch `fix/standalone-thinking-discovery` (adapter-only, MIT, upstream provenance retained).
Shikumi's `stack.json` is the authoritative immutable adapter commit pin:
https://github.com/giovannirandykusuma/shikumi/blob/fix/9router-thinking-discovery/stack.json.
Do not install a moving branch or keep the old npm adapter beside the git fork.
Shikumi's `/shikumi-update` removes the old scoped npm registration before installing
the pinned fork; `/doctor` reports package drift and duplicate registrations.
All production model calls remain routed through `https://strangeshi.com/v1`.
No direct Codex connection or manual `models.json` override is part of this fix.

## Verification

```sh
cd tests
npx vitest run unit/v1-models-thinking-levels.test.js unit/v1-models-combo-context.test.js unit/thinking-levels-gpt56-sol.test.js
cd ..
sh scripts/test-oauth-fork.sh
```

Reviewed source results: 20 focused tests; fork gate 607 passed, 3 intentional skips.
Tests cover supported/unsupported max, static/active discovery, non-reasoning models,
custom prefixes, nested combo intersection and cycles. The adapter independently
checks Pi's real completions transport with mocked network: choosing max produces
`reasoning_effort:"max"` at the configured gateway URL. This is not live deployment proof.

## Deployment and rollback

Deploy only after operator approval. Preserve the fork's existing patches and current
CLI fingerprints (Claude 2.1.310, Codex 0.164.0 for this change). Build off-VPS with
`.github/workflows/fork-image.yml`, selecting the reviewed server commit via `rev`.
Record the resulting image tag, digest and Git revision before deployment.

The private host runbook uses `deploy-ghcr.py` on the VPS. It takes the updater lock,
backs up data/configuration, retains the old container, carries runtime configuration,
and automatically rolls back failed health/marker/auth checks. Never put credentials,
environment values or backups in this repository. Deploy the digest-pinned image,
then verify authenticated `/v1/models` through the public gateway, a fresh Pi session's
discovered supported levels, and a routed max request. Reload affected sessions only
after fresh-process proof. Record actual deployment evidence separately; these source
tests do not claim the deployed system has been updated.
