Two-file fix: (1) Added `ilike` to the drizzle-orm imports in
`api/src/db/queries/evidence.ts` and extended `listDisputes` to accept
`search?: string` in its filters object — when present, adds an
`ilike(dispute.providerDisputeId, '%search%')` condition to the WHERE clause.
(2) In `api/src/server.ts` updated the `GET /api/admin/disputes` handler to
cast `request.query` as `{ status?: string; search?: string }` and pass
`search: query.search` through to `listDisputes`. The Flutter app already sends
the `search` query parameter; the fix makes the API honour it.
