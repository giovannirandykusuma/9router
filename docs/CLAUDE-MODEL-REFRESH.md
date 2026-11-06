# Claude model refresh

This change starts from `d9a19eb5`. It fixes Claude Code model discovery and adds the actual `claude-haiku-5-5` ID without replacing `claude-haiku-4-5-20251001` or rewriting existing client settings.

## Why changing the CLI version was not enough

MAIN supplied read-only upstream observations from November 5, 2026:

- Anthropic `/v1/models` returned the same 14 models, including `claude-haiku-5-5`, with Claude CLI user agents `2.1.310` and `2.1.318`. That request used an account OAuth Bearer token, `anthropic-beta: oauth-2025-04-20`, and `anthropic-version: 2023-06-01`.
- Codex model discovery returned the same 10 models with `client_version=0.164.0` and `0.167.0`.
- npm's latest versions were Claude Code `2.1.318` and Codex `0.167.0`.

Those observations establish that the missing Haiku entry was not unlocked by a newer version header. The source fingerprints now match those versions, but model IDs retain their upstream meaning. Existing Docker build arguments can still patch fingerprints at image build time.

The implementation session did not read production credentials, query live model endpoints, or execute inference. Live observations and official documentation extracts were supplied by MAIN; they were not independently fetched by this worker.

## Discovery and credentials

The Claude discovery resolver uses the registry's authentication contract:

- `authType: oauth`: `Authorization: Bearer <accessToken>` and the OAuth beta header; no `x-api-key`.
- `authType: apikey`: `x-api-key: <apiKey>`; no Bearer credential or OAuth beta header.
- Legacy connections without `authType` infer OAuth when an access token exists, otherwise API-key authentication.

An explicit auth type never borrows the other credential if its selected token is missing. The resolver does not expose upstream error bodies or fetch exceptions in responses or logs, and refuses redirects rather than forwarding credentials. It does not change generic provider authentication, refresh tokens, or persistence. An expired OAuth token still requires the existing connection refresh/reconnect path; this patch does not add another refresh subsystem.

Discovery returns the upstream first page as before. The observed catalog contained 14 entries and did not require pagination. This change does not introduce a cross-provider pagination mechanism.

## Haiku 5.5 request contract

Only the exact Claude-provider model gets the new capability override: 1,000,000 context tokens, 128,000 maximum output tokens, adaptive thinking, and effort levels `low`, `medium`, `high`, `xhigh`, and `max`. Explicit auto/adaptive intent uses `medium`; leaving thinking unspecified preserves the upstream adaptive/medium default. Manual `budget_tokens` input is translated to adaptive effort, never forwarded as a Haiku 5.5 thinking budget. Haiku 4.5 keeps its existing budget behavior.

Disabled thinking is supported at `high` effort or below. A request combining disabled thinking with `xhigh` or `max` is normalized to adaptive thinking instead of sending a combination Anthropic rejects. Forced `tool_choice` (`any` or a named tool) remains supported; this is not the Opus restriction. Thinking tokens share `max_tokens` with the answer.

`temperature`, `top_p`, and `top_k` are removed for this exact provider/model. Changing those controls cannot tune Haiku 5.5 sampling. Use effort to adjust reasoning work. Assistant prefill is rejected upstream; this patch does not rewrite intentional assistant-prefill input into a fabricated user turn. Clients should send a complete conversation ending in a user or tool-result turn. The default thinking response can have empty thinking text plus a signature; an empty text field alone is not evidence that thinking was disabled.

Official sources supplied and checked by MAIN:

- [Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Long-context pricing](https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing)

## Pricing estimates

Haiku 5.5 is not assigned a universal flat rate or the older Haiku wildcard. Its Claude-provider price has a base tier and a whole-request long-context tier. Rates below are USD per million tokens:

| Total prompt tokens | Input | Output | Cache read | Cache write, 5 minutes |
| --- | ---: | ---: | ---: | ---: |
| At most 100,000 | 0.10 | 0.50 | 0.01 | 0.125 |
| More than 100,000 | 0.50 | 2.50 | 0.05 | 0.625 |

The threshold includes all input, including cache reads and cache writes. Exactly 100,000 stays in the lower tier; 100,001 selects the higher rates for the entire request, not just the excess. Each request is evaluated independently. Raw Anthropic usage is canonicalized once; canonical cache-inclusive usage is not counted twice.

