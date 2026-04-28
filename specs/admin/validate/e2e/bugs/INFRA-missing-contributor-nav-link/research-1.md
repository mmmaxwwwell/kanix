# Research: INFRA-missing-contributor-nav-link

Auto-generated from executor handoff (iteration 2, spawn 3).

## Executor report

- **Symptom** Account screen has no button/link to navigate to `/contributor`; `ContributorDashboardScreen` is registered in the router but is dead code from the UI perspective
- **Evidence** `grep -n "go('/contributor" customer/lib/screens/account_screen.dart` returns no results; account_screen.dart lines 55-65 show only Profile, Linked Accounts (GitHub OAuth), and Sign Out items
- **Suspected root cause** Nav link was never added when ContributorDashboardScreen was implemented
- **Suggested fix location** `customer/lib/screens/account_screen.dart` — add a `ListTile` with `onTap: () => context.go('/contributor')` conditional on the user being a contributor (check via `contributorDashboardProvider` — show if it returns data, hide if 404)
- **How a fix agent can verify** After APK rebuild: `adb shell am start -n <pkg>/.MainActivity` → sign in as t101-contributor@test.kanix → Account tab → confirm "Contributor Dashboard" tile is visible
