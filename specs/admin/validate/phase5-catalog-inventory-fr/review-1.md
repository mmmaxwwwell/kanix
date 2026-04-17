# Phase phase5-catalog-inventory-fr — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T08:20:00Z
**Fixes applied**:
- `api/src/critical-path.integration.test.ts:374-378`: 4 non-null assertions (`cp5Product!.`) violated `@typescript-eslint/no-non-null-assertion` rule. Replaced with runtime type guard (`if (!cp5Product) throw new Error(...)`) before accessing properties. Commit SHA: 66f71a8.

**Deferred** (optional improvements, not bugs):
- N+1 query pattern in `catalog.ts` (inventory balance fetched per variant per product). Not a correctness issue but could be optimized with a batch query if product count grows large.
- `lowStock` flag in `inventory.ts:171` uses `<=` (at-or-below safety stock) while the alert service uses `<` (strictly below). Both behaviors are reasonable, just slightly different thresholds for the informational flag vs. the alert trigger.
