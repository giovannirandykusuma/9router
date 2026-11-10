# Upstream v0.5.116 integration

## Scope and history

Work is confined to `personal/upstream-0.5.116`. No push, image publication, production access, credential reads, or live provider inference is authorized here. Two unintentional isolation/network issues during initial validation are disclosed below; neither is treated as acceptable validation. MAIN owns independent review, image verification, publication, and deployment.

Starting commit: `49979f05727b37305c18bb8a25d51332a29d22c3` (personal Haiku refresh), with upstream `v0.5.116` at `1339107e624d1ab150c6a0c2c2ee22caa7e9db2f`. The remote default also contained `d8b2445efac03cc470db0a8eb2bb195e017ccf30`, deployment documentation on a divergent ancestor. A fast-forward-only attempt refused without changing history. Local merge `d0a348d71dd36a75da8ba98578c81d58d8200bfb` preserves it; its exact parents are `49979f05727b37305c18bb8a25d51332a29d22c3` and `d8b2445efac03cc470db0a8eb2bb195e017ccf30`. That merge contains documentation only; no executable changes required tests at that checkpoint. Upstream integration uses a normal merge, never reset/rebase or wholesale ours resolution.

## Resolutions and preservation

Three textual conflicts were read in full and resolved as unions of behavior:

- `next.config.mjs`: retain both usage report/export worker asset entries and upstream's wildcard real-undici tracing. `undici` remains external, so Node's vendored fetch cannot receive an incompatible undici 8 dispatcher.
- `open-sse/providers/registry/opencode-go.js`: adopt upstream's new inference chat, Anthropic Messages, Responses, usage, and model catalog URLs and Messages adaptive-thinking format. Retain the fork's Gemini-native transport and Argon-only model lane. Its executor still appends Gemini generate/stream suffixes and uses `x-goog-api-key`; Responses moves to the upstream inference endpoint.
- `open-sse/translator/concerns/thinkingUnified.js`: pass upstream's dynamic OpenAI-compatible-node budget flag into `applyFormat`, then retain the fork's exact Haiku disabled-thinking/allowed-effort restoration. CommandCode effort normalization is retained too.

Automatic merges were inspected at chat dispatch, base/default transport retries, runtime configuration, provider resolution, Gemini conversion, parameter filtering, registry models, image adapter, and CLI runtime/build/launcher surfaces. New upstream features are retained, including explicit DeepSeek budgets on compatible hosts, thinking continuation on tool results, full Gemini result/follow-up parts, native Codex image generation and error handling, OpenCode tool aliases, fresh-socket replay, commandcode headers/import, quota reporting, CLI dependency loading and local runtime installation scope.

The fork's MCP gateway and OAuth/CIMD surfaces, per-key provider/account restrictions, usage report/export implementation, trusted-peer custom server, Storm/concurrency lifecycle logic, exact Haiku model capabilities/pricing tiers/scalar save guards, Claude discovery and OAuth sanitization, shared CLI fingerprints, and generated CLI defaults are unchanged from the preserved personal parent. The integration test gates exact Haiku effort through an OpenAI tool-result continuation; the focused fork tests gate disabled-thinking levels, pricing tier saves, credential selection, sanitized metadata, Claude `2.1.318`, Codex `0.167.0`, new generated Haiku default, and explicit Haiku 4.5 retention.

### Security correction

Upstream adds `/api/oauth/commandcode/auto-import`, which returns a host-file API key. The fork's existing guard protects auto-import routes individually; without extending it, this new route could disclose credentials remotely when dashboard login is disabled. Added the route to both `LOCAL_ONLY_PATHS` and `ALWAYS_PROTECTED`, matching Cursor/Kiro/Zed behavior. A red test run reproduced remote access and unauthenticated loopback access with `requireLogin=false`. The correction preserves CLI-token access without relaxing any MCP or API-key policy. All credential fixtures are mocked.

### Portable upstream test correction

The upstream CLI launcher test compared a Vitest worker PID with the real executable name. On this macOS/Node 26 environment, `ps -o comm=` returns Vitest's rewritten `process.title` (`node (vitest 1)`), so the assertion fails even though plain Node is recognized. A direct plain-Node reproduction showed `true` before setting `process.title`, and `false` afterward. The test now checks a plain Node child; no production matching logic is weakened, especially the PID-reuse protection. Windows/Linux production validation remains outside this checkout gate.

## Dependencies, transport, and packaging

