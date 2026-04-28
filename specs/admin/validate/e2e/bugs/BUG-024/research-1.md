# Research: BUG-024 — GET /api/admin/disputes/:id endpoint missing

## Root cause analysis

The `GET /api/admin/disputes/:id` route was never implemented in `api/src/server.ts`.
The Flutter admin app (`admin/lib/providers/dispute_provider.dart:52`) calls
`GET /api/admin/disputes/$disputeId` and expects a `{ dispute: {...} }` JSON response.
The server only has:
- `GET /api/admin/disputes` (list)
- `POST /api/admin/disputes/:id/generate-bundle`
- `GET /api/admin/disputes/:id/readiness`
- `POST /api/admin/disputes/:id/submit-bundle`

The DB query function `findDisputeById` exists at `api/src/db/queries/evidence.ts:211`
but it returns only a subset of fields (missing `openedAt`, `dueBy`, `closedAt`,
`evidenceCount`) that the Flutter `Dispute.fromJson` model requires.

## Evidence

`admin/lib/models/dispute.dart` `fromJson` reads:
- `id`, `orderId`, `providerDisputeId`, `reason`, `status`, `amountMinor`, `currency`
  (all present in `findDisputeById` result)
- `openedAt` (required — used as `createdAt`)
- `dueBy` (optional)
- `updatedAt` (optional — falls back to `openedAt` if null)
- `evidenceCount` (used to derive `evidenceSubmitted`)

`api/src/db/queries/evidence.ts:340` `listDisputes` already returns all of these
fields (including `openedAt`, `dueBy`, `closedAt`, `evidenceCount`) via a
`leftJoin` with `evidenceRecord`.

## Recommended fix strategy

1. Add `getDisputeDetail(db, disputeId)` to `api/src/db/queries/evidence.ts` —
   mirrors `listDisputes` query structure but filters to a single ID and returns
   a single object (or null if not found).
2. Export `getDisputeDetail` from that module.
3. Import it in `api/src/server.ts` (line 201 import block).
4. Add handler after the list handler (~line 3325):
   ```typescript
   app.get("/api/admin/disputes/:id", {
     preHandler: [verifySession, requireAdmin, requireCapability(CAPABILITIES.DISPUTES_READ)],
   }, async (request, reply) => {
     const { id: disputeId } = request.params as { id: string };
     const disputeRow = await getDisputeDetail(database.db, disputeId);
     if (!disputeRow) {
       return reply.status(404).send({ error: "ERR_DISPUTE_NOT_FOUND", message: `Dispute ${disputeId} not found` });
     }
     return { dispute: disputeRow };
   });
   ```

## What NOT to do

- Do not reuse `findDisputeById` directly — it lacks `openedAt`/`dueBy`/`evidenceCount`.
- Do not inline a raw SQL query in server.ts — use the established Drizzle ORM pattern.

## Confidence

High — the gap is clear: missing route + missing full-field query function.
Both are simple to add following existing patterns in the codebase.
