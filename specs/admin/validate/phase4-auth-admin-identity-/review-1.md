# Phase phase4-auth-admin-identity- — Review #1: REVIEW-CLEAN

**Date**: 2026-04-17T06:50Z
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

## Spec-conformance verification

- **T031**: SuperTokens NixOS module with Postgres backend on port 3567, systemd hardening, config.yaml generation — matches spec
- **T032**: EmailPassword + EmailVerification recipes configured; signup creates customer record; `requireVerifiedEmail` middleware returns 403 for unverified users — matches spec
- **T033**: `/api/customer/link-github` endpoint exchanges OAuth code, stores github_user_id; duplicate prevention for both same-customer re-link (409) and cross-customer conflict (409) — matches spec
- **T034**: `requireCapability()` middleware checks admin role capabilities; CAPABILITIES constant includes all spec-required permissions (orders.read, orders.refund, orders.cancel, inventory.read, inventory.adjust, etc.); seed populates 4 roles (super_admin, support, fulfillment, finance) with correct capability sets — matches spec
- **T035**: `registerAdminAuditLog` onResponse hook captures actor_admin_user_id, action, entity_type, entity_id, before_json, after_json, ip_address, created_at; only fires on 2xx admin responses — matches spec
- **T036**: Email verification override calls `linkGuestOrdersByEmail(db, email, customerId)` which updates orders WHERE `email = ? AND customer_id IS NULL` — matches spec
- **T037**: `/ready` endpoint checks both database and SuperTokens connectivity via `Promise.all`; returns 503 with dependency status when either is down — matches spec

## Code review summary

**Scope**: 41 files changed, +3583/-93 lines | **Base**: 742cd25f70b2890845ee45650c3719a099cc22fd~1
**Commits**: T031-T037 (SuperTokens config, customer auth, GitHub OAuth, admin auth, audit log, guest order linking, ready endpoint)

No issues found. The changes are correct, secure, and well-structured.

**Deferred** (optional improvements, not bugs):
- The `registerAdminAuditLog` hook is registered globally on the app rather than scoped to admin routes only; the guard conditions (checking adminContext/auditContext) make this harmless but slightly wasteful for non-admin requests
- `onConflictDoNothing()` in the signup handler (supertokens.ts:70) provides no actual deduplication since customer.auth_subject lacks a unique constraint; SuperTokens' own deduplication at the auth layer prevents this from being exploitable
