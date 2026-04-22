# Phase phase14-integration-test-har — Review #1: REVIEW-FIXES

**Date**: 2026-04-22T17:48:57Z
**Fixes applied**:
- `api/src/catalog/variant-class.integration.test.ts`: Replaced 4 silent return guards (`if (!testProductId) return;`) at lines 307, 350, 367, 435 with concrete `expect(...).toEqual(expect.any(String))` assertions. These guards violated the zero-skips rule — if the first test (which creates the product/variant) failed, all downstream tests would silently pass instead of reporting failures. The fix ensures they fail loudly with a clear assertion error pointing to the missing setup state.

**Deferred** (optional improvements, not bugs):
- Many integration tests use `toBeTruthy()` / `toBeDefined()` as intermediate guards in multi-step flow tests (e.g., `expect(authUserId).toBeTruthy()` before using the ID). These are NOT the only assertion in their test blocks — they serve as mid-flow checkpoints alongside concrete value assertions. Not fixing since the rule bans them only "as the ONLY assertion".
- ~30 `afterAll` blocks use `try/catch { /* best-effort cleanup */ }` for DB cleanup. This is standard test teardown hygiene, not error-swallowing in `beforeAll` setup. Not a violation.
- `.external.test.ts` files (`shipping-adapter`, `tax-adapter`) use `describe.skip` patterns gated on API keys, but these files are explicitly excluded from the vitest config (`vitest.config.ts:8`), so they never run in the integration suite.