**Estimate limitation:** the existing usage pipeline does not preserve cache-write TTL. The calculation retains its existing 5-minute cache-write assumption. Official 1-hour write rates are 0.20 and 1.00 in the two tiers, so requests using 1-hour writes are underestimated. This patch does not add TTL tracking or alter the schema. Static pricing consumers see base-tier fields; accurate request cost requires `calculateCostFromTokens`, which selects the applicable tier. Explicit user pricing continues to override built-in pricing, including choosing a flat custom rate.

Persisted request costs and API-key monthly budget enforcement use that same calculation. Focused integration coverage verifies that a 100,001-token prompt persists the higher cost and trips a budget that the lower tier would not exhaust.

## Validation

Tests use mocked discovery requests and temporary local SQLite data only. No provider inference calls are part of validation.

The focused red baseline was captured in `/tmp/claude-refresh-red.log`: both new files failed (26 failures, one pass). It demonstrated the wrong discovery header/credential selection, leaking error text, missing catalog entry, budget-shaped thinking, wrong defaults, stale fingerprints, and old CLI mapping. One assertion about an unchanged provider's existing disable capability was corrected after inspection; it was not a product failure. A second run in `/tmp/claude-refresh-pricing-red.log` had 31 passes and only three pricing failures, showing the existing Haiku wildcard rates were wrong at both tier boundaries and for cached input.

Dependency preparation used a private copy of `../storm-provider-flow/node_modules` plus `npm install --no-save --package-lock=false --ignore-scripts vitest@3.2.4`. No tracked package manifest, lockfile, or test dependency symlink was changed. This checkout has no committed root lockfile; dependency resolution remains non-reproducible beyond the observed local versions.

Commands and observed results:

```sh
# Focused gate: 4 files, 36 tests passed.
cd tests
../node_modules/.bin/vitest run unit/claude-models-discovery.test.js unit/claude-haiku-5-5.test.js unit/claude-models-pricing-budget.test.js unit/opencode-go-claude-haiku-55-thinking.test.js
cd ..

# Existing affected OAuth gate: 51 files, 607 passed, 3 skipped.
PATH="$PWD/node_modules/.bin:$PATH" sh scripts/test-oauth-fork.sh

# Additional affected model/parameter/pricing/route coverage.
cd tests
../node_modules/.bin/vitest run unit/claude-haiku-adaptive-thinking.test.js unit/claude-opus-5-5.test.js unit/claude-sonnet-5-5.test.js unit/github-claude-5-5-thinking.test.js unit/kiro-claude-opus-5-5.test.js unit/antigravity-claude-5-5.test.js unit/param-support.test.js unit/capabilities.test.js unit/provider-thinking-config.test.js unit/thinking-budget-max-level.test.js unit/codex-registry-model-routing.test.js unit/codex-image-models.test.js unit/nous-provider-routes.test.js unit/zed-live-models.test.js unit/provider-pricing-minimax-m3.test.js --maxWorkers=2
cd ..

node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs

# Changed-file lint: 0 errors, two existing anonymous-default-export warnings.
node_modules/.bin/eslint open-sse/providers/registry/claude.js open-sse/providers/registry/codex.js open-sse/providers/shared.js open-sse/providers/capabilities.js open-sse/providers/pricing.js open-sse/providers/thinkingLevels.js open-sse/translator/concerns/paramSupport.js open-sse/translator/concerns/thinkingUnified.js 'src/app/api/providers/[id]/models/route.js' 'src/app/api/providers/[id]/models/claudeModels.js' src/shared/constants/cliTools.js tests/unit/claude-models-discovery.test.js tests/unit/claude-haiku-5-5.test.js tests/unit/claude-models-pricing-budget.test.js tests/unit/opencode-go-claude-haiku-55-thinking.test.js tests/unit/capabilities.test.js

# Passed: Next.js 16.4.2 webpack production build, including postbuild assets.
NEXT_TELEMETRY_DISABLED=1 npm run build
git diff --check
```

The first additional affected run had 158 passes and one stale expectation that Claude Haiku 5.5 should remain budget-based (`tests/unit/capabilities.test.js`). That expectation was updated with MAIN's approval; global and old Haiku fallback guards remain. The red output is retained in `/tmp/claude-refresh-affected.log`. The corrected rerun passed all 159 tests in 15 files (`/tmp/claude-refresh-affected-green.log`).

