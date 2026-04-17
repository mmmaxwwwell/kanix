# Phase phase12-flutter-customer-app — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T20:40:00Z
**Fixes applied**:
- `customer/lib/screens/kit_builder_screen.dart`: Kit builder "Add Kit to Cart" button only showed a snackbar without actually adding items to the cart. Converted `_BottomBar` from `StatelessWidget` to `ConsumerWidget`, added `_addKitToCart()` method that iterates selected variants and adds each as a `CartItem` via `cartProvider`. Commit: 7e42a82
- `customer/lib/providers/auth_provider.dart`: `linkGitHub()` fetched the GitHub OAuth URL from the API but discarded it (empty `if` block with comment). Changed return type to `Future<String?>` and now extracts and returns the URL from the response. Commit: 7e42a82
- `customer/lib/screens/account_screen.dart`: "Link GitHub" button called `linkGitHub()` but did nothing with the result. Now awaits the URL and opens it in an external browser via `url_launcher`. Added `url_launcher: ^6.3.1` to `pubspec.yaml`. Commit: 7e42a82
- `customer/test/contributor_dashboard_test.dart`: Updated `_MockAuthNotifier.linkGitHub()` mock return type from `Future<void>` to `Future<String?>` to match the fixed signature. Commit: 7e42a82

**Deferred** (optional improvements, not bugs):
- Support message reply (`support_screen.dart:490-492`) sends `{'body': body}` without attachment data; `_addAttachment()` creates mock filenames without a file picker. Requires `file_picker` package for proper implementation.
- Warranty claim photo upload (`warranty_screen.dart:287-290`) similarly uses mock filenames without actual file picker integration.
- WebSocket provider (`websocket_provider.dart`) has stream controller and message handling infrastructure but no actual WebSocket connection code. The UI plumbing is correct and will work once connection logic is added (likely in a later integration phase).
- Several providers use unsafe `as` casts on API response data without null coalescing (e.g., `catalog_provider.dart` lines 11-12). These will crash on unexpected API responses but are unlikely in normal operation.
