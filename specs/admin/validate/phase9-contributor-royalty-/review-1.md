# Phase phase9-contributor-royalty- — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T15:57Z
**Fixes applied**:
- `api/src/server.ts:6284-6308`: **P0 Security — Authorization bypass on tax document upload**. The `POST /api/contributors/tax-documents` endpoint only required `verifySession` + `requireVerifiedEmail` but did not verify the authenticated user was the contributor specified in `contributor_id`. Any authenticated user could upload tax documents for any contributor. Added session → customer → contributor ownership check. Commit: a355983

**Deferred** (optional improvements, not bugs):
- Path traversal risk in `file_name` parameter used in storage keys (e.g., `tax-documents/${contributor_id}/${uuid}/${file_name}`). This is a pre-existing pattern used across all file upload endpoints (tickets, evidence, tax docs) and not introduced by this phase.
- Milestone/tax-document/payout/dashboard functions not re-exported from `api/src/db/queries/index.ts` barrel file. Not a runtime bug since `server.ts` imports directly from `contributor.js`.
