# Phase phase6-cart-checkout-paymen — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T11:32:00Z
**Fixes applied**:
- `api/src/server.ts:879` — Order transition endpoint used `CAPABILITIES.ORDERS_READ` (read-only) for a write operation. Changed to `CAPABILITIES.ORDERS_MANAGE`. Added new `ORDERS_MANAGE` capability to `api/src/auth/admin.ts`. Commit: 5ed6521
- `api/src/server.ts:904-907` — Admin user ID extraction used wrong property path (`request.adminContext.adminUser.id`) which would always resolve to `undefined`, breaking audit trails. Fixed to `request.adminContext?.adminUserId` matching the pattern used by all other admin endpoints. Commit: 5ed6521
- `api/src/db/queries/webhook.ts` (9 catch blocks) — Bare `catch {}` blocks silently swallowed ALL errors, including DB connection failures and serialization errors. Changed to only catch `ERR_INVALID_TRANSITION` errors and rethrow unexpected ones. Commit: 5ed6521
- `api/src/db/queries/refund.ts:172` — Same bare `catch {}` issue on payment status transition after refund. Fixed to only catch `ERR_INVALID_TRANSITION`. Commit: 5ed6521

**Deferred** (optional improvements, not bugs):
- `api/src/db/queries/checkout.ts:55-58` — `generateOrderNumber` uses `COUNT(*)+1` which has a race condition under concurrent checkouts. Should use a PostgreSQL sequence for production.
- `api/src/db/queries/cart.ts:202-248` — `getCartWithItems` has N+1 query pattern: per-item queries for variants, inventory, and kit selections. Would benefit from batch queries.
- `api/src/db/queries/order-cancel.ts:100-169` — Cancel flow performs inventory release and refund outside a transaction. If the final status transition fails, the system could be left in an inconsistent state.
- `api/src/services/admin-alert.ts` — In-memory alert queue grows unboundedly with no eviction or max size.
- `api/src/server.ts:3187-3194` — Checkout uses `findInventoryBalances(db, {})` to pick a location ID nondeterministically.
