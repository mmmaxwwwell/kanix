# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T076 — Initialize Flutter admin app with Riverpod + Dio + GoRouter
- Nixpkgs Flutter ships `flutter_tester` without execute permission — the `flake.nix` shellHook creates a patched symlink farm at `.flutter-patched/` and sets `FLUTTER_ROOT`; CI/headless agents must replicate this or `flutter test` fails with a permissions error
- SuperTokens admin auth uses cookie-based sessions; for Flutter web Dio handles cookies automatically, for non-web platforms extract `st-access-token` from signin response headers and send as `Authorization: Bearer` header via an interceptor
- GoRouter `redirect` callback fires on every navigation — watch the auth state via Riverpod so the router recreates when auth changes, redirecting unauthenticated users to `/login` and authenticated users away from it

## T077 — Implement admin dashboard screen
- `FutureProvider.autoDispose` with `.overrideWith((_) => Future.value(data))` is the clean way to mock async data in widget tests — avoids Dio's pending timers which fail `flutter_test`'s invariant checks
- Flutter test default surface is 800x600; with padding and grid layout, card cells can be as small as ~200x80 — use `mainAxisSize: MainAxisSize.min` and compact text styles (`bodySmall` not `titleSmall`) to avoid RenderFlex overflow in tests

## T078 — Implement admin order management screens
- For complex screens with TabBar, DataTable, and dialogs, set `tester.view.physicalSize = Size(1920, 1080)` and `devicePixelRatio = 1.0` in widget tests to avoid RenderFlex overflow on the default 800x600 surface — always call `addTearDown(() => tester.view.resetPhysicalSize())`
- `DropdownButtonFormField` requires a `Material` ancestor — when testing screens that use it outside the app's `Scaffold` shell, wrap in `Scaffold(body: ...)` in the test
- `FutureProvider.autoDispose.family` providers can be overridden per-key in tests: `orderDetailProvider('order-1').overrideWith((_) => Future.value(order))` — useful for testing detail screens with specific IDs

## T079 — Implement admin fulfillment + shipment screens
- `FLUTTER_ROOT` must point to the patched symlink farm at `.flutter-patched/` when running `flutter test` outside the nix devshell — the shell hook sets this automatically but headless agents need `FLUTTER_ROOT="$(pwd)/.flutter-patched"`
- When writing `show` imports for files that export both a list screen and detail screen (e.g., `FulfillmentScreen, FulfillmentDetailScreen`), the router file must explicitly name both classes in the `show` clause
- `StreamProvider.autoDispose<WsMessage>` for real-time updates can be defined in the screen file itself (not just provider files) — keeps WebSocket subject filtering co-located with the UI that consumes it

## T080 — Implement admin inventory + product screens
- `DropdownButtonFormField` `value` parameter is deprecated since Flutter 3.33; use `initialValue` instead to set the initial form field value
- Private widgets like `_ProductStatusChip` should not declare `super.key` — private classes cannot be subclassed externally, so the `key` parameter triggers `unused_element_parameter` warning
- `FutureProvider.autoDispose.family` can be chained for detail+adjustments on the same screen — watch both providers and invalidate both on WebSocket updates for consistent state

## T081 — Implement admin support + dispute screens
- DataTable with 7+ columns overflows on 800x600 test surface — set `tester.view.physicalSize = Size(1920, 1080)` for all tests that render data rows (not just detail screens)
- Dart 3.x `unnecessary_underscores` lint: use `(_, _)` not `(_, __)` for unused parameters — double underscore is no longer needed for disambiguation
- `ListView.separated` in a message thread needs an `Expanded` parent to get unbounded height constraints — without it, the ListView will throw "Vertical viewport was given unbounded height"

## T082 — Implement admin settings + contributor management screens
- `DefaultTabController` with `TabBar` + `TabBarView` works well for settings screens with multiple sections — wrap in `Column` with `Expanded` around `TabBarView` to avoid unbounded height
- When replacing a placeholder screen (e.g. `CustomersScreen` → `ContributorsScreen`), update all three: the router import/route, the `AppShell` navigation label, and the `_routes` list for index mapping

