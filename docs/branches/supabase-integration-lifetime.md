# Keep Supabase integration fixtures alive

- Status: In progress
- Branch: `origin/codex/supabase-integration-lifetime`
- Base: `origin/main` at `4d638d1`
- Updated: 2026-11-11

## Purpose

The real Supabase service test unpins its first stack to reset it. Without
pinning it again, the default 60-second unheld timeout can stop it while the
suite prepares the second worktree, causing a later stop request to fail
before token-isolation checks run.

## Changes

- Pin the first fixture again immediately after reset.
- Skip already-stopped fixtures when stopping stacks during teardown;
  destruction and the final no-stacks-left check still run.
- Assert that both stacks are simultaneously running natively, listen only
  on loopback, and have distinct API and database ports.

The integration test is unchanged in the reviewed base, so these additions
remain necessary after the lane-discovery and agent changes in PRs #1 and #2.

## Verification

- Rebased onto the reviewed base without conflicts.
- The real Supabase service suite passed all 9 tests with CLI 2.121.0 in an
  isolated home, including simultaneous stacks, cross-stack JWT rejection,
  agent up/env/down, and cleanup. No stack state remained afterward.
- Focused hold and protocol checks passed all 195 tests.
- `VITEST_MAX_WORKERS=2 pnpm --filter @rndevtools/desktop quality` passed
  license, lint, typecheck, unused-code, and cycle checks. Lint reported
  122 existing CSS warnings. The complete test run had 2,339 passes,
  2 failures, and 19 skips; both failures were 5-second timeouts in
  unchanged `monorepo.test.ts` tests while the host was heavily loaded.
- All 11 monorepo tests passed in isolation with their original timeouts.
  A one-worker quality retry also reported failures in the branch-switch
  test and an unchanged queued-agent-operation test. That retry was stopped
  before completion and is not a passing quality result. The queued-agent
  test also passed when rerun alone with its original timeout.
- `pnpm --filter @rndevtools/desktop build` passed separately, including
  bundled license notices.
- The public-content scanner passed its 7 tests and repository scan.
- GitHub Actions is disabled for this repository, as checked on 2026-11-11.

## Open items

- Obtain a clean full desktop quality run before marking the PR ready.
  The observed timeouts suggest host contention, but the full gate remains
  failing; no test timeout or assertion was relaxed.

## Revisions

| Date | Revision |
| --- | --- |
| 2026-11-11 | Rebased the fixture fix and simultaneous-stack assertions onto current main. |
