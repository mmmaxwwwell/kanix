# Research: BUG-025 — Disputes search field has no effect

## Root cause analysis

Two-layer omission:

1. `api/src/server.ts:3319` casts `request.query` as `{ status?: string }` only —
   the `search` query param sent by Flutter is silently dropped.
2. `api/src/db/queries/evidence.ts:340` `listDisputes` signature is
   `filters: { status?: string }` — no `search` parameter exists, so even if
   the server passed it through, the DB function would ignore it.

## Evidence

Flutter side (`admin/lib/providers/dispute_provider.dart:26`):
```dart
queryParameters: filters.toQueryParameters(),
// toQueryParameters() returns { 'search': searchText } when search is non-null/non-empty
```

Server side (`api/src/server.ts:3319-3323`):
```typescript
const query = request.query as { status?: string };
const disputes = await listDisputes(database.db, {
  status: query.status,
});
```
`search` is never read from `query`.

DB side (`api/src/db/queries/evidence.ts:340-391`):
Only `conditions.push(eq(dispute.status, filters.status))` — no search condition.

`dispute.providerDisputeId` is the natural field to match against (used as the
human-readable dispute identifier).

## Recommended fix strategy

1. In `api/src/db/queries/evidence.ts`:
   - Add `ilike` to imports from `"drizzle-orm"`.
   - Change `filters: { status?: string }` to `filters: { status?: string; search?: string }`.
   - Add `if (filters.search) conditions.push(ilike(dispute.providerDisputeId, \`%${filters.search}%\`))`.

2. In `api/src/server.ts:3319`:
   - Change cast to `{ status?: string; search?: string }`.
   - Pass `search: query.search` to `listDisputes`.

## What NOT to do

- Do not use `like` (case-sensitive) — `ilike` matches case-insensitively, which
  is friendlier for the search UX.
- Do not add full-text search indexing — a LIKE pattern on `providerDisputeId`
  is sufficient for the test IDs used in E2E.

## Confidence

High — the fix is mechanical: two-file change, following existing filter pattern.
