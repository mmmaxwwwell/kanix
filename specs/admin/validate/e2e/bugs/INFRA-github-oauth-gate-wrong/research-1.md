# Research: INFRA-github-oauth-gate-wrong

Auto-generated from executor handoff (iteration 2, spawn 3).

## Executor report

- **Symptom** `ContributorDashboardScreen` checks `githubLinked == null` as the access gate; contributors without GitHub OAuth see "GitHub account not linked" error instead of dashboard data
- **Evidence** `customer/lib/screens/contributor_dashboard_screen.dart` lines 14-16:
  ```dart
  final githubLinked = authState.value?.user?.githubLinked;
  if (githubLinked == null) {
    // shows "GitHub account not linked" + Link GitHub Account button
  ```
  Test customer t101-contributor@test.kanix has no GitHub OAuth linked; `GET /api/contributors/dashboard` returns 200 with correct data for this user.
- **Suspected root cause** Wrong field used as gate; the contributor-customer relationship is in the DB (`contributors.customer_id`), not GitHub OAuth
- **Suggested fix location** `customer/lib/screens/contributor_dashboard_screen.dart` — remove the `githubLinked` gate; instead let `contributorDashboardProvider` drive state: show dashboard on success (AsyncData), show loading on AsyncLoading, show "not a contributor" message on AsyncError with 404, show generic error on other errors
- **How a fix agent can verify** After APK rebuild: navigate to `/contributor` as t101-contributor@test.kanix (who has no GitHub OAuth) → confirm dashboard data loads instead of "GitHub account not linked" screen
