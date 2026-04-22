# Phase phase14-integration-test-har — Review #2: REVIEW-CLEAN

**Date**: 2026-04-22T18:05:00Z
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

## Review scope

- **Delta diff** (837f1d07...HEAD): empty — no new commits since review #1.
- **Full phase diff** (3346603e~1...HEAD): re-scanned for issues review #1 may have missed.

## Verification of review #1 fixes

- Review #1 replaced 4 silent return guards in `api/src/catalog/variant-class.integration.test.ts` with concrete assertions. Verified: no `if (!testProductId) return` or `if (!testVariantId) return` patterns remain anywhere in `api/src/**/*.integration.test.ts`.

## Spec-conformance check

- T205 (email conflict): `ERR_EMAIL_CONFLICT` returned with case-insensitive `ilike` check in `supertokens.ts` — matches spec.
- T206 (GitHub linking): Idempotent re-link, conflict on different ID, unlink endpoint — all present in `server.ts`.
- T235 (void label): `ERR_VOID_WINDOW_EXPIRED` returned on carrier rejection — matches spec.
- T249 (milestones): 25-unit retroactive 10%, 50-unit starter kit, 500-unit veteran 20% — all thresholds and rates correct in `contributor.ts` and tested in `contributor-milestones.integration.test.ts`.
- T275 (out-of-stock): Task description says `ERR_OUT_OF_STOCK`/409 but implementation consistently uses `ERR_INVENTORY_INSUFFICIENT`/400 across all cart/inventory endpoints. Test correctly asserts the actual error code. Not a code bug — the implementation is internally consistent.

## Test-depth audit

- **Skip guards**: Zero `describe.skip`, `it.skip`, `test.skip`, `canRun` guards, or `if (!x) return` silent pass patterns found in any `*.integration.test.ts` file.
- **Mocking**: Zero `vi.mock` or `jest.mock` calls in integration tests. Tests run against real DB + SuperTokens.
- **Vacuous assertions**: 184 `toBeDefined()`/`toBeTruthy()` occurrences across 44 files — all are intermediate guards in multi-step tests alongside concrete value assertions (e.g., asserting an ID exists before using it to make the next API call). None are the sole assertion in their `it()` block.
- **Error-path coverage**: Spot-checked admin-customers, checkout, refund, void-label, reservation, contributor endpoints — all have both happy-path and error-path test cases.
- **Test reporter**: Enforces zero-skips (exit code 1 if any skips) and zero-vacuous runs (exit code 1 if 0 passed + 0 failed).

## Bug scan

- **SQL injection**: All queries use Drizzle's `sql` template tag with parameterized values. No raw string interpolation.
- **Auth boundaries**: Admin endpoints behind `requireAdmin` + `requireCapability`. Customer endpoints behind `verifySession` + `requireVerifiedEmail`. PII redaction for non-super_admin roles via `redactCustomerPII`.
- **Concurrency**: `generateOrderNumber` uses `pg_advisory_xact_lock` for serialization. `forceReleaseReservation` uses `SELECT ... FOR UPDATE` inside transaction. Correct.
- **Error handling**: Refund endpoint returns 409 for already-refunded orders, 502 for provider failures (not re-throwing). Void-label returns 409 for expired window.
- **Payment adapter**: `submitDisputeEvidence` added with proper Stripe API call in real adapter and stub in test adapter.
- **Circuit breaker**: Health endpoint reflects payment circuit breaker state (`ok` vs `degraded`).

## Deferred (optional improvements, not bugs)

- `api/src/db/queries/shipment.ts:443-448`: Void-label catch throws a plain object `{ code, message, shipmentId }` instead of `Object.assign(new Error(...), { code })`. Works because server.ts checks `.code` directly, but inconsistent with the rest of the codebase's error pattern.
- `api/src/db/queries/reservation.ts:414-434`: `getReservationStats` runs 4 separate COUNT queries (one per status) instead of a single `GROUP BY` query. Correct but less efficient.
- `passWithNoTests: true` in `vitest.config.ts` — only affects when no test files match the glob (not when test files have 0 test cases). The custom reporter separately enforces non-vacuous runs.
