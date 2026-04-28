# Research: INFRA-missing-dispute-detail-endpoint

Auto-generated from executor handoff (iteration 3, spawn 2).

## Executor report

- **Symptom**: GET /api/admin/disputes/:id returns 404 for every dispute ID; dispute detail screen always fails
- **Evidence**: `curl http://127.0.0.1:3000/api/admin/disputes/8666f567-65b3-453d-bbdf-6e674702200d -H "authorization: Bearer $TOKEN"` → `{"message":"Route GET:/api/admin/disputes/8666f567... not found","error":"Not Found","statusCode":404}`. Confirmed: dist/server.js has routes for `/api/admin/disputes` (list), `/api/admin/disputes/:id/generate-bundle`, `/api/admin/disputes/:id/readiness`, `/api/admin/disputes/:id/submit-bundle` — but NO `GET /api/admin/disputes/:id`. Flutter app calls this at `admin/lib/providers/dispute_provider.dart:52`.
- **Suspected root cause**: The single-dispute GET endpoint was never implemented in `api/src/server.ts`. The list endpoint at line 3312 returns all disputes; there is no handler for the individual detail route.
- **Suggested fix location**: `api/src/server.ts` — add `app.get("/api/admin/disputes/:id", ...)` handler after the list handler (~line 3325). Also needs a corresponding DB query in `api/src/db/queries/` (check if `getDisputeById` or similar already exists).
- **How a fix agent can verify**: `curl -s "http://127.0.0.1:3000/api/admin/disputes/68fcd36b-fe99-432d-a79e-8820c6e2cd96" -H "authorization: Bearer $ADMIN_TOKEN"` should return 200 with dispute fields (id, providerDisputeId, status, reason, amountMinor, etc.)
