# Phase phase11-flutter-admin-app-sh — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T18:50:00Z
**Fixes applied**:
- `admin/lib/widgets/app_shell.dart` — Navigation rail `_selectedIndex` used exact path matching (`indexOf`), so detail routes like `/orders/123` would not match `/orders` and the nav rail always showed Dashboard as selected on detail pages. Fixed to use prefix matching as fallback. Commit: b07dba6
- `admin/lib/screens/products_screen.dart` — `_deleteMedia()` performed a destructive DELETE request without a confirmation dialog, unlike `_deleteVariant()` which had one. Added confirmation dialog before deletion. Commit: b07dba6

**Deferred** (optional improvements, not bugs):
- Fulfillment assignment dialog uses free-text Admin User ID input instead of a dropdown of available admins — UX improvement, not a bug
- API endpoint paths are hardcoded throughout screens rather than centralized in constants — coupling concern, not a correctness issue
- Coverage collection could not be verified due to Nix flake.nix flutter_tester permission issue (bwrap workaround allows tests but not coverage flag)
