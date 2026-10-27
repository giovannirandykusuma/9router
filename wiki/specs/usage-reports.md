# Usage reports

## Goal
Admin-only historical reporting for inference API keys (for example Kenny) with consistent key/date/provider/account/model filtering across summaries, charts, paginated requests, and a real downloadable Excel workbook. Extend the existing fork without replacing its dashboard or routing/account controls.

## Authority and scope
Randy approved the recommendation with “Okay, then do it” on 2026-10-27. Browser timezone, selectable, was explicitly chosen via ask_user_question. Admin-only; no self-service portal, scheduled emails, billing/invoicing, prompts/responses in exports, or fabricated historical data. The UI should retain the established dashboard components/theme. Independently review authorization, migrations, export safety and reconciliation before deployment. Deployment is expected after validation, using existing GHCR procedure; MAIN handoff publication boundaries require a checkpoint before push/deploy if authority is not available to the successor.

## Rung and implementation shape
Epic by complexity: attribution/schema + query semantics + Excel + UI/reconciliation. One tightly coupled vertical outcome; direct mode is acceptable if query/export/UI contracts cannot be separated economically. If lanes are used, freeze the query contract first and split backend/export vs UI with disjoint ownership. Do not manufacture tiny lanes. No application changes have started.

## Confirmed behavior
- Reports is a new tab under Usage; existing Stats/Request Details/Logs remain.
- Filters: optional stable inference key ID, provider ID, connection ID, exact model identity; start/end calendar dates and selectable IANA timezone. Default browser timezone. Label timezone in screen and workbook. Define inclusive user end date through a half-open UTC interval; DST tests required.
- Initial range recommendation: last 30 days. Date range/export limits must be explicit and validated; refuse oversized exports rather than truncate silently. A 50k-request export cap and 366-day report range are proposed engineering bounds, not promised requirements; benchmark before finalizing.
- Cards: recorded requests, input/output, cached/cache-creation/reasoning tokens where actually recorded, estimated historical cost. Do not sum cached/reasoning subsets into total twice. Missing fields must remain identifiable as unknown, not invented zero evidence.
- Charts: requests/tokens/cost over time, model breakdown; account breakdown table and paginated request rows. Daily buckets for v1 acceptable, hourly optional only if simple.
- XLSX sheets: Summary & Filters, Daily Usage, By Model, By Account, Requests. Same normalized filters/query definitions and captured cutoff for reconciliation; numeric cells remain numeric, names strings (no spreadsheet formulas), no raw API keys, prompts, provider secrets or response bodies.
- Preserve stable key identity for new records and safely backfill existing exact-key matches. Renames/deletions should not erase attribution. No guessing unknown keys. Inference-only reports; explicitly exclude MCP gateway usage rather than mixing tool calls with token inference.
- Only recorded usage is reported. Existing usageHistory contains only success-like statuses, so omit error-rate metrics. Cost is saved request cost, clearly an estimate, not repricing history or actual OAuth subscription charges.
- Report routes must require dashboard admin session explicitly (even if general requireLogin=false), including export. Inference/MCP API keys cannot authorize reporting. Bound SQL parameters; pagination and query limits.

## Evidence and touched areas
- src/lib/db/repos/usageRepo.js: saveRequestUsage writes raw apiKey, connectionId, timestamp, tokens JSON, scalar prompt/completion and cost. Existing stats loops over rows. API-key filter in UI does not scope chart API.
- src/lib/db/schema.js:165 usageHistory definition; schema version3, automatic missing-column/index addition via adapter plus versioned migrations. Study migration/backup path before choosing attribution change.
- src/lib/db/repos/apiKeysRepo.js: hard delete/update lifecycle; needed to preserve historical identity if backfill relies on current keys.
- src/lib/db/index.js: settings/connection/key export/import; backups do not currently include usageHistory. Preserve existing behavior.
- src/lib/db/driver.js + adapters/better-sqlite3.js (check actual filenames): sync all/get/run/transaction abstraction, auto schema evolution.
- src/app/(dashboard)/dashboard/usage/page.js: tab host; src/shared/components/UsageStats.js and usage/components contain existing Recharts controls.
- src/lib/auth/dashboardSession.js: verifyDashboardAuthToken(request cookies). src/dashboardGuard.js general admin gate may honor requireLogin=false, so reports need explicit auth.
- package.json/package-lock.json: no Excel or timezone library presently; recharts3.7 present. Choose maintained XLSX/timezone handling deliberately, no hand-rolled timezone arithmetic. Dependency installs must not mutate the old dirty checkout through symlink.
- scripts/test-oauth-fork.sh: focused CI/image gate, extend with reporting tests.
- docs/FORK-PATCHES.md: record local reporting feature and preserved patches.

