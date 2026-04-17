# Phase phase10-notifications-real-t — Review #1: REVIEW-FIXES

**Date**: 2026-04-17T17:10Z
**Fixes applied**:
- `api/src/ws/manager.ts:287-290`: Authorization gap — customers could dynamically subscribe to arbitrary entity channels (e.g., `order:*`, `ticket:*`) via WebSocket `subscribe` action, receiving other users' data. Restricted dynamic subscribe to admin role only. Commit: 1fccc6f

**Deferred** (optional improvements, not bugs):
- `notification-dispatch.ts`: The `pushAdapter` is created but never called from `dispatchAlert()` — the "push" preference routes through `inAppAdapter` (WebSocket). This is consistent with the spec ("admin with push preference -> WebSocket message received") but means the push adapter is effectively unused until a real push notification provider is integrated.
- Low WebSocket manager coverage (15.31%) since integration tests are skipped without DB. Not a code bug.
