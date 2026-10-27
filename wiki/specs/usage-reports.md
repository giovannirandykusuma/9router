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

## Study references
OmniRoute at55ccad495c4a73eb64deaf094829fe5b90ded80c (MIT): src/app/api/usage/analytics/route.ts, src/lib/db/usageAnalytics.ts, src/lib/db/usageAnalytics/sources.ts, src/shared/components/UsageAnalytics.tsx, src/app/api/logs/export/route.ts. Local read-only source copies in /tmp/omniroute-report-study. Reuse design, not entire TypeScript/aggregation/retention stack. Its verified export is JSON, not XLSX. Prefer SQL aggregation; don't trust stale comments claiming all aggregation is JS.
