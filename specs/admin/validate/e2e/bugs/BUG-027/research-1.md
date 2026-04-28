# Research: BUG-027 — GET /api/admin/orders always returns empty array

## Root cause analysis

The handler at `api/src/server.ts:1126` is a stub:
```ts
async () => {
  // Placeholder — will be expanded later
  return { orders: [] };
}
```
It ignores the database entirely. No DB query is made. The fix is to add a
`listAllOrders` function to `api/src/db/queries/order.ts` and call it in the handler.

## Evidence

- `api/src/server.ts:1120–1130` — handler is confirmed placeholder.
- `api/src/db/queries/order.ts` contains `findOrdersByCustomerId` (customer-scoped)
  and `api/src/db/queries/customer.ts` has `getCustomerOrders` (also customer-scoped).
  Neither lists all orders.
- Schema at `api/src/db/schema/order.ts` — order table has: id, orderNumber, email,
  status, paymentStatus, fulfillmentStatus, totalMinor, placedAt, createdAt.
- The existing `getCustomerOrders` (customer.ts:163) is a good pattern to follow for
  field selection.

## Recommended fix strategy

1. Add `listAllOrders` function to `api/src/db/queries/order.ts`:
   - Select: id, orderNumber, email, status, paymentStatus, fulfillmentStatus, totalMinor, placedAt, createdAt
   - No WHERE filter; orderBy desc(createdAt)
   - Return type: array of order summary objects
2. Export it from `api/src/db/queries/index.ts` (or import directly in server.ts).
3. Import in `server.ts` and replace the stub body with `return { orders: await listAllOrders(database.db) }`.

## What NOT to do

- Do not return all columns (avoid leaking internal fields like auth tokens).
- Do not add pagination in this fix — the bug is just the stub; match current API contract.

## Confidence

High — the root cause is obvious (hardcoded stub) and the fix pattern is identical to
`getCustomerOrders`.