## T083 — Initialize Flutter customer app with Riverpod + Dio + GoRouter
- Customer auth flow adds signup + email verification on top of admin's login-only flow — GoRouter redirect must handle three states (unauthenticated, pendingVerification, authenticated) and route to `/login`, `/verify-email`, or `/catalog` accordingly
- Customer app uses `NavigationBar` (bottom nav, mobile-first) instead of admin's `NavigationRail` — map non-tab routes (e.g. `/product`, `/checkout`, `/support`) to their parent tab index in `_selectedIndex` for correct highlight
- `AsyncNotifier` subclass overrides work well for test mocking: `authStateProvider.overrideWith(() => _MockAuthNotifier())` where the mock only overrides `build()` to return a fixed `AuthState`

## T084 — Implement catalog + product detail screens
- `FutureProvider.autoDispose` loading-state tests must avoid `Future.delayed` (leaves pending timers) — use a `Completer` that you complete at the end of the test instead
- Customer app product model differs from admin's: customer variants extract `material` from `optionValues` JSON and add `quantityOnHand`/`status` for availability checks; keep models separate between admin and customer apps
- `MaterialWarrantyInfo.forMaterial()` centralizes per-material warranty text (TPU heat deformation exclusion, TPC heat resistance rating) — keeps warranty display consistent across product detail and future warranty claim screens

## T085 — Implement kit builder screen
- Kit `individualTotalMinor` savings calculation must pick the N cheapest variants across ALL products in each class, not per-product — sort all variant prices from all products in the class together before picking the cheapest N
- The public API needed a new `GET /api/kits` endpoint since admin kit endpoints require auth — added `findActiveKitsWithDetails` query that joins kit_definition → kit_class_requirement → product_class → product_class_membership → product → variants + inventory
- When testing kit builder with `ChoiceChip` variant selectors, out-of-stock indicators are per-product (`isAvailable`) not per-variant — a product with mixed stock shows "In Stock" while individual chip `onSelected` is null for OOS variants

## T086 — Implement cart + checkout screens
- Flutter 3.41+ deprecates `RadioListTile.groupValue`/`onChanged` — use `RadioGroup<T>(groupValue:, onChanged:, child:)` as an ancestor widget wrapping a `Column` of `RadioListTile` children (parameter is `groupValue`, not `value`)
- `CartNotifier` works well as a `Notifier<List<CartItem>>` (not Async) since cart state is local — keeps tests simple with `ProviderContainer` and no need to mock Dio; the API calls happen only at checkout time via a separate `AsyncNotifier`
- When testing cart screen with items added programmatically via `ProviderScope.containerOf`, call `addItem` after `pumpWidget` + `pumpAndSettle` to ensure the container is accessible from the widget tree

## T087 — Implement order history + tracking screens
- Customer app needs its own `WebSocketNotifier` + `webSocketProvider` (mirroring admin's) since customer and admin are separate packages — can't import admin providers
- `ref.listen(orderUpdatesProvider, (_, _) {...})` inside a `ConsumerWidget.build()` is the clean way to invalidate providers on WebSocket updates without rebuilding the entire widget tree
- `ListView.separated` separator callback uses `(_, _)` not `(_, __)` in Dart 3.x — double underscore triggers `unnecessary_underscores` lint

## T088 — Implement support + warranty screens
- Customer support models need separate `MessageAttachment` and `WarrantyClaim` classes not present in admin — admin support model only has `SupportTicket` + `TicketMessage`, customer adds attachment metadata and warranty claim lifecycle
- `WarrantyClaim.isWithinWarranty` computed from `warrantyExpiresAt` keeps warranty validation display-ready without recalculating from order date + material warranty period each time
- `DraggableScrollableSheet` inside `showModalBottomSheet(useSafeArea: true)` works well for multi-step forms (warranty claim: select order → select product → describe defect → upload photos) that need more vertical space than a simple bottom sheet

## T089 — Implement contributor dashboard screen
- Contributor dashboard gate on `githubLinked` from `AuthState.user` — render a "link GitHub" prompt when null, only fetch dashboard data when linked; avoids unnecessary API calls for non-contributors
- `_MockAuthNotifier` that extends `AsyncNotifier<AuthState>` and `implements AuthNotifier` lets tests control the github-linked state without needing Dio mocks — override `build()` to return a fixed `AuthState` with the desired `githubLinked` value
