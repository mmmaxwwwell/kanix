# Research: BUG-032 — ContributorDashboardScreen gates on GitHub OAuth instead of contributor DB relationship

## Root cause analysis

`contributor_dashboard_screen.dart` lines 14-16 check `authState.value?.user?.githubLinked`.
If null (GitHub not OAuth-linked), shows "GitHub account not linked" screen.
The contributor-customer relationship is stored in `contributors.customer_id`, not GitHub OAuth.
A customer can be linked to a contributor without having GitHub OAuth connected in their session.

The `GET /api/contributors/dashboard` endpoint correctly looks up by `customer_id`
(see `server.ts` line 7558: `findContributorByCustomerId(db, cust.id)`).
It returns 200 with dashboard data when the DB link exists, regardless of GitHub OAuth.

## Evidence

```dart
// contributor_dashboard_screen.dart line 14-16:
final githubLinked = authState.value?.user?.githubLinked;
if (githubLinked == null) {
  // shows "GitHub account not linked" + Link GitHub Account button
```

```typescript
// server.ts line 7558:
const contrib = await findContributorByCustomerId(db, cust.id);
if (!contrib) return reply.status(404)...
```

Test user `t101-contributor@test.kanix` has no GitHub OAuth but IS linked via `contributors.customer_id`.

## Recommended fix strategy

Remove the `githubLinked` gate entirely from `contributor_dashboard_screen.dart`.
Let `contributorDashboardProvider` drive all states:
- `AsyncLoading` → `CircularProgressIndicator`
- `AsyncData` → `_DashboardBody`
- `AsyncError` with DioException 404 → "You are not a contributor" message
- `AsyncError` other → generic error message

Import `package:dio/dio.dart` for `DioException` type check.

## What NOT to do

- Don't replace the github gate with another pre-check — let the API be the gate.
- Don't keep the authState watch for this purpose (it can stay for other uses but not as gate).

## Confidence

High — root cause is clearly wrong field used as gate; fix is minimal.
