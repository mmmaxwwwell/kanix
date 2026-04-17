# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T010 — api/ project initialization
- Vitest v3 exits with code 1 when no test files are found — set `passWithNoTests: true` in vitest config to allow `pnpm test` to succeed with no tests yet
- ESLint v9 flat config with `typescript-eslint` works out of the box — use `tseslint.config()` wrapper with `projectService: true` for type-aware linting

## T011 — Vitest custom reporter
- Vitest custom reporters can be specified as file paths in `vitest.config.ts` `reporters` array — use `["default", "./src/test-reporter.ts"]` to keep console output AND produce JSON
- The `Reporter` interface's `onFinished(files?)` receives the complete test tree — traverse `file.tasks` recursively to collect suite/test results (suites have nested `tasks`, tests have `result`)

## T012 — Config module
- ESLint `@typescript-eslint/no-non-null-assertion` rule is enabled — use `?? ""` fallback instead of `!` assertions even when validation guarantees presence
- Node 22 has `process.loadEnvFile()` but it modifies `process.env` directly — for layered precedence (defaults → .env → env vars) implement a custom parser

## T013 — Error hierarchy
- Straightforward module — no external dependencies needed. Prettier reformats constructor signatures with multiple params to single-line; run `pnpm format` before lint check

## T014 — Pino structured logging
- Pino v10 writes to stderr by default (good for structured logging). To capture output in tests, pass a `Writable` stream as `destination` option — pino's second constructor arg accepts `DestinationStream`
- ESLint `@typescript-eslint/no-require-imports` rule blocks `require()` in tests — use ESM `import` at module top and pass pino instances via `createLogger({ destination: stream })` instead of inline `require("pino")(opts, stream)`

## T015 — Graceful shutdown
- Module-level `shutdownInitiated` flag works for `/ready` endpoint integration but makes test isolation tricky — the flag persists across tests in the same Vitest run. Future: consider resetting via an exported `_resetForTesting()` if tests need to check `isShuttingDown() === false`
- Use `EventEmitter` as a fake `NodeJS.Process` for testing signal handlers — cast via `as unknown as NodeJS.Process` since only `.on()` and `.emit()` are needed

## T016 — Fastify server skeleton
- `createServer` registers shutdown signal handlers on `processRef` — in tests, MUST pass a fake `EventEmitter` process to avoid Vitest catching `process.exit(0)` calls as unhandled rejections during teardown
- Fastify `app.inject()` is the right way to test endpoints without opening a real port — use `PORT: 0` in test config and `app.ready()` instead of `start()`

## T017 — Security middleware (CORS, rate limiting, security headers)
- Fastify hooks execute in registration order — register CORS/rate-limit hooks before route handlers so they can short-circuit with 403/429 before the handler runs
- In-memory rate limiting with `Map<string, {count, resetTime}>` is sufficient for single-instance; use `setInterval` with `.unref()` for cleanup to avoid keeping the process alive
- Security headers must use `onSend` hook (not `onRequest`) to ensure they appear on ALL responses including error responses

## T018 — JSON schema validation plugin
- Fastify 5 accepts `ajv: { customOptions: { removeAdditional: true } }` in the constructor to strip extra fields — no need for a separate Ajv instance or `setValidatorCompiler`
- Validation errors on `FastifyError` have a `.validation` array with Ajv error objects; for "required" errors, `instancePath` is the parent and `params.missingProperty` contains the missing field name

## T019 — Global error handler
- Fastify supports only one `setErrorHandler` — the global error handler must unify validation errors, AppError subclasses, and unknown errors in a single handler. Moved `formatFieldPath` from validation.ts into error-handler.ts.
- Use `"validation" in error` check to detect Fastify validation errors (they have a `.validation` array), then `instanceof AppError` for typed errors, with unknown errors as the fallback.

## T020 — CI workflow
- `returntocorp/semgrep-action@v1` has limited control over SARIF output path — using `pip install semgrep` + CLI directly gives better control over `--sarif --output` flags
- `gitleaks/gitleaks-action@v2` doesn't support custom `args` input — install gitleaks CLI directly for SARIF output control via `--report-format sarif --report-path`
- Security scan steps should use `|| true` or `if: always()` to avoid blocking the pipeline on findings while still uploading SARIF results

## T021 — Security scanner script
- Gitleaks `detect` writes an empty JSON array `[]` (not empty file) when no secrets found — parse with `len(data) if isinstance(data, list)` to handle both cases
- All four scanners (trivy, semgrep, gitleaks, npm audit) are available from the Nix devshell — no installation needed in the script

## T022 — CLAUDE.md development section
- No UI_FLOW.md exists in the project yet — task mentions it but there's nothing to reference until a future task creates it
- CLAUDE.md is loaded into Claude Code context automatically — keep it concise to avoid context window bloat

## T023 — Smoke test: server boots and responds
- `createShutdownManager` defaults `exitFn` to `process.exit.bind(process)` (the real process, not `processRef`) — smoke tests that trigger SIGTERM shutdown must `vi.spyOn(process, "exit").mockImplementation(...)` to prevent Vitest from catching the real `process.exit(0)` call
- Use `fetch()` against the real address returned by `server.start()` for true smoke tests; `app.inject()` bypasses the network stack

## T024 — Configure Postgres in process-compose and deploy/nixos
- Postgres in process-compose uses `trust` auth (initdb --auth=trust) — for local dev this is fine, but the kanix role still needs an explicit password so `DATABASE_URL` with `kanix:kanix@` works for the API
- NixOS `services.postgresql.ensureUsers` with `ensureDBOwnership = true` auto-grants ownership of the matching database — no separate GRANT needed in production

## T025 — Set up Liquibase with changelog structure
- Liquibase 5 in Nix does NOT bundle the PostgreSQL JDBC driver — add `postgresql_jdbc` to `flake.nix` and set `LIQUIBASE_CLASSPATH` env var pointing to `${pkgs.postgresql_jdbc}/share/java/postgresql-jdbc.jar`
- Liquibase `includeAll` in changelog-master.xml loads changeset files in alphabetical order — prefix filenames with `001-`, `002-`, etc. to control execution order
- Liquibase reads `liquibase.properties` from the working directory by default — place it in `api/` alongside package.json so `pnpm db:migrate` works from the `api/` directory
