# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T024 — Configure Postgres in process-compose and deploy/nixos
- Postgres in process-compose uses `trust` auth (initdb --auth=trust) — for local dev this is fine, but the kanix role still needs an explicit password so `DATABASE_URL` with `kanix:kanix@` works for the API
- NixOS `services.postgresql.ensureUsers` with `ensureDBOwnership = true` auto-grants ownership of the matching database — no separate GRANT needed in production

## T025 — Set up Liquibase with changelog structure
- Liquibase 5 in Nix does NOT bundle the PostgreSQL JDBC driver — add `postgresql_jdbc` to `flake.nix` and set `LIQUIBASE_CLASSPATH` env var pointing to `${pkgs.postgresql_jdbc}/share/java/postgresql-jdbc.jar`
- Liquibase `includeAll` in changelog-master.xml loads changeset files in alphabetical order — prefix filenames with `001-`, `002-`, etc. to control execution order
- Liquibase reads `liquibase.properties` from the working directory by default — place it in `api/` alongside package.json so `pnpm db:migrate` works from the `api/` directory

## T026 — Core entities migration
- Liquibase XML `<sql>` with `splitStatements="true"` handles large multi-statement SQL blocks well — use `stripComments="true"` to avoid issues with `--` comment lines in SQL
- The `<=` operator in SQL partial indexes must be escaped as `&lt;=` in Liquibase XML (e.g. `WHERE available &lt;= safety_stock`)
- Table `order` is a reserved word in PostgreSQL — must be quoted as `"order"` in all DDL and index statements

## T027 — Drizzle ORM with schema introspection
- Drizzle ORM's `pg-core` exports `timestamp` not `timestamptz` — use `timestamp("col", { withTimezone: true })` for timestamptz columns
- Drizzle's `postgres.js` driver (`postgres` package) works well with `drizzle-orm/postgres-js` — create connection with `postgres(url)` then `drizzle(sql)`
- Integration tests with real DB should use `describe.skip` when `DATABASE_URL` is not set — `const describeWithDb = DATABASE_URL ? describe : describe.skip` pattern works cleanly

## T028 — Seed script with dev data
- The `kanix` role in dev doesn't have CREATEDB privilege — `db:reset` must use the OS superuser via `psql`/`dropdb`/`createdb` CLI tools (trust auth) rather than connecting as `kanix` to the maintenance DB
- Drizzle's `onConflictDoNothing()` makes seed idempotent, but `returning()` returns empty when the conflict is hit — use a fallback query to fetch the existing row's ID

## T029 — Update /ready to check Postgres connectivity
- When adding DB connectivity check to `/ready`, existing unit tests that don't provide a database connection will fail — use a fake `DatabaseConnection` with a mock `db.execute` to simulate a healthy DB in unit tests
- The `checkDatabaseConnectivity` helper from `db/queries/health.ts` is reusable in both `/ready` and `/health` endpoints — no need to duplicate the `SELECT 1` logic

## T030 — Critical path checkpoint (Phase 3)
- Shutdown hooks close the DB connection, so the integration test must set `dbConn = undefined` after SIGTERM to avoid double-close in `afterEach`
- The seed script sets product status to `"active"` — test assertions on seed data should check for `"active"` not `"draft"`

## T031 — Configure SuperTokens in process-compose and deploy/nixos
- process-compose.yml already had SuperTokens configured from project setup (setup script + Java process + HTTP health check on `/hello`) — only `deploy/nixos/supertokens.nix` needed to be created
- SuperTokens core is a Java app that reads `config.yaml` from its working directory — in NixOS, copy the generated config to `StateDirectory` and pass that path as the CLI argument to `io.supertokens.Main`
- Use `DynamicUser = true` in the systemd service for SuperTokens — it doesn't need a persistent system user, just a writable state directory for config and logs
