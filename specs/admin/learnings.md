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

## T071b — Implement admin customer detail APIs
- Drizzle's `ilike` (from `drizzle-orm`) works for case-insensitive search on PostgreSQL — use `or(ilike(col1, pattern), ilike(col2, pattern))` for multi-column text search
- Sub-resource endpoints (e.g., `/customers/:id/orders`) should check that the parent exists first and return 404 if not, rather than returning an empty array for a non-existent customer
- The `listCustomers` query combines `sql.join(conditions, sql` AND `)` for the WHERE clause since conditions mix Drizzle helpers (eq, ilike, or) — this avoids needing `and()` with a spread of potentially undefined OR conditions

## T071c — Implement admin settings APIs
- No `admin_setting` table existed in the data model — created a generic key-value table (`key` TEXT PK, `value_json` JSONB, `updated_at`) to store settings like shipping config; this pattern supports future settings keys without schema changes
- `ROLE_CAPABILITIES.super_admin` uses `Object.values(CAPABILITIES)` so new capability constants (like `SETTINGS_MANAGE`) are automatically included — no need to manually add them to the super_admin role
- Drizzle's `onConflictDoUpdate` with `target: adminSetting.key` provides upsert for settings — first GET returns defaults from code (no row needed), first PATCH creates the row via upsert

## T072 — Implement WebSocket server with auth
- `@fastify/websocket` v11 handler signature is `(socket: WebSocket, request: FastifyRequest)` — no `SocketStream` wrapper; `WebSocket` type comes from `ws` package (needs `@types/ws` as devDependency)
- `Session.getSessionWithoutRequestResponse(token)` validates an access token without HTTP request/reply — useful for WebSocket upgrade auth where there's no standard Fastify request lifecycle
- `ws` must be added as a direct dependency (not just transitive via `@fastify/websocket`) for test files that import it as a WebSocket client — pnpm strict hoisting prevents resolving transitive deps

## T073 — Implement server-side message buffering
- A global buffer (array of all published messages with timestamps) is simpler and more correct than per-subject buffers — on replay, filter by the reconnecting client's channels and `sequenceId > lastSequenceId`
- The `lastSequenceId` query parameter on the `/ws` endpoint enables reconnect replay — parsed after auth/welcome so the welcome message always arrives first, then replayed messages follow
- `setInterval(...).unref()` prevents the cleanup timer from keeping the Node process alive during tests or graceful shutdown

## T074 — Implement pub/sub for domain events
- `wsManager` and `domainEvents` are declared after route definitions in `createServer()` but captured by route closures — JavaScript closures reference bindings not values, so the variables are available when handlers execute (after server.listen())
- Customer event routing requires publishing to both `entity:entityId` (for admin wildcard) and `customer:customerId` (for customer channel) — the `DomainEventPublisher` wraps this dual-publish pattern
- For ticket events, `findTicketById` is called after the mutation to get the `customerId` for customer routing — this is an extra DB query but tickets already have the customerId FK on the support_ticket table

## T075 — Implement notification service + email stub
- The `admin_setting` table's generic key-value pattern could store per-admin prefs, but a dedicated `admin_alert_preference` table with FK to `admin_user` + unique constraint is cleaner for per-admin config with a known schema
- `NotificationDispatchService` is created after `wsManager` (which requires async `registerWebSocket`) since the in-app adapter depends on it — same closure pattern as `domainEvents`
- `getAllAdminAlertTargets` uses LEFT JOIN from `admin_user` to `admin_alert_preference` so admins without a preference row default to `"both"` — no seeding needed for existing admins
