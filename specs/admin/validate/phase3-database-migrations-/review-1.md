# Phase phase3-database-migrations- — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T05:42:00Z
**Fixes applied**:
- `deploy/nixos/postgres.nix`: **P1 — Correctness** — `ExecStart` for the backup service used `$(date +%Y%m%d-%H%M%S)` shell expansion directly in a systemd `ExecStart` directive. systemd does not invoke a shell for `ExecStart`, so the `$(date ...)` was passed literally to `pg_dump`. All backups would write to the same filename, destroying retention and risking data loss. Fixed by wrapping the command in `pkgs.writeShellScript` so shell expansion works correctly. Commit: ff10847

**Deferred** (optional improvements, not bugs):
- `api/src/db/scripts/reset.ts` interpolates DATABASE_URL components into shell commands via `execSync`, which is technically a command injection surface. Since this is a dev-only script and the input comes from environment variables (not user input), this is acceptable risk for a dev tool — but should not be used as a pattern for production code.
- Integration tests (`ready.integration.test.ts` line 40) call `vi.spyOn(process, "exit")` in describe-block scope without cleanup in `afterAll`. This works because vitest restores spies between files, but explicit cleanup would be cleaner.
- Seed script uses individual INSERT loops (N+1 pattern) — acceptable for a dev seed with 5 products × 3 variants, but would not scale. Not a bug.
