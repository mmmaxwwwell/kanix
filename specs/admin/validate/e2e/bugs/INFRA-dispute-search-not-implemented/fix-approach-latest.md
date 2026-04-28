Same fix as BUG-025. Added `ilike` search support to `listDisputes` in
`api/src/db/queries/evidence.ts` and updated the list handler in
`api/src/server.ts` to pass `search` from query params. See
BUG-025/fix-approach-latest.md for full details.