## Current live facts (read-only checked 2026-10-27)
- Baseline commit170f7c7940edaaa2df0b953e925996e441b6408d on personal/mcp-gateway.
- Approximately293395 usage rows, earliest2026-09-09. Kenny has1 exact current-key-attributed row (our verification), not historical data to invent.
- Recent tokens JSON fields: prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_creation_input_tokens, reasoning_tokens.
- Status groups: ok293275, success120. Error counts not supported by this source.
- Keyscope and all earlier fork patches must remain intact. Kenny only codex account7d617d9a-f342-4db4-9203-fbb5a9ff3d06 and models cx/gpt-6.1-sol/cx/gpt-6-luna.

## Acceptance contract (implement tests with these names)
- `sh scripts/test-oauth-fork.sh` exits0; existing baseline554passed/3intentional skips must not regress.
- `cd tests && NODE_PATH=node_modules node_modules/.bin/vitest run --config vitest.config.js unit/usage-reports.test.js unit/usage-reports-export.test.js unit/usage-reports-auth.test.js` exits0. Cover fixtures for filters, DST/calendar boundaries, summary/group/page/export reconciliation, key rename/delete and unknown history, cached/reasoning accounting, missing data, pagination, malformed/oversized filters, export limit, formula injection, secret exclusion and admin auth rejection.
- `npm run build` exits0.
- `git diff --check` exits0.
- Browser synthetic fixture script must demonstrate selecting Kenny filters cards/charts/table, custom date/timezone behavior, pagination and successful XLSX download parsed back to matching totals; 1440px and390px screenshots, no console errors/horizontal overflow, loading/empty/error states.
- Full suite baseline comparison: same known30failed test names and embeddings.cloud load error, no new failures. Run from tests/ to avoid path-dependent load failures; don't commit auto-generated golden-url snapshot.
- Read-only performance benchmark against a synthetic ~300k row DB (or carefully bounded live read-only query) records elapsed time and query plan. Do not export/copy live raw keys into local fixtures.

## Review focus
Authorization of every reporting endpoint; inference-vs-MCP distinction; durable identity and deletion/backfill behavior; DST and inclusive end date; stale UI request races; unknown token fields and double counting; export-memory bounds and formula injection; matching totals during live writes; existing keyscope/rate-limit/OAuth/MCP behavior. A fresh judge must rerun acceptance. UI visual review separate if supported.

