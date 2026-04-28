# Research: INFRA-dispute-search-not-implemented

Auto-generated from executor handoff (iteration 3, spawn 2).

## Executor report

- **Symptom**: Search field on DisputesScreen sends `?search=<query>` to API but results are never filtered
- **Evidence**: `api/src/server.ts:3319` casts request.query only for `{ status?: string }` and ignores `search`. 934 disputes returned regardless of search text. Flutter sends `search` param (dispute_provider.dart:26) but API silently drops it.
- **Suspected root cause**: The disputes list handler was never updated to support `search` after the `status` filter was added. The `listDisputes()` DB function also lacks a search parameter.
- **Suggested fix location**: `api/src/server.ts` ~line 3319 (add search to query destructuring) + `api/src/db/queries/` (add LIKE filter on `provider_dispute_id` in listDisputes query)
- **How a fix agent can verify**: `curl "http://127.0.0.1:3000/api/admin/disputes?search=dp_e2e_1777331186" -H "authorization: Bearer $ADMIN_TOKEN"` should return only the matching dispute (not 934 results)
