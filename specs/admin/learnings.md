# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

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
- `flutter_stripe` exports `Address` and `Card` types that conflict with Flutter's `Card` widget and the app's own `Address` model — use `show CardField` on the import to avoid ambiguous_import errors
- `Stripe.publishableKey` must be set before any Stripe widget renders — initialize in `main.dart` via `String.fromEnvironment('STRIPE_PUBLISHABLE_KEY')` and optionally fetch from API at runtime via a `FutureProvider`
- Stripe `CardField` widget is a platform view; it won't render in `flutter test` but won't crash either as long as the widget isn't mounted — existing tests that don't navigate to the payment section work fine without mocking Stripe

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

## T090 — Implement SSG product catalog pages
- Astro SSG product pages must gracefully handle missing API (`PUBLIC_API_URL` not set) — `fetchProducts()` returns `[]` so the build succeeds with an empty catalog and a "Coming Soon" placeholder
- Product-to-module STL viewer matching uses slug substring matching (`product.slug.includes(mod.slug)`) since product slugs may contain the module slug plus a material suffix (e.g. `waste-bag-dispenser-tpu`)
- OpenGraph meta tags added to `Base.astro` via optional props (`ogImage`, `ogType`, `canonicalUrl`) — all existing pages get default OG tags without changes since the new props have sensible defaults

## T091 — Implement guest checkout as Astro islands
- Astro checkout uses vanilla JS `<script>` tags (not React/Vue islands) since the project has no framework integration — Astro bundles these into separate JS files in `_astro/`, so integration tests checking for inline JS strings must also grep the bundled files
- The API's `POST /api/checkout` combines shipping calc + tax calc + Stripe PaymentIntent creation in one call, returning `client_secret` — the checkout flow is: address form → checkout API → show totals → Stripe `confirmPayment()` → redirect to confirmation
- Stripe.js loaded from CDN (`js.stripe.com/v3/`) with the Payment Element (not Card Element) for PCI compliance — uses `appearance: { theme: "night" }` to match the dark Kanix theme

## T092 — Implement kit builder page
- Kit builder uses the public `GET /api/kits` endpoint (from T085's `findActiveKitsWithDetails`) which returns kit definitions with nested requirements, product classes, products, and variant-level inventory — no auth required
- Kit variant selection UI uses `data-class-id` attributes on buttons to scope selections per class, with CSS class toggling for selected state (`border-amber-500 bg-amber-500/10`) — savings calculated client-side as `sum(individual prices) - kit price`
- The `POST /api/cart/kits` endpoint expects `{ kit_definition_id, selections: [{ product_class_id, variant_id }] }` and returns `{ kit, cart }` — the cart library's `addKitToCart` auto-creates a cart if no token exists (same pattern as `addToCart`)

## T093 — Add contributions model page
- Astro content pages (contributions, warranty, etc.) are pure static pages — no API data fetching needed, just use the Base layout with matching nav/footer patterns from index.astro
- Royalty spec details are spread across FR-069 through FR-076 — the key numbers are: 10% royalty at 25-unit threshold (retroactive), 20% for 501(c)(3) donation option, 50-unit starter kit milestone