Private dependency preparation copied (not symlinked) `../claude-model-refresh/node_modules`, then attempted `npm install --no-save --package-lock=false --ignore-scripts vitest@3.2.4`. The install timed out at 900 seconds with no output. Its resulting private tree has runnable Vitest `3.2.4`, Next `16.4.2`, and undici `8.12.4` satisfying upstream `^8.12.3`. A subsequent offline install attempt was deliberately stopped before continuing tests; no successful npm-install claim is made. No other workspace dependencies were mutated, and the existing `tests/node_modules` symlink was not changed or used for installation. No root lockfile was created and tracked manifests/locks have only upstream's intended changes.

Local Node is `26.10.0`. Installed undici 8 declares `node >=22.19.0`; the unchanged fork Dockerfile uses `node:22.23.4-alpine`, meeting that engine range. The fork image workflow, revision labels, build fingerprint arguments, digest/immutable-tag contract, and Docker report-worker checks remain unchanged. An exact `node:22.23.4-alpine` container smoke passed using undici 8.12.4, its own Agent and fetch, and a loopback HTTP server returning 200, with container `--network=none` (`docker-runtime.log`). The pulled base digest was `sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202`. This proves real Node 22/Alpine package/dispatcher execution, not the final application image; MAIN must still run its off-VPS image gate and verify standalone undici, worker execution, and actual labels/digest before deploying. No new dependency beyond upstream's intended undici update is introduced.

## Validation commands and outcomes

Logs are local `/tmp/upstream-116-*.log`; no credential-bearing logs are committed. Commands run from repository root unless noted. No real-provider test files or paid inference are run. Initial legacy transport unit tests unexpectedly reached external endpoints because upstream changed the fetch boundary; this incident is disclosed below.

### Focused first

```sh
cd tests
../node_modules/.bin/vitest run unit/upstream-0-5-116-integration.test.js unit/claude-models-pricing-api.test.js unit/claude-models-discovery.test.js unit/claude-haiku-5-5.test.js unit/claude-models-pricing-budget.test.js unit/opencode-go-claude-haiku-55-thinking.test.js translator/thinking-tool-result-turns.test.js unit/gemini-request-tool-results.test.js unit/deepseek-thinking-budget.test.js unit/opencode-go-deepseek-thinking-injection.test.js unit/opencode-go-gemini-argon.test.js --maxWorkers=2
```

Passed: 11 files, 75 tests (`focused.log`). The later added Haiku OpenAI tool-result intersection passed in a separate five-test rerun (`intersections-green.log`). An archive of preserved parent d0a348d7 with the initial four intersection tests reproduced three failures: missing undici tracing/external package, old OpenCode endpoints, and dropped dynamic DeepSeek budget (`intersections-red.log`). The unchanged Claude-wire tool-result case passed on that base. The new test therefore detects actual upstream/fork intersection behavior, rather than asserting only file contents.

### Upstream feature tests

All 37 changed/added non-real upstream test files were selected from `git diff d0a348d7 --name-only --diff-filter=ACMR -- tests`, filtering `.test.js` and excluding `/real/`, and run with `--maxWorkers=2` using private root Vitest. Initial result: 36 files passed, 430 tests passed, one todo, one CLI launcher assertion failed (`upstream-tests.log`). The complete trace was read before classifying the macOS process-title mismatch described above. Its corrected file is rerun separately; no test is silently excluded.

### Additional fork affected coverage

```sh
cd tests
../node_modules/.bin/vitest run unit/claude-haiku-adaptive-thinking.test.js unit/claude-opus-5-5.test.js unit/claude-sonnet-5-5.test.js unit/github-claude-5-5-thinking.test.js unit/kiro-claude-opus-5-5.test.js unit/antigravity-claude-5-5.test.js unit/param-support.test.js unit/capabilities.test.js unit/provider-thinking-config.test.js unit/thinking-budget-max-level.test.js unit/codex-registry-model-routing.test.js unit/codex-image-models.test.js unit/nous-provider-routes.test.js unit/zed-live-models.test.js unit/provider-pricing-minimax-m3.test.js unit/sse-concurrency.test.js unit/live-concurrency.test.js unit/live-concurrency-transport.test.js --maxWorkers=2
```

Passed: 17 files, 173 tests (`fork-affected.log`). Vitest ignored the nonexistent `live-concurrency-transport.test.js` path; no coverage is claimed for that name. The actual chat-concurrency and tool-deduper files are run in the correction gate.

