# Live chat concurrency

Usage → Overview includes an Active requests card. It shows in-flight chat
attempts on this process, summed across models, independently of the historical
period selector. Expand provider/model rows for account counts. It is not a
capacity limit, queue depth, API-key limit, logged-in user count, or historical
peak. Non-chat endpoints (images, embeddings, MCP, reports) are not included.

The card uses the existing authenticated usage event stream. On disconnect it
hides the stale total and displays Reconnecting. A process restart resets the
in-memory state. Multi-process deployments would need aggregation; this deployment
runs one 9Router instance.

## Lifetime ownership

`trackPendingRequest(..., true)` returns an idempotent completion handle for that
attempt. There is no age-based expiry. Chat core's finally releases non-stream
attempts after body decoding; successful streams hand ownership to the stream
controller's completion/error/disconnect callbacks. Shared transforms do not
release counts by account/model, so overlapping streams cannot decrement a sibling.
Existing transport deadlines still apply; this feature does not change them.

The lightweight SSE push includes a fresh pending snapshot. Push failures close
the stream so EventSource can reconnect rather than remaining silently live.
No credentials, request bodies, or new account information are exposed; existing
authenticated account names/counts are reused.

## Verification

```sh
cd tests
./node_modules/.bin/vitest run unit/chat-concurrency.test.js unit/live-concurrency.test.js unit/sse-concurrency.test.js unit/stream-first-byte-timeout.test.js unit/combo-empty-failover.test.js unit/codex-native-passthrough-thinking.test.js unit/claude-stream-cache-usage.test.js
cd ..
sh scripts/test-oauth-fork.sh
npm run build
git diff --check
```

Visual checks use an isolated data directory without production credentials.
Check live idle, populated provider/model/account rows, disconnected state,
desktop and narrow widths. Do not run synthetic inference against production
accounts without authorization.

## Deployment boundary

Base: deployed source 9a0127b42db453bbfbe64656a0c2239da0d84445.
Preserve Claude CLI 2.1.310 / Codex CLI 0.164.0 fingerprints when building.
Use the existing off-VPS Fork image workflow and deploy-ghcr.py transaction.
Retain the old container/image and backup. Check live traffic and obtain the
operator's quiet-window approval before stopping production. Do not restore an
old database for a code rollback: that would discard intervening usage.

No provider routing, concurrency caps, account/key restrictions, or quotas change.
