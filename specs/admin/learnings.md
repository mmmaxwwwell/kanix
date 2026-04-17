# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T031 — Configure SuperTokens in process-compose and deploy/nixos
- process-compose.yml already had SuperTokens configured from project setup (setup script + Java process + HTTP health check on `/hello`) — only `deploy/nixos/supertokens.nix` needed to be created
- SuperTokens core is a Java app that reads `config.yaml` from its working directory — in NixOS, copy the generated config to `StateDirectory` and pass that path as the CLI argument to `io.supertokens.Main`
- Use `DynamicUser = true` in the systemd service for SuperTokens — it doesn't need a persistent system user, just a writable state directory for config and logs

## T032 — Implement customer auth: email/password + email verification
- `supertokens-node` Fastify integration exports `plugin` (not `middleware`) from `supertokens-node/framework/fastify/index.js` — register it as a Fastify plugin, it handles `/auth/*` routes via a `preHandler` hook
- `supertokens.init()` can only be called once per process — guard with an `initialized` flag to make it idempotent for tests that create multiple server instances
- `createServer` must be `async` after adding SuperTokens middleware registration — all existing tests calling `createServer` need `await` added

## T033 — Implement GitHub OAuth: link GitHub account
- SuperTokens `ThirdParty.init()` accepts providers via `signInAndUpFeature.providers` array — pass an empty array when GitHub OAuth creds are not configured to avoid errors
- For integration testing GitHub OAuth without real GitHub API, inject a mock `GitHubUserFetcher` via `CreateServerOptions.githubUserFetcher` — the server falls back to the real fetcher when none is provided
- The `github_user_id` column uses a partial unique index (`WHERE github_user_id IS NOT NULL`) since it's nullable — Drizzle's `eq()` filter works correctly for the duplicate-link check

## T034 — Implement admin auth + capability-based permissions
- The data model's `admin_role` table doesn't include a capabilities column — add `capabilities_json` (JSONB, NOT NULL, default `[]`) via a new migration to store capability string arrays per role
- Admin auth reuses the same SuperTokens EmailPassword recipe as customer auth — differentiation happens at the API layer by checking if the `auth_subject` maps to an `admin_user` record, not via a separate SuperTokens recipe
- `createRequireAdmin(db)` returns a closure that captures the DB connection — this pattern avoids passing the DB into every route handler and works cleanly as a Fastify `preHandler`

## T035 — Implement admin_audit_log middleware
- Fastify's `onResponse` hook fires after the response is sent — use it for audit logging so it doesn't block the response. Route handlers set `request.auditContext` with action details; the hook persists them.
- The `admin_audit_log` table and Drizzle schema were already created in the core migration (002-core-entities.xml) — no additional migration was needed
- Audit log IP address extraction: use `x-forwarded-for` header first (for reverse proxy setups), fall back to `request.ip` for direct connections

## T036 — Implement guest order → account linking
- SuperTokens `EmailVerification.init()` supports `override.apis.verifyEmailPOST` — use this to hook into the email verification flow and trigger guest order linking (the override only fires on HTTP API calls, not on `verifyEmailUsingToken` called directly)
- To test email verification overrides in integration tests, create the verification token via `EmailVerification.createEmailVerificationToken()` then POST it to `/auth/user/email/verify` (the HTTP endpoint) — calling `verifyEmailUsingToken()` directly bypasses the API override

## T037 — Update /ready to check SuperTokens connectivity
- SuperTokens core exposes a `/hello` endpoint for health checks — use `fetch(connectionUri + "/hello")` with `AbortSignal.timeout(3000)` for a non-blocking connectivity check
- When adding a new dependency check to `/ready`, unit tests that mock one dependency (e.g. DB) must also mock the new one — use `vi.mock("./auth/health.js")` to stub `checkSuperTokensConnectivity` in unit tests that don't have SuperTokens running

## T039 — Implement product variant + classification API (admin)
- Variant status transitions follow a strict state machine (draft→active→inactive→archived, with archived terminal) — use a `VARIANT_STATUS_TRANSITIONS` map and validate before applying, keeping the guard logic (SKU + price required for activation) in the route handler
- `onConflictDoNothing().returning()` returns an empty array on conflict — when assigning product-to-class membership, fetch the existing row if the insert returns nothing to maintain idempotent behavior
- Keep variant and product-class queries in separate files (`variant.ts`, `product-class.ts`) rather than adding to the growing `product.ts` — each query module stays focused and the barrel export in `index.ts` unifies them

## T038 — Implement product CRUD API (admin)
- Product status state machine (`draft→active`, `active→draft`, `draft→archived`, `active→archived`; archived is terminal) is enforced in the route handler via `isValidProductTransition()` — keep the transition map in the query module alongside the data access functions
- Drizzle's `sql` template tag works well for compound WHERE conditions on composite-key tables like `collection_product` — use `sql\`col1 = ${val1} AND col2 = ${val2}\`` instead of chaining multiple `.where()` calls
- When T039 runs in parallel and commits server.ts changes, ensure your route additions (media, collections) are present — Fastify route registration order matters for param-based routes (`:id` must come after fixed paths like `/reorder`)