### Existing OAuth gate, build, lint, snapshots

```sh
PATH="$PWD/node_modules/.bin:$PATH" sh scripts/test-oauth-fork.sh
NEXT_TELEMETRY_DISABLED=1 npm run build
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
```

Alias and OAuth URL snapshots pass. Provider verification and a fresh preserved-parent archive comparison (`providers-base.log`) have exactly the previously recorded three drift categories: the retained OpenCode Gemini transport, Sensenova, and Runcrate. Upstream's own expected endpoint/thinking/header baseline changes are retained, and fork Claude/Codex fingerprint snapshots are not downgraded. No broad fixture repair is included.

Changed-source ESLint initially reports one `react-hooks/set-state-in-effect` error at the unchanged `setLocalEndpoint(window.location.origin)` in `GenericExampleCard.js`, plus anonymous-default-export and image warnings. A baseline-source comparison reproduces that same error before integration (`base-lint.log`). A second changed-source lint run disabling only that existing rule passes with the same nine warnings (`lint-no-baseline-rule.log`); no tracked lint configuration or unrelated UI source is changed. CLI CommonJS files follow their existing lint ignores; no clean CLI lint coverage is implied.

Active LSP checks on seven integration paths published no findings but timed out on all seven; these are inconclusive, not confirmed clean. Runtime tests, ESLint evidence, and production build are the executable gates. No unrelated full suite is requested.

## Initial validation incidents and corrections

The first OAuth run failed with eight 5-second timing failures across key model restrictions, context API, usage export/worker, and thinking discovery while a CPU-heavy Next build and other test jobs ran concurrently. It also had one worker RPC timeout and one real functional test-mock mismatch. Its full failure trace was read, not classified from the summary alone (`oauth.log`: 598 passed, nine failed, three skipped, one worker error). Those timing failures are not accepted as baseline; the gate is rerun without a concurrent build, maxWorkers=2, and fresh private HOME/DATA_DIR.

The functional mismatch was `claude-header-forwarding.test.js`'s old got-scraping/global-fetch mocks. Upstream now imports fetch from package undici, so these mocks did not intercept two POST requests: the Anthropic Messages endpoint (`https://api.anthropic.com/v1/messages`) and OpenRouter's chat-completions endpoint (`https://openrouter.ai/api/v1/chat/completions`). Both bodies were literal `{}`; the only request header was `Content-Type: application/json`. No Authorization/API-key header or application credential was supplied by those test calls or added by proxyAwareFetch. The Anthropic assertion establishes `res.ok === false`; exact HTTP statuses/bodies were not logged. The OpenRouter test did not assert status. No new external reproduction was attempted and no inference result was requested. Proxy environment settings may have affected routing; no secret values are inspected or reported.

Replaced all three obsolete routing cases with same-package fetch/dispatcher tests (including direct Anthropic, other host, and proxy). The undici module is fully mocked, only the two expected URL literals are accepted, and a throwing global-fetch sentinel detects accidental fallback. No new test is skipped and the old now-irrelevant exclusion in the gate script matches no test. The initial package-undici focused run exposed two new mock assertion mistakes (TLS verification defaults to enabled by omission, and the connection proxy field is `url`, not `proxyUrl`), plus the already excluded stale fingerprint assertion expecting 2.1.280 rather than the preserved 2.1.318. Corrected the two mock assertions; the fingerprint exclusion remains unchanged and exact 2.1.318 is asserted by the Haiku gate. The initial mock migration is not counted as passing evidence. The corrected isolated one-worker focused transport run passes 21 cases with the pre-existing stale-fingerprint case excluded (`transport-green.log`); no new exclusion was added. The first isolated OAuth run loaded those assertions before their correction and failed them; it also still had eight 5-second timing failures (600 passed, 11 failed, two skipped, no worker RPC error). Those remain unresolved pending a one-worker rerun after build. No tracked test timeout or production performance code is silently changed. A subsequent one-worker unchanged-timeout gate still failed five timing checks: both key-filtered static catalog cases, context POST validation/persistence, and the large usage export fixture (`oauth-serial-final.log`: 606 passed, five failed, two skipped). Those traces show synchronous operations completing beyond the five-second timer budget, not network fetch exceptions. The catalog/context/usage implementation files are unchanged by upstream integration. A preserved-parent then merged three-file diagnostic control is run sequentially with identical one-worker settings and an explicit 120-second diagnostic budget to measure complete assertion durations, not to silently redefine the acceptance gate.

