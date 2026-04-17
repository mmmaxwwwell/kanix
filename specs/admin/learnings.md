# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T061 — Implement support ticket system
- The support_ticket Drizzle schema, DB migration, and CAPABILITIES (SUPPORT_READ, SUPPORT_MANAGE) all already existed — only the query layer, routes, and integration tests needed to be created
- Customer-facing routes at `/api/support/tickets` use `verifySession + requireVerifiedEmail` (no admin middleware), while admin routes at `/api/admin/support-tickets` use `requireAdmin + requireCapability`
- The `listTicketMessages` function takes an `includeInternalNotes` option — admin routes pass `true`, customer routes pass `false` to enforce the is_internal_note visibility boundary

## T061a — Implement duplicate ticket detection
- Self-referencing FKs (`linked_ticket_id`, `merged_into_ticket_id` → `support_ticket.id`) require clearing these columns before deleting tickets in test cleanup, otherwise FK violations occur
- Duplicate detection is best done in the `createSupportTicket` query function itself (not in routes) so both customer and admin ticket creation paths benefit automatically
- The `support_ticket_status_history.actor_admin_user_id` has a real FK constraint — test code using fake admin UUIDs (e.g., `00000000-...01`) will fail on insert; use `null` in tests without a real admin user

## T062 — Implement ticket attachments
- The `supportTicketAttachment` schema already existed in `support.ts` and DB migration in `002-core-entities.xml` — only query functions, routes, storage adapter, and tests needed to be created
- No `@fastify/multipart` needed: base64-encoded JSON body approach avoids adding a dependency and simplifies integration testing (send base64 data via JSON POST rather than multipart form data)
- Test cleanup for attachments must delete `supportTicketAttachment` rows BEFORE `supportTicketMessage` rows due to the FK from attachment.message_id → message.id

## T063 — Implement warranty claim flow
- Warranty period validation uses `shipment.deliveredAt` (not an order-level field) — must query shipments for the order and find the earliest `deliveredAt`; if no shipment has `deliveredAt`, the order is considered undelivered
- The `ShipmentRecord` interface does not include `deliveredAt` or `shippedAt` — query `shipment` table columns directly when you need these fields
- TPU heat deformation detection is keyword-based on the claim description; the material limitation flag is returned in the API response AND stored as an internal system note on the ticket (visible only to admins)

## T064 — Implement dispute auto-creation
- The `dispute` Drizzle schema, `handleDisputeCreated()`, and `charge.dispute.created` webhook handler already existed — only the dispute state machine, `handleDisputeClosed()`, and `charge.dispute.closed` handler needed to be created
- When Stripe closes a dispute, the dispute may be in any state (opened through submitted) — `handleDisputeClosed()` walks through intermediate transitions (opened→evidence_gathering→ready_to_submit→submitted→won/lost→closed) to maintain state machine integrity
- `inventoryLocation` schema uses `name`, `code`, `type` fields (not `locationType`); `inventoryBalance` uses `onHand`/`reserved`/`available` (no `damaged` column) — check actual schema, not data-model.md

## T065 — Implement evidence auto-collection
- Liquibase `splitStatements="true"` chokes on PL/pgSQL `$$` delimiters — use `splitStatements="false" stripComments="false"` for each `CREATE FUNCTION` block, then a separate `<sql>` block with `splitStatements="true"` for `CREATE TRIGGER` statements
- Evidence auto-collection hooks are best placed inside existing query functions (e.g. `storeShipmentEvent`, `createTicketMessage`, `storePaymentEvent`, `createPolicyAcknowledgment`) wrapped in try/catch so they're non-fatal — this ensures all code paths that create these records automatically generate evidence without requiring callers to remember
- The `evidenceRecord` table's `textContent` stores a JSON string (not raw text) for structured evidence data; `metadataJson` stores cross-reference IDs (e.g. `shipmentEventId`, `messageId`) for linking back to source records

