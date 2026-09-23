#!/bin/sh
set -eu
cd "$(dirname "$0")/../tests"
npx --no-install vitest run \
  unit/openai-responses-optional-params.test.js \
  translator/thinking-unified.test.js \
  unit/cache-affinity-strategy.test.js \
  unit/cache-affinity-auth-integration.test.js \
  unit/codex-fast-capacity.test.js \
  unit/codex-encrypted-content-recovery.test.js \
  unit/pi-settings.test.js \
  unit/stream-first-byte-timeout.test.js \
  unit/responses-abort-terminal.test.js \
  unit/cachefix-regression.test.js \
  unit/claude-stream-cache-usage.test.js \
  unit/cached-token-usage.test.js \
  --maxWorkers=2