The first Next build used the default DATA_DIR unintentionally, and nine page-data workers printed the local `~/.9router/db/data.sqlite` path. I did not query or inspect that database, but module initialization can open/migrate it; I cannot claim no local state access occurred. The build compiled webpack/types and generated all 157 static pages, then timed out after 1200 seconds during file tracing. It is not a successful production-build result. MAIN was notified immediately upon inspection. All subsequent build/test commands use a new private HOME and DATA_DIR. The final isolated production build used `CIRCLE_NODE_TOTAL=1` and ran only after tests finished. It passed webpack compilation, type checking, all 157 static pages, tracing and standalone postbuild (`build-isolated.log`, exit 0). The generated standalone contains real undici 8.12.4 and its package engine declaration; the report worker source/assets are preserved.

Security guard correction gate passes five files, 63 tests (`corrections.log`), including actual guard invocations for CommandCode remote unauthenticated requests, unauthenticated loopback with login disabled, and valid CLI token, plus chat-concurrency/tool-dedup and route auto-import fixture tests. Guard red run had the two expected unauthorized-access failures before the fix (`commandcode-guard-red.log`). Portable launcher regression file passes all 27 tests (`cli-green.log`).

## Timing control and explicit bounded rerun

After reading all five one-worker failure traces, preserved parent and merged checkout ran the same three failing files sequentially with one worker, separate private HOME/DATA_DIR, identical copied dependency versions, verbose reporter, and an explicit 120-second diagnostic test/hook budget. Both passed all 96 assertions (`base-timing.log`, `merge-timing.log`). No network errors or assertion failures occurred. Complete per-test durations:

| Operation | Preserved parent | Merged checkout |
| --- | ---: | ---: |
| Key-filtered full catalog | 8.860 s | 12.693 s |
| Kind/single-model catalog lookups | 6.822 s | 8.080 s |
| Context GET | 7.558 s | 7.364 s |
| Context invalid-input checks | 13.545 s | 18.197 s |
| Context persistence/reset | 17.914 s | 30.823 s |
| Large usage export fixture | 3.855 s | 5.928 s |

Base total: 88.54 s; merged total: 120.44 s. These controls prove the default five-second threshold is insufficient for several unchanged base operations on this host. They do not prove identical performance: merged was slower on several cases, and changing shared-host load is not controlled. No production performance optimization is folded into this merge. With these measured controls, the exact OAuth file list/name filters is rerun using a private npx wrapper that removes only the script's `--maxWorkers=2` argument and appends `--maxWorkers=1 --testTimeout=120000 --hookTimeout=120000`. No tracked test or script timeout changes. The unmodified/default-budget failures remain disclosed even if the explicit bounded gate passes.

## Final evidence checkpoint

MAIN relayed the user's expedited off-Mac boundary: do not launch more heavy local runs; preserve failures/limits, commit locally, and hand back for fresh review and GitHub Actions regression/image gates. The explicit bounded full OAuth rerun was stopped after approximately two minutes on that instruction (`oauth-bounded.log`); no completion/pass is claimed. No tracked CI/test timeout is changed. Standalone relocated worker HTTP smoke and a final combined affected rerun are deferred to MAIN off-Mac; individual source gates and the successful isolated production build remain valid evidence.

Final correction ESLint passed with one existing registry anonymous-default-export warning (`correction-lint.log`); the later transport assertion/URL fixture edits are small test-only changes exercised by the successful focused transport run. General changed-source lint retains the explicitly reproduced base `set-state-in-effect` error; the run disabling only that rule passed. LSP remained inconclusive. The one trailing blank line introduced upstream in `antigravity-quota-routing.test.js` was removed solely to pass merge whitespace checking.

Local merge is authorized for handback despite incomplete acceptance. Its exact parents must be `d0a348d71dd36a75da8ba98578c81d58d8200bfb` and `1339107e624d1ab150c6a0c2c2ee22caa7e9db2f`. Use `git show -s --format='%H %P' HEAD` for the final SHA rather than treating this report as acceptance proof. A different fresh judge must review the integrated diff, the CommandCode host-secret gate, transport mock migration, preservation evidence, and remaining limits. MAIN owns off-Mac default regression, relocated standalone/image checks, image labels/digest verification, any push, and deployment. No push or deploy occurred here.

Security warning: the CommandCode credential route boundary is fixed and tested, but local validation had the disclosed unisolated database initialization and two unauthenticated external test requests. No production credential was intentionally read or attached, no secret is included in the report, and no live inference was requested. Do not omit these incidents or claim a fully green/default-budget gate in the shipping decision.

