# Research: BUG-029 — GET /api/customer/me omits emailVerified field

## Root cause analysis

The `/api/customer/me` handler at `api/src/server.ts:514` calls `getCustomerByAuthSubject`
and returns the result directly. `getCustomerByAuthSubject` only reads from the `customer`
DB table (id, email, status, githubUserId) — it never calls SuperTokens to check email
verification status. The Flutter model `CustomerUser.fromJson` defaults `emailVerified` to
`false` when the key is absent, blocking all post-login navigation.

## Evidence

- `api/src/server.ts:534–542`: handler calls `getCustomerByAuthSubject(database.db, userId)`,
  returns `{ customer: cust }` with no emailVerified key.
- `api/src/auth/supertokens.ts:217`: `isEmailVerified(userId)` exists, returns `Promise<boolean>`.
- `api/src/auth/index.ts:3`: `isEmailVerified` is already exported from the auth module.
- `api/src/server.ts:10–25`: import block imports from `./auth/index.js` but does NOT include
  `isEmailVerified`.
- Executor evidence: `curl /api/customer/me` returns `{customer:{id,email,status,githubUserId}}`
  — no emailVerified. SuperTokens admin confirms email IS verified.

## Recommended fix strategy

1. Add `isEmailVerified` to the import from `./auth/index.js` in `server.ts`.
2. In the `/api/customer/me` handler, after fetching `cust`, call
   `const emailVerified = await isEmailVerified(userId)`.
3. Return `{ customer: { ...cust, emailVerified } }`.

Note: the handler already has `preHandler: [verifySession, requireVerifiedEmail]` which means
only verified users can even reach this endpoint. However the bug report and the INFRA finding
confirm that the app needs the explicit `emailVerified` field to be returned (it's possible the
middleware check was bypassed in test setup, or the Flutter app calls this to drive its own UI state).
The safe fix is always to return the actual SuperTokens state.

## What NOT to do

- Do not hardcode `emailVerified: true` — always read from SuperTokens.
- Do not modify the Flutter `fromJson` as the only fix — the API should be the truth source.

## Confidence

High — isEmailVerified function exists, is exported, just not called in this handler.