## Frozen implementation contract (successor MAIN, 2026-10-27)
- Dependencies: Luxon 3.7.2 for IANA calendar/DST boundaries; ExcelJS 4.4.0 server-only for actual XLSX (explicit string cells, never formulas). No raw workbook template/import processing. Bounds: 366 inclusive calendar days, 50,000 export rows, pageSize 25 default / maximum 100. Benchmark these before declaring ready.
- `GET /api/usage/reports`: explicit dashboard-cookie verification regardless of general login setting; no bearer key auth. Params `startDate`, `endDate` (YYYY-MM-DD), `timezone` (IANA), optional `keyId`, `provider`, `connectionId`, `model`, `page` (1-based), `pageSize`, `cutoff` (nonnegative safe integer). Dates/timezone required. Unknown/duplicate params and malformed identifiers/bounds return 400. Optional filters use exact stored identities, no wildcard matching.
- Capture `cutoff = MAX(usageHistory.id)` on first request. Return it and reuse for pagination/export so later writes, including backdated writes, cannot change totals. Refresh/filter changes clear cutoff. All report queries exclude `provider = mcp-gateway` and use the same half-open UTC range, filters and id cutoff. SQL aggregation preferred; no whole-history JSON loading. Daily aggregation uses timezone-derived UTC day boundaries, never SQLite localtime/server timezone.
- JSON response `{ filters, cutoff, limits, summary, daily, byModel, byAccount, requests, pagination, options }`. `filters` contains normalized supplied names plus `startUtc`, `endUtc`; `limits` contains `maxDays`, `maxExportRows`. Every aggregate has `requests`, `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `cacheCreationTokens`, `reasoningTokens`, `cost`, and `known` (same metric names mapped to recorded-row counts). Unknown metric sum is null; partial sum includes only known values and UI labels coverage. Total uses recorded total_tokens or both known input+output, never adds cache/reasoning subsets. Cost uses saved cost with estimate label. Scalars historically defaulting to zero must not fabricate token evidence when JSON fields are absent.
- `daily` adds `date`; `byModel` adds `provider`, `model`; `byAccount` adds `provider`, `connectionId`, `accountName`. `requests` rows add `id`, `timestamp`, `provider`, `model`, `connectionId`, `accountName`, `keyId`, `keyName`, and metric fields (unknown null); no tokens/meta/raw key/endpoint content. `pagination` is `{page,pageSize,total,totalPages}`. `options` is `{keys:[{id,name}], providers:[string], accounts:[{id,name}], models:[{provider,model}]}` from safe inference history/current key/account fields; historical deleted keys remain selectable; no secret-derived labels.
- `GET /api/usage/reports/export` uses identical params/filter normalization, requires `cutoff`, ignores pagination for full export, and returns the five approved sheets as attachment `usage-report.xlsx`, no-store. More than 50k matching rows returns 413 before workbook creation; do not silently truncate. Other invalid params return 400; unauthorized 401; generic unexpected error 500 without secrets. Report JSON also no-store.
- Add durable nullable `apiKeyId`/`apiKeyName` attribution columns and version4 migration. Backfill only unambiguous exact matches to inference keys (never gateway keys); new writes capture identity/name without changing raw apiKey needed by existing limits. Key update/delete seals any exact unmatched history before mutating/deleting; populated attribution never overwritten. Preserve existing schemas/data/import/rate-limit/fallback semantics. Deleted/renamed history uses saved labels; current key name may label selector.
- Backend lane owns DB attribution, report library/routes, named unit suites, synthetic SQL benchmark. MAIN owns dependencies, Reports UI/browser proof, CI/docs integration. Shared contract changes must be communicated before editing the other side. Fresh judge(s) plus MAIN full regression/build/browser evidence gate readiness. No push/deploy until Randy's fresh checkpoint.

## Approved execution isolation revision
Randy selected **Isolate report computation** at the performance checkpoint after the second backend review. Heavy cold aggregation and XLSX work must not block the gateway event loop. Preserve the approved API and all adapter/runtime behavior, including sql.js persistence semantics; do not silently query stale disk snapshots or introduce a fallback that runs heavy work on the main thread. Bounded concurrency/queue, timeout/cancellation cleanup, read-only worker access, safe error handling, production Next standalone/Docker asset packaging and local dev behavior require tests. Demonstrate concurrent lightweight request/event-loop responsiveness during a synthetic300k report/export, not just total query latency. If a runtime cannot support safe isolated execution, surface the limitation explicitly and obtain a decision rather than guessing. No new publication authorization: checkpoint still required after validation.

## Approved native-only Reports compatibility
Randy explicitly selected option1 after the SQL.js compatibility investigation: isolated Reports support native SQLite adapters (node:sqlite, better-sqlite3, bun:sqlite). If the live gateway uses SQL.js, report/export routes return an actionable503 stating isolated reporting requires a native SQLite runtime. Existing gateway/SQL.js behavior, attribution persistence and other dashboard tabs remain unchanged. No forced flush, main-thread database export, stale disk snapshot or synchronous reporting fallback. This approval is a Reports availability boundary, not authorization to redesign SQL.js persistence or to publish/deploy. Native execution must still pass isolation/lifecycle/packaging/freshness/security and combined integration gates.

## Study references
OmniRoute at55ccad495c4a73eb64deaf094829fe5b90ded80c (MIT): src/app/api/usage/analytics/route.ts, src/lib/db/usageAnalytics.ts, src/lib/db/usageAnalytics/sources.ts, src/shared/components/UsageAnalytics.tsx, src/app/api/logs/export/route.ts. Local read-only source copies in /tmp/omniroute-report-study. Reuse design, not entire TypeScript/aggregation/retention stack. Its verified export is JSON, not XLSX. Prefer SQL aggregation; don't trust stale comments claiming all aggregation is JS.
