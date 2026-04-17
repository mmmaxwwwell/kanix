# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T056 — Implement fulfillment task system
- The fulfillment_task Drizzle schema and DB migration already existed — only the query layer, state machine logic, admin routes, and integration tests needed to be created
- The `blocked` state in the fulfillment task state machine can transition back to ANY active state (recovery) — model this in the transition map with `blocked: [...ACTIVE_STATES]`
- Auto-creation of fulfillment tasks is wired into `handlePaymentSucceeded` in webhook.ts — wrap in try/catch so fulfillment task creation failures don't block payment confirmation

## T057 — Implement EasyPost adapter
- Extending `ShippingAdapter` interface with new methods requires updating all test file stubs — export `createStubShippingAdapter()` from the adapter module so tests can import it directly instead of defining local copies
- EasyPost `Shipment.buy(shipmentId, rateId)` returns the purchased shipment with `tracking_code`, `postage_label.label_url`, and `tracker.id` — these are the three key fields needed for `BuyLabelResult`
- Stub adapter params that are unused should omit parameter names entirely (matching the existing `calculateRate()` pattern) to avoid `@typescript-eslint/no-unused-vars` lint errors

## T058 — Implement shipment system
- All shipment-related schema tables (shipment, shipment_package, shipment_line, shipment_event, shipping_label_purchase) were already defined in `fulfillment.ts` — only the query layer, state machine, routes, and tests needed to be created
- The `buyShipmentLabel` function takes the `ShippingAdapter` as a parameter (DI pattern) — this allows tests to inject the stub adapter without external API calls, consistent with the pattern used for fulfillment tasks and payment
- Shipment number generation uses `SHP-<orderNumber>-<timestamp_base36>` — sufficient for V1 since each order typically has one shipment, but could collide in high-concurrency scenarios (consider a sequence table later)

## T059 — Implement tracking webhook handler
- Adding a new required Config key (`EASYPOST_WEBHOOK_SECRET`) requires updating ALL test config objects across ~30 test files — use sed/batch replace to add the field consistently, but verify the easypost webhook test's config isn't duplicated
- EasyPost webhook events are routed by `tracking_code` (→ `shipment.trackingNumber`) rather than a separate `trackerId` column — avoids schema migration since tracking number is already stored on shipment from label purchase
- Shipment status doesn't have `out_for_delivery` but order `shipping_status` does — map EasyPost `out_for_delivery` to shipment `in_transit` while propagating the more granular `out_for_delivery` to the order level

## T059a — Implement shipment void-label API
- The `voidLabel` method and `voided` status transitions were already defined in the adapter interface and state machine from T057/T058 — only the query function, route, and tests needed to be created
- Void only calls the adapter when a label was actually purchased (status `label_purchased` or `ready`) — for `draft`/`label_pending` it just transitions to `voided` without adapter interaction
- The refund cost is calculated by summing all `shippingLabelPurchase` records for the shipment — supports future multi-label scenarios

## T059b — Implement shipment refresh-tracking API
- The `trackerId` needed for `adapter.getTracking()` is stored in `shippingLabelPurchase.rawPayloadJson` (the full `BuyLabelResult` object) — extract via `rawPayload.trackerId` rather than adding a new column
- Use deterministic provider event IDs (`refresh-${occurredAt}-${status}`) for idempotency on refresh — this prevents duplicate events when refresh is called multiple times with the same tracking data
- The refresh endpoint reuses `handleTrackingUpdate()` from the webhook handler to propagate status changes to both shipment and order — avoids duplicating the transition logic

## T059c — Implement shipment mark-shipped API
- The `transitionShipmentStatus` already sets `shippedAt` on transition to "shipped" — for a dedicated mark-shipped endpoint, a standalone `markShipmentShipped` function with explicit `ready`-only validation is cleaner than reusing the generic transition and gives better error messages

## T059d — Implement order resend-confirmation API
- Per-resource rate limiting (max 1 per 5 minutes per order) is best done with an in-memory Map keyed by orderId — simpler than database tracking and sufficient since the rate limit is non-critical (prevents spam, not a security boundary)
- The `NotificationService` follows the same DI pattern as `AdminAlertService` — in-memory queue with `getSent()` for test assertions, injectable via `CreateServerOptions`
- Resend-confirmation uses `ORDERS_MANAGE` capability (not a new capability) since it's an order management action, consistent with the transition endpoint

## T060 — Implement fulfillment → shipping status propagation
- The order `shipping_status` transition map needed `in_transit → delivered` added because the aggregate `propagateOrderDeliveredStatus` check skips `out_for_delivery` — not all carriers report this intermediate status, and multi-shipment orders may have mixed paths
- The `handleTrackingUpdate` return type was extended with `orderCompleted: boolean` — this is backwards-compatible since existing code destructures only `shipmentTransitioned` and `orderTransitioned`
- Propagation functions (`propagateOrderFulfillmentStatus`, `propagateOrderDeliveredStatus`, `tryAutoCompleteOrder`) use try/catch on `ERR_INVALID_TRANSITION` to be best-effort — if the fulfillment workflow hasn't reached a compatible state (e.g., still in `queued`), the propagation silently skips

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
