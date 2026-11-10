# Reasoning discovery deployment — 2026-10-29 UTC+7

Operator approved production rollout after reviewed source and documented rollback.

## Versions

- Server source/default branch: `personal/mcp-gateway`, revision `9a0127b42db453bbfbe64656a0c2239da0d84445`.
- Image: `ghcr.io/giovannirandykusuma/9router:0.5.112-fork-9a0127b-cli-c2.1.310-o0.164.0`.
- Digest: `sha256:f4640533f62112536f9c1b8a86708aa5d6839b955fff6ed4e397fdc278d7c731`.
- GitHub Actions build: https://github.com/giovannirandykusuma/9router/actions/runs/40726522894 (success; fork regression gate and image smoke checks).
- CLI fingerprints unchanged: Claude 2.1.310, Codex 0.164.0.
- Adapter: `0fbb98e10f9cbea82fdfd15bc252d03a611b8d5f`, pinned in Shikumi `stack.json`.
- Shikumi integrated main: `a4361b2` (preserves independently published Indonesian companion changes).

## Deployment

Existing VPS `deploy-ghcr.py` received the image by digest and reported `GHCR_DEPLOY_OK`.
It retained rollback container `9router-thinking-discovery-rollback-20261029-003609`
and backup `/home/ubuntu/9router-thinking-discovery-backup-20261029-003609`.
No credentials or backup contents are recorded here. Previous image was revision `e764be8`.

## Live verification

A new Pi SDK process used an isolated agent directory with only the installed pinned
adapter and **no models.json**. The adapter used the existing gateway credential via
its normal configuration/environment, not direct Codex authentication.

- Authenticated public `/v1/models`: `cx/gpt-6.1-sol` advertised
  `["low","medium","high","xhigh","max"]`.
- Fresh Pi discovery exposed exactly those supported levels at
  `https://strangeshi.com/v1`; selecting `max` remained `max`.
- Captured real outgoing request (not a mock):
  `POST https://strangeshi.com/v1/chat/completions`, model `cx/gpt-6.1-sol`,
  `reasoning_effort:"max"`.
- The request completed with stop reason `stop` and response `OK`.
- `/9router-reload` refreshed the catalog and retained supported `max`.
- This short request reported reasoning-token count 0. It proves discovery and
  outbound max selection, **not** reasoning-summary visibility or reasoning-token consumption.
- Local active installation has only the exact git adapter; old npm registration removed.
- Shikumi doctor sync: checkout current, Pi 1.4.0 matches, all 9 package sources match;
  update plan empty. In-place reload requests sent to affected repo sessions.

Source gate results: server 607 passed/3 intentional skips; adapter 26 tests plus
lint/typecheck; Shikumi widened test gate 1347 passed/6 skipped; post-integration
stack-sync/current-docs 30 passed. Fresh review accepted the corrected custom-prefix handling.

See [capability contract and rollback procedure](THINKING-LEVEL-DISCOVERY.md).
