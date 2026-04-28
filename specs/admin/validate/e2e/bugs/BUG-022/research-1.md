# Research: BUG-022 — generate-bundle 500 due to JSON.parse on plain text

## Root cause (confirmed by code reading + DB query)

`api/src/db/queries/evidence.ts:288` calls `JSON.parse(r.textContent)` unconditionally
when textContent is non-null. Evidence records in the DB store plain strings, not JSON.

### Exact failure location

```
api/src/db/queries/evidence.ts:284-291 (inside generateEvidenceBundle)
evidence: records.map((r) => ({
  id: r.id,
  type: r.type,
  createdAt: r.createdAt.toISOString(),
  textContent: r.textContent ? JSON.parse(r.textContent) : null,  // <-- crashes
  storageKey: r.storageKey,
  metadataJson: r.metadataJson,
})),
```

### DB evidence

```sql
SELECT text_content FROM evidence_record
WHERE order_id = 'bf9bca4e-ee39-42ac-9518-5ca8386158e1' LIMIT 3;
-- Returns plain strings:
--   "Customer confirmed receipt via email on 2026-04-21"
--   "Customer accepted return policy on checkout 2026-04-15"
--   "Payment receipt: ch_test_dispute_e2e confirmed 2.00"
```

## Fix

Either:
1. Wrap in try/catch: `textContent: r.textContent ? (() => { try { return JSON.parse(r.textContent!); } catch { return r.textContent; } })() : null`
2. Store textContent as JSON strings when creating evidence records
3. Just return raw string: `textContent: r.textContent`

Option 3 is lowest risk — the bundle is for human review, raw text is fine.

## How to verify

After fix: `POST /api/admin/disputes/68fcd36b-fe99-432d-a79e-8820c6e2cd96/generate-bundle`
should return 200 with `bundle_id` field.