Alias and OAuth URL snapshots pass. The provider snapshot already fails at unchanged HEAD for three unrelated differences: OpenCode Go's Gemini transport, and the added Sensenova and Runcrate providers. A temporary `git archive HEAD` comparison reproduced all three; no unrelated baseline refresh is included. The initial current comparison additionally reported the two intended CLI fingerprint changes. With MAIN's approval, only the Claude User-Agent and Codex cliVersion/User-Agent/version snapshot literals were refreshed. The final provider snapshot has exactly the same three unrelated failures as HEAD (`/tmp/claude-refresh-baseline-providers-final.log`). No other fixture fields changed.

Active LSP probes found no diagnostics but could not confirm clean results for any of the 15 paths (timeouts or silent-on-clean servers). This is inconclusive evidence, not an LSP clean claim. ESLint, focused runtime tests, affected regression gates, and the production build provide the actual checks. No full-suite run was requested or performed.

## Round-one review correction

The fresh judge rejected the first diff because internal `contextTiers` leaked into the editable pricing API. `PricingModal` sends its entire loaded configuration on Save, and the existing scalar-only PATCH validator correctly rejected the array with HTTP 400. This broke saves for unrelated providers too. The same leak affected the modal's `getDefaultPricing()` fallback and reset responses.

The correction serializes only the five editable scalar rate fields for GET, PATCH, DELETE, defaults, and the modal's failure fallback. Cost lookup retains internal tiers. The PATCH validator still rejects user-supplied tier objects; no new configurable tier API was added.

A second precaution prevents a successful full-payload save from converting an untouched Haiku base estimate into a flat custom rate. When effective cost lookup still resolves to built-in tiers and every submitted rate equals that model's base rate, PATCH omits that model from persistence. Partial unchanged base updates have the same meaning. Changed scalar rates, including zero, remain explicit custom flat rates. Existing custom flat pricing is detected by the effective DB lookup and is preserved even when its numbers equal the base. Intentional interpretation: submitting unchanged base values without an existing custom override means “keep the built-in,” not “create a new flat override.” Other provider persistence behavior remains unchanged.

New temporary-SQLite API tests cover full GET-to-PATCH saves after an unrelated edit, cache-inclusive higher-tier cost before and after saving, absence of a persisted Haiku override, defaults/fallback, all/model/provider reset responses, partial updates, zero rates, an existing custom flat price equal to base, and rejected submitted tiers. The focused red run reproduced three failures and one pass in `/tmp/claude-refresh-round1-red.log`. Discovery coverage now explicitly asserts mocked fetch `redirect: "error"`, closing the judge's surviving redirect mutation.

Round-one commands (run from the repository root unless noted):

```sh
cd tests
../node_modules/.bin/vitest run unit/claude-models-pricing-api.test.js unit/claude-models-discovery.test.js unit/claude-haiku-5-5.test.js unit/claude-models-pricing-budget.test.js unit/opencode-go-claude-haiku-55-thinking.test.js
cd ..
PATH="$PWD/node_modules/.bin:$PATH" sh scripts/test-oauth-fork.sh
# The same 15-file affected command above was rerun unchanged.
node_modules/.bin/eslint open-sse/providers/pricing.js src/app/api/pricing/route.js tests/unit/claude-models-pricing-api.test.js tests/unit/claude-models-discovery.test.js
NEXT_TELEMETRY_DISABLED=1 npm run build
git diff --check
```

Round-one final results: all 44 focused tests passed in five files (`/tmp/claude-refresh-round1-focused-final.log`); all 159 affected tests passed (`/tmp/claude-refresh-round1-affected.log`); the existing OAuth gate passed 607 tests with three skipped (`/tmp/claude-refresh-round1-oauth.log`). Correction-file ESLint passed with no warnings or errors, including a final rerun after test additions. The Next.js 16.4.2 production build and standalone postbuild passed (`/tmp/claude-refresh-round1-build.log`), and `git diff --check` passed. No tracked manifests, lockfiles, or dependency links changed. The additional API tests verify directly in SQLite that untouched Haiku pricing was not persisted, and cover model-scoped and provider-scoped resets.

The four round-one LSP probes were again inconclusive (no published findings, no confirmed clean result). No component appearance changed, production credentials were not accessed, and no live provider requests were made.

Security note: authentication tests verify a single selected credential on the wire and no credential echo through failure responses or logs. Model metadata and CLI defaults are not authorization controls; account entitlement still determines the live catalog. The documentation file is ignored by this repository's existing `docs/*` rule; a later authorized commit must explicitly include it if desired.
