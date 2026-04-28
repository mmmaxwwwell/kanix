# Research: INFRA-bug022-generate-bundle-500

Auto-generated from executor handoff (iteration 2, spawn 2).

## Executor report

- **Symptom**: POST /api/admin/disputes/:id/generate-bundle returns 500 for a dispute with complete evidence (readiness.complete=true)
- **Evidence**: `JSON.parse(r.textContent)` at `api/src/db/queries/evidence.ts:288` throws SyntaxError because evidence records store plain strings (e.g. "Customer confirmed receipt via email on 2026-04-21"), not JSON strings. DB query confirmed: `SELECT text_content FROM evidence_record WHERE order_id = 'bf9bca4e-...'` returns plain strings.
- **Suspected root cause**: generateEvidenceBundle assumes textContent is JSON-encoded, but createEvidenceRecord stores raw strings.
- **Suggested fix location**: `api/src/db/queries/evidence.ts:288` — change `JSON.parse(r.textContent)` to just `r.textContent` (or add try/catch)
- **How a fix agent can verify**: `curl -s -X POST http://127.0.0.1:3000/api/admin/disputes/68fcd36b-fe99-432d-a79e-8820c6e2cd96/generate-bundle -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{}'` should return 200 with `bundle_id` field.