## Round-one independent review correction: undici Web API realms

Fresh judge `/tmp/upstream-0116-verdict.json` rejected `5b79642d` for an upstream-inherited multipart regression: package undici 8 brand-checks its own FormData and stringifies Node's global FormData to `[object FormData]`. The actual OpenAI-compatible STT path, other STT upload paths and Cloudflare uploads were affected. A global Request input also failed URL parsing. The original mocked tests and MAIN-reported off-Mac gate could not detect either issue. The complete verdict and five loopback reproductions were read before correction; no upstream/fork preservation defect was found by that judge.

The boundary correction in `open-sse/utils/proxyFetch.js` rebuilds global FormData into package FormData by iterating entries, retaining duplicate names, File/Blob values, filenames and MIME types without buffering file contents. It does not replace any global constructor. A built-in Request input is first resolved with its own constructor and the supplied init so standard URL, method, headers, body, body-used, signal and init override semantics are preserved before proxy selection. That resolved request is passed as URL plus init to package fetch. Retry safety now rejects disturbed as well as locked Web streams, so a consumed Request stream cannot be replayed after a response-phase reset. Existing string/JSON fresh-socket retry behavior, TLS defaults, strict-proxy policy, authentication, and dispatcher ownership are retained.

Responses intentionally remain package-undici Response instances. Their body/status/headers work with a global `new Response(...)` wrapper, verified without buffering. The patch-site comment documents that a Next route must rewrap rather than directly return that foreign instance; the judge found no current direct-return caller. This low-severity identity caveat is documented, not hidden by constructor replacement.

New `scripts/check-fetch-web-api.mjs` is a real-fetch Node test control, not a stub. It starts only loopback servers, sets all outbound proxy variables to the closed loopback port, permits loopback NO_PROXY, and uses a loopback-only forwarding/CONNECT proxy that rejects other destinations. It exercises repeated multipart fields, multiple filenames/content types, actual `handleSttCore` OpenAI-compatible upload with a synthetic key, string/URLSearchParams/Blob bodies, Request method/header/body/signal overrides, streaming duplex, already-used requests, locked streams, abort, consumed-body reset with exactly one POST, successful proxy upload, strict proxy refusal, constructor identity preservation and stream rewrapping. Servers/sockets are closed in finally blocks. The script is now required before the existing OAuth gate and is mounted into the final runtime image smoke with `docker run --network=none`, so CI tests the actual packaged Node/undici rather than relying on mocks.

Focused commands and actual outcomes:

```sh
# Each host invocation used a new private HOME and DATA_DIR.
node scripts/check-fetch-web-api.mjs
# Red before fix: 5 failures, 4 passes (multipart, real STT, Request and abort failure).
# Initial green: 9 passed; final expanded control: 13 passed, no skips, 3.56 seconds.
# Logs: /tmp/upstream-116-webapi-{red,green,complete}.log

cd tests
../node_modules/.bin/vitest run unit/proxy-keepalive-dead-socket.test.js unit/econnreset-repro.test.js unit/claude-header-forwarding.test.js unit/elevenlabs-stt.test.js --testNamePattern='^(?!.*uses static provider defaults when no model is given).*$' --maxWorkers=1
# 4 files passed, 58 passed, 1 existing stale-fingerprint exclusion, 57.71 seconds.
# Outbound proxies pointed at closed loopback; all nonmocked requests loopback only.
# /tmp/upstream-116-webapi-affected.log
cd ..
node_modules/.bin/eslint open-sse/utils/proxyFetch.js scripts/check-fetch-web-api.mjs
# Passed, no output (/tmp/upstream-116-webapi-lint.log).
```

A first expanded proxy control timed out because its test proxy only supported CONNECT while undici uses HTTP forward proxying for HTTP targets; adding a loopback-only request forwarder fixed the test harness, with no production proxy behavior changed. No failing run is counted as green. The exact Node22 image attempt failed before container execution because the local Docker daemon returned HTTP 500 for `_ping` (`webapi-node22.log`). This is not Node22 test evidence. The workflow's new runtime smoke is mandatory before push, runs with no external networking, and must pass off-Mac before deploy. No heavy local rebuild/full suite was run for this correction, as instructed. A different fresh judge and MAIN's off-Mac default regression/image gate remain required. Original merge history and all previously disclosed limits are retained.
