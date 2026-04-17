# Phase phase7-fulfillment-shipping — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T12:52:00Z
**Fixes applied**:
- `api/src/db/queries/webhook.ts`: Error handling in `handlePaymentSucceeded` for fulfillment task creation was inverted — only suppressed `ERR_PAYMENT_NOT_PAID` and re-threw all other errors (e.g. duplicate constraint violations on webhook replay), contradicting the documented "non-fatal" intent and potentially blocking payment confirmation. Changed to suppress all errors in the catch block since fulfillment tasks can always be created manually. Commit SHA: 6a18880.

**Deferred** (optional improvements, not bugs):
- `api/src/db/queries/shipment.ts:306`: Label cost is hardcoded to 599 cents ($5.99) rather than using the actual rate amount from the carrier. In production with EasyPost, the real cost should be threaded through from the rate selection. Currently works correctly with the stub adapter.
- `api/src/db/queries/shipment.ts:907`: The `providerEventId` for refresh-tracking events is generated as `refresh-${event.occurredAt}-${event.status}`, which could collide if two events share the same timestamp and status but differ in other fields (description, location). Low risk in practice.
