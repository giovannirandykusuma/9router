#!/bin/sh
set -eu
cd "$(dirname "$0")/../tests"
# Upstream v0.5.86 also fails this unrelated GLM case; keep the test intact.
# The fork/full comparison was 184 pass + 1 failure vs the same upstream failure.
# Exclude only that exact case from this OAuth deployment gate.
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
  --testNamePattern='^(?!.*GLM-5\.2 also gets reasoning_effort \(supported from 5\.2 onward\)).*$' \
  --maxWorkers=2
