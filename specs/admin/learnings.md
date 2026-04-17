# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T072 — Implement WebSocket server with auth
- `@fastify/websocket` v11 handler signature is `(socket: WebSocket, request: FastifyRequest)` — no `SocketStream` wrapper; `WebSocket` type comes from `ws` package (needs `@types/ws` as devDependency)
- `Session.getSessionWithoutRequestResponse(token)` validates an access token without HTTP request/reply — useful for WebSocket upgrade auth where there's no standard Fastify request lifecycle
- `ws` must be added as a direct dependency (not just transitive via `@fastify/websocket`) for test files that import it as a WebSocket client — pnpm strict hoisting prevents resolving transitive deps

## T073 — Implement server-side message buffering
- A global buffer (array of all published messages with timestamps) is simpler and more correct than per-subject buffers — on replay, filter by the reconnecting client's channels and `sequenceId > lastSequenceId`
- The `lastSequenceId` query parameter on the `/ws` endpoint enables reconnect replay — parsed after auth/welcome so the welcome message always arrives first, then replayed messages follow
- `setInterval(...).unref()` prevents the cleanup timer from keeping the Node process alive during tests or graceful shutdown

## T074 — Implement pub/sub for domain events
- `wsManager` and `domainEvents` are declared after route definitions in `createServer()` but captured by route closures — JavaScript closures reference bindings not values, so the variables are available when handlers execute (after server.listen())
- Customer event routing requires publishing to both `entity:entityId` (for admin wildcard) and `customer:customerId` (for customer channel) — the `DomainEventPublisher` wraps this dual-publish pattern
- For ticket events, `findTicketById` is called after the mutation to get the `customerId` for customer routing — this is an extra DB query but tickets already have the customerId FK on the support_ticket table

## T075 — Implement notification service + email stub
- The `admin_setting` table's generic key-value pattern could store per-admin prefs, but a dedicated `admin_alert_preference` table with FK to `admin_user` + unique constraint is cleaner for per-admin config with a known schema
- `NotificationDispatchService` is created after `wsManager` (which requires async `registerWebSocket`) since the in-app adapter depends on it — same closure pattern as `domainEvents`
- `getAllAdminAlertTargets` uses LEFT JOIN from `admin_user` to `admin_alert_preference` so admins without a preference row default to `"both"` — no seeding needed for existing admins

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
