# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T067 — Implement contributor registry + design linking
- The contributor Drizzle schema (7 tables), DB migration, and CAPABILITIES (CONTRIBUTORS_READ, CONTRIBUTORS_MANAGE) all already existed in contributor.ts, 002-core-entities.xml, and admin.ts — only the query layer, routes, and integration tests needed to be created
- The `requireAdmin` middleware is scoped inside the main `if (database)` block starting at line ~892 — contributor routes added in a separate `if (database)` block must create their own `const requireAdmin = createRequireAdmin(db)` since it's not in scope
- The `createContributor` function sets status to "active" if `claAcceptedAt` is provided, "pending" otherwise — this auto-activation matches the CLA bot workflow where acceptance implies activation

## T068 — Implement per-design sales tracking
- The `contributor_design` table needed a `sales_count` column (migration 008) — the data-model.md doesn't specify it, but the task requires "increment sales count" which implies a mutable counter
- `processOrderCompletionSales` resolves product_id via `order_line.variant_id → product_variant.product_id → contributor_design.product_id`; the `order_line` table doesn't store product_id directly
- The contributor.ts query file was pre-populated with imports for `order`, `orderLine`, `productVariant`, `sql`, `sum` from T067 — these were set up in anticipation of T068's sales tracking needs

## T069 — Implement royalty calculation engine
- Retroactive royalties must include the current order line (the one that crosses the threshold) since the order is already "completed" when `processOrderCompletionSales` runs — attempting a separate insert for the current line after `createRetroactiveRoyalties` causes a UNIQUE constraint violation on `order_line_id`
- The 501(c)(3) donation option is stored as `charity_name` + `charity_ein` on the `contributor` table (migration 009); when both are non-null, `getRoyaltyRate()` returns `DONATION_RATE` (20%) instead of `ROYALTY_RATE` (10%)
- The `contributor_royalty.order_line_id` UNIQUE constraint means royalty entries are strictly 1:1 with order lines — the `clawbackRoyaltyByOrderLine` function is the natural way to handle refunds since each order line maps to exactly one royalty

## T070 — Implement milestone tracking + tax documents
- Milestone auto-detection is hooked into `processOrderCompletionSales` (not a separate cron) — uses `detectMilestones()` wrapped in try/catch so milestone failures don't block order processing; milestones are idempotent (check-before-insert pattern)
- The `contributor_milestone`, `contributor_tax_document`, and `contributor_payout` tables already existed in migration 002 and Drizzle schema — only query functions, routes, and tests needed to be created
- CTR-3 invariant (payout blocked without approved tax document) is enforced in the `createPayout` query function itself, not in routes — throws `ERR_TAX_DOC_REQUIRED` which routes translate to 403

## T071 — Implement contributor dashboard API
- Dashboard route uses customer→contributor lookup chain: `session.getUserId()` → `getCustomerByAuthSubject()` → `findContributorByCustomerId()` — contributor links to customer via `contributor.customerId` FK, not via matching `githubUserId`
- Royalty aggregation uses SQL `coalesce(sum(...), 0)` grouped by status to get accrued vs clawed_back totals; `paidMinor` is derived from completed payouts (not a royalty status), so `pendingMinor = accruedMinor - paidMinor`
- ESLint forbids `!.` non-null assertions in test files — use optional chaining `?.` instead (e.g., `expect(result?.field).toBe(...)`) following existing test patterns

## T071a — Implement admin dashboard summary API
- Dashboard routes don't need a specific capability — any authenticated admin can view them (using `[verifySession, requireAdmin]` without `requireCapability`)
- The `dispute` table lives in `payment.ts` schema (not a separate `dispute.ts`), and `shipment` lives in `fulfillment.ts` — these were the two schemas that differed from the expected file naming pattern
- Fastify route handlers with no request/reply usage should use `async () =>` (not `async (_request, _reply) =>`) to avoid ESLint `no-unused-vars` errors
