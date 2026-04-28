# Research: BUG-031 — Account screen has no navigation link to Contributor Dashboard

## Root cause analysis

`customer/lib/screens/account_screen.dart` shows Profile, Linked Accounts (GitHub), and Sign Out.
There is no `ListTile` or other widget that calls `context.go('/contributor')`.
The `/contributor` route IS registered in `customer/lib/config/router.dart` (line 58+) and
`ContributorDashboardScreen` exists, but there is no navigation entry point.

## Evidence

```dart
// account_screen.dart — no reference to /contributor exists
// router.dart line 58: GoRoute(path: '/contributor', ...)
// app_shell.dart line 65: if (location.startsWith('/contributor')) return 3;  (nav rail tab 3 exists)
```

`grep -rn "go('/contributor" customer/lib/` returns 0 results.

## Recommended fix strategy

In `account_screen.dart`:
1. Add `import 'package:go_router/go_router.dart';`
2. Add `import '../providers/contributor_provider.dart';`
3. Watch `contributorDashboardProvider` — if `AsyncData`, the user is a contributor
4. Add a `Card` with a `ListTile` (icon: `Icons.dashboard`, title: "Contributor Dashboard",
   `onTap: () => context.go('/contributor')`) visible only when contributor data loads successfully

This matches how the executor's research suggested the fix and keeps the tile hidden for non-contributors (API returns 404 → AsyncError → tile not shown).

## What NOT to do

- Don't show the tile unconditionally (would show for non-contributors).
- Don't use a hardcoded flag — use the API to determine contributor status.

## Confidence

High — the fix is a straightforward addition of a conditional ListTile backed by an existing provider.