## T066 — Implement evidence bundle generation
- The `evidenceBundle` schema already existed in `evidence.ts` — only the query functions (`generateEvidenceBundle`, `computeReadinessSummary`, `findDisputeById`), routes, and tests needed to be created
- Bundle generation uses a two-layer pattern: the query layer creates the DB record and returns `_content`, then the route layer stores the content via `storageAdapter.put()` — this keeps the query layer storage-agnostic
- Evidence completeness check uses all 5 `EVIDENCE_TYPES` as a hard requirement — the bundle generation rejects with `ERR_EVIDENCE_INCOMPLETE` and returns the readiness summary showing which types are missing

## T066a — Implement manual evidence attachment API
- Manual evidence reuses `createEvidenceRecord` directly — no new schema or migration needed; the `type` field accepts any admin-specified type (not constrained to EVIDENCE_TYPES) since manual evidence may have custom types
- File upload follows the same base64 JSON body pattern as ticket attachments (T062) — storage key format: `evidence/{disputeId}/{uuid}/{fileName}`; cleanup on DB failure via storageAdapter.delete()
- The `metadataJson` field stores `{ source: "manual", adminAttached: true }` to distinguish manual evidence from auto-collected evidence in queries and UI

## T066b — Implement evidence browsing API
- The `listEvidence` query uses Drizzle's `and()` with dynamic filter building — collect `SQL[]` conditions and apply them with `and(...conditions)` only when non-empty; when a single condition, pass it directly to avoid wrapping
- GET /api/admin/evidence/:id already existed from T066a (including download endpoint) — T066b only needed the list endpoint with query param filters (type, order_id, shipment_id, ticket_id, dispute_id)
- The `supportTicket` schema requires a `source` field (not `customerEmail`) — check actual schema columns before inserting test data

## T066c — Implement fulfillment edge case handling
- The `blocked → canceled` transition was not in the original state machine (`blocked` only allowed recovery to ACTIVE_STATES) — added `canceled` to blocked transitions since tasks should be cancelable from blocked state
- The `fulfillment_task.assigned_admin_user_id` and `inventory_adjustment.actor_admin_user_id` both have real FK constraints to `admin_user` — test code must insert a real `admin_user` record rather than using fake UUIDs like `00000000-...01`
- `POST_PICKING_STATES` (picked, packing, packed, shipment_pending) determines whether auto-inventory return happens on cancel — `picking` state itself is excluded since items haven't been fully picked yet

## T066d — Implement shipping edge cases
- `buyShipmentLabel` transitions to `label_pending` before calling `adapter.buyLabel()` — wrapping the adapter call in try/catch with `ERR_LABEL_PURCHASE_FAILED` keeps shipment in `label_pending` on failure without needing rollback
- `handleTrackingUpdate` accepts an optional `AdminAlertService` parameter — all callers (webhook handler, refreshShipmentTracking, transition route) must pass it through for delivery exception alerts to fire
- The `exception → in_transit` recovery transition was already in the state machine from T058 — no schema or state machine changes needed, just test coverage

## T067 — Implement contributor registry + design linking
- The contributor Drizzle schema (7 tables), DB migration, and CAPABILITIES (CONTRIBUTORS_READ, CONTRIBUTORS_MANAGE) all already existed in contributor.ts, 002-core-entities.xml, and admin.ts — only the query layer, routes, and integration tests needed to be created
- The `requireAdmin` middleware is scoped inside the main `if (database)` block starting at line ~892 — contributor routes added in a separate `if (database)` block must create their own `const requireAdmin = createRequireAdmin(db)` since it's not in scope
- The `createContributor` function sets status to "active" if `claAcceptedAt` is provided, "pending" otherwise — this auto-activation matches the CLA bot workflow where acceptance implies activation

## T068 — Implement per-design sales tracking
- The `contributor_design` table needed a `sales_count` column (migration 008) — the data-model.md doesn't specify it, but the task requires "increment sales count" which implies a mutable counter
- `processOrderCompletionSales` resolves product_id via `order_line.variant_id → product_variant.product_id → contributor_design.product_id`; the `order_line` table doesn't store product_id directly
- The contributor.ts query file was pre-populated with imports for `order`, `orderLine`, `productVariant`, `sql`, `sum` from T067 — these were set up in anticipation of T068's sales tracking needs
