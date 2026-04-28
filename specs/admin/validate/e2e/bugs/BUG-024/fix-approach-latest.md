Added `getDisputeDetail` function to `api/src/db/queries/evidence.ts` (mirrors
`listDisputes` query structure but filters by a single dispute ID, returning the
full set of fields the Flutter `Dispute.fromJson` model requires: `id`, `orderId`,
`providerDisputeId`, `status`, `amountMinor`, `currency`, `reason`, `openedAt`,
`dueBy`, `closedAt`, `evidenceCount`). Then added `GET /api/admin/disputes/:id`
handler in `api/src/server.ts` after the list handler (~line 3325), using the same
`verifySession + requireAdmin + requireCapability(DISPUTES_READ)` preHandler chain
as the list endpoint, returning `{ dispute: disputeRow }` on success and a 404
`ERR_DISPUTE_NOT_FOUND` when the ID doesn't match any row.
