/**
 * Database reset script — drops and recreates the kanix database, runs
 * migrations via Liquibase, then seeds dev data.
 *
 * Usage: pnpm db:reset
 */

import { execSync } from "node:child_process";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kanix:kanix@localhost:5432/kanix";

function run(cmd: string) {
  execSync(cmd, { stdio: "inherit", cwd: import.meta.dirname + "/../.." });
}

async function reset() {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const host = url.hostname;
  const port = url.port || "5432";

  console.log(`Resetting database "${dbName}"…`);

  // Use psql as the OS superuser (trust auth in dev) to drop and recreate.
  // This matches the approach used in process-compose.yml.
  execSync(
    `psql -h ${host} -p ${port} -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();" 2>/dev/null || true`,
    { stdio: "inherit" },
  );
  execSync(`dropdb -h ${host} -p ${port} --if-exists ${dbName}`, { stdio: "inherit" });
  execSync(`createdb -h ${host} -p ${port} -O ${url.username} ${dbName}`, { stdio: "inherit" });
  execSync(
    `psql -h ${host} -p ${port} -d ${dbName} -c "GRANT ALL ON SCHEMA public TO ${url.username};"`,
    { stdio: "inherit" },
  );

  console.log(`  Database "${dbName}" recreated.`);

  // Run Liquibase migrations
  console.log("  Running migrations…");
  run("pnpm db:migrate");

  // Run seed
  console.log("  Running seed…");
  run("pnpm db:seed");

  console.log("Reset complete.");
}

reset().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
