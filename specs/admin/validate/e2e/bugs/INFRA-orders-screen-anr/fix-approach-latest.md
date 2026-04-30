Added server-side pagination to the admin orders endpoint to prevent loading all orders into memory at once.

- `api/src/db/queries/order.ts`: `listAllOrders` now accepts `{ limit, offset }` options (default limit=100, offset=0) and runs a parallel `COUNT(*)` query; returns `{ orders, total }`.
- `api/src/server.ts`: The `GET /api/admin/orders` route parses `limit` (capped at 500, default 100) and `offset` query params, passes them to `listAllOrders`, and returns `{ orders, total, limit, offset }`.
- `admin/lib/providers/order_provider.dart`: `orderListProvider` now sends `limit=100&offset=0` so the first request never fetches more than 100 orders, preventing Dart heap exhaustion on large datasets (2626+ orders).

Root cause: the original implementation did `SELECT * FROM order ORDER BY createdAt DESC` with no LIMIT, returning all 2626 rows in a single response. The Flutter Dart VM exhausted heap space trying to deserialize and render them all simultaneously, causing the ANR.
