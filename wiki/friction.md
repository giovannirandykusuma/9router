# Workflow friction

## 2026-10-27 — worktree lane baseline false negative
`shikumi_lane_start` twice rejected `/tmp/9router-reports` and `/private/tmp/9router-reports` with `no committed Git baseline`, despite `git rev-parse --verify HEAD` returning `d398e622f7338776c118ae639bd60850729c11ae`, `git log` showing source history, and a clean initial baseline. Repo is a linked worktree (`.git` file). Direct Paseo `create_workspace` using explicit base `refs/heads/personal/usage-reports` succeeded. Used isolated manual worker, preserving fresh review gate. No stack source changes attempted. Also `shikumi_mark_superseded` could not resolve hander in another cwd as a live peer, though intercom delivered Step0 notice; no MAIN archived/stopped.
