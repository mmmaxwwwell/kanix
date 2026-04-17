# Phase phase6-cart-checkout-paymen — Review #2: REVIEW-CLEAN

**Date**: 2026-04-17T11:35:00Z
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

All four fixes from review #1 (commit 5ed6521) were verified as correctly applied:
1. `ORDERS_MANAGE` capability used for order transition endpoint
2. Admin user ID extraction uses `request.adminContext?.adminUserId`
3. webhook.ts catch blocks only catch `ERR_INVALID_TRANSITION`, rethrow others
4. refund.ts catch block only catches `ERR_INVALID_TRANSITION`, rethrows others

Delta diff since review #1 is empty — no new code changes to review.

**Deferred** (optional improvements, not bugs):
- `api/src/db/queries/checkout.ts:55-58` — `generateOrderNumber` uses `COUNT(*)+1` which has a race condition under concurrent checkouts. Should use a PostgreSQL sequence for production.
- `api/src/db/queries/cart.ts:202-248` — `getCartWithItems` has N+1 query pattern: per-item queries for variants, inventory, and kit selections. Would benefit from batch queries.
- `api/src/db/queries/order-cancel.ts:100-169` — Cancel flow performs inventory release and refund outside a transaction. If the final status transition fails, the system could be left in an inconsistent state.
- `api/src/services/admin-alert.ts` — In-memory alert queue grows unboundedly with no eviction or max size.
- `api/src/server.ts:3187-3194` — Checkout uses `findInventoryBalances(db, {})` to pick a location ID nondeterministically.
