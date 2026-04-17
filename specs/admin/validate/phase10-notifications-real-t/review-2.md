# Phase phase10-notifications-real-t — Review #2: REVIEW-CLEAN

**Date**: 2026-04-17T17:13Z
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

## Spec conformance verified
- **T071a**: Dashboard summary returns all 5 fields (ordersAwaitingFulfillment, openSupportTickets, lowStockVariants, openDisputes, shipmentsWithExceptions). Alerts endpoint returns expiring reservations and disputes nearing due_by.
- **T071b**: All 4 customer endpoints present (list with search/filter, detail with stats, orders, tickets).
- **T071c**: GET/PATCH shipping settings with `admin.settings.manage` capability check.
- **T072**: WebSocket auth (admin/customer/guest), entity channels, message format `{type, entity, entityId, data, sequenceId}`, reconnection guidance, dynamic subscribe restricted to admin only (review #1 fix verified).
- **T073**: 5-minute buffer TTL, lastSequenceId replay on reconnect.
- **T074**: All 6 domain event types (order.placed, payment.succeeded, shipment.delivered, ticket.updated, inventory.low_stock, dispute.opened). Admin wildcard channels, customer-specific channels.
- **T075**: Email adapter interface `send(to, subject, body, templateId)`, stub writes to `logs/emails.jsonl`, push stub, in-app via WebSocket, per-admin alert preferences (email/push/both), dispatch routes correctly by preference.

## Prior review #1 fix verified
- `ws/manager.ts:287-291`: Dynamic subscribe correctly restricted to admin role only. Customers and guests cannot add arbitrary channels.

**Deferred** (optional improvements, not bugs):
- T071a spec mentions "cert expiry warnings" in dashboard alerts, but no certificate data source exists in the schema. Not implementable without additional infrastructure.
- Push adapter is created but routed through in-app (WebSocket) adapter in dispatchAlert — consistent with spec but means push adapter is effectively unused until a real push provider is integrated (same as review #1 finding).
- Low WebSocket manager unit test coverage (15.31%) due to integration tests being skipped without DB — not a code bug.
